/*
Copyright 2026 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/

/**
 * OAuth login bridge (D68): makes THIS connector look like a full OAuth authorization server
 * to an MCP client's local proxy (e.g. a keyless `mcp-remote`-style config), so browser sign-in
 * completes with zero manual URL/port editing - while the real authentication happens against
 * the configured OIDC provider (Adobe IMS today; any provider is a config swap, D21/D66).
 *
 * WHY a bridge is needed (see knowledge/AUTH-PROVIDER-SPIKE.md §6, live-diagnosed):
 * such a local proxy opens ITS OWN localhost callback server and sends that exact
 * `http://localhost:<port>/oauth/callback` as the `redirect_uri` to whichever authorization
 * server our Protected Resource Metadata names. A provider's registered user-auth credential
 * typically only allows HTTPS redirect URIs - it will never accept a bare `http://localhost:...`
 * redirect. So the connector itself becomes the authorization server the local proxy talks to
 * (its `redirect_uri` is honored there, no restriction); the connector then does the REAL
 * provider leg server-side, using ITS OWN pre-registered HTTPS callback (which IS on the
 * provider credential's allow-list), and finally 302-relays back to the local proxy's localhost
 * callback with a connector-issued code.
 *
 * Flow:
 *   local proxy --[DCR /register]--> connector (issues a throwaway "tpc_" client id -
 *     informational only; the callback relay's real security is the server-side PKCE + the
 *     provider sign-in itself, not this client id)
 *   local proxy --[GET /authorize, its OWN localhost redirect_uri + PKCE]--> connector
 *     -> connector creates a transaction (the proxy's redirect_uri/state/code_challenge, plus a
 *        FRESH upstream PKCE pair for the provider leg), persisted via the swappable store
 *        (D21) - this MUST survive across separate serverless invocations, unlike an in-memory map
 *     -> 302 to the REAL provider's /authorize, with the connector's own HTTPS callback as
 *        redirect_uri and the transaction id as `state`
 *   the user signs in with the provider (their existing SSO)
 *   provider --[GET /callback, code + state=txnId]--> connector
 *     -> exchanges the code server-side (provider's token endpoint, connector's PKCE verifier)
 *     -> validates the resulting token via the SAME userinfo/JWKS path lib/auth/oidc.js already
 *        uses for every real request, so owner resolution is identical to the direct-token path
 *     -> mints a one-time "grant" (the resolved access token, keyed by a fresh code, bound to
 *        the local proxy's code_challenge)
 *     -> 302 to the local proxy's ORIGINAL localhost redirect_uri with that code + its original state
 *   local proxy --[POST /token, code + its code_verifier]--> connector
 *     -> connector checks S256(code_verifier) === the stored code_challenge (real PKCE
 *        enforcement of the proxy<->connector leg) and returns the real provider access token
 *        as the bearer token
 *   the local proxy sends that token as `Authorization: Bearer` on every MCP request - validated
 *   by the EXISTING, unchanged lib/auth/oidc.js path. No new token format, no new validation code.
 *
 * Persistence: delegated to lib/store.js (the one swappable storage adapter, D21) - transactions
 * and grants are short-lived, single-use records, NOT an in-memory Map, because actions are
 * stateless/serverless (a fresh instance per invocation) and the /authorize, /callback, and
 * /token legs are separate invocations, possibly seconds to minutes apart.
 */

const crypto = require('crypto')
const store = require('../store')

/** base64url-encode a Buffer (RFC 4648 §5, no padding). */
function base64url (buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** @returns {string} a high-entropy PKCE code_verifier (RFC 7636 §4.1). */
function randomVerifier () {
    return base64url(crypto.randomBytes(48))
}

/** @param {string} verifier @returns {string} the S256 code_challenge for a verifier. */
function challengeFor (verifier) {
    return base64url(crypto.createHash('sha256').update(verifier).digest())
}

/** @returns {string} a random opaque id (transaction id / one-time code / DCR client id suffix). */
function randomId (prefix) {
    return `${prefix}${crypto.randomBytes(20).toString('hex')}`
}

/**
 * Begin a login bridge transaction (the /authorize leg from the local proxy's perspective).
 * @param {{redirectUri: string, state: string, codeChallenge: string, codeChallengeMethod: string, clientId: string}} mcpRequest
 *   the values the caller sent us: ITS localhost redirect_uri/state/PKCE challenge/client id
 * @returns {Promise<{txnId: string, upstreamVerifier: string, upstreamChallenge: string}>}
 */
async function beginTransaction (mcpRequest) {
    const txnId = randomId('txn_')
    const upstreamVerifier = randomVerifier()
    const upstreamChallenge = challengeFor(upstreamVerifier)
    await store.saveOAuthTransaction(txnId, { mcp: mcpRequest, upstreamVerifier })
    return { txnId, upstreamVerifier, upstreamChallenge }
}

/**
 * Consume a transaction (the /callback leg, after the provider redirects back to us).
 * @param {string} txnId
 * @returns {Promise<object|null>} the stored transaction, or null if unknown/expired/already used
 */
async function consumeTransaction (txnId) {
    return store.takeOAuthTransaction(txnId)
}

/**
 * Issue a one-time grant for the local proxy to redeem at /token (the code handed back in the
 * https->http relay redirect).
 * @param {{accessToken: string, tokenType: string, expiresIn: number|undefined, mcpCodeChallenge: string, mcpCodeChallengeMethod: string}} data
 * @returns {Promise<string>} the one-time code
 */
async function issueGrant (data) {
    const code = randomId('tpc_code_')
    await store.saveOAuthGrant(code, data)
    return code
}

/**
 * Redeem a grant at /token: verify the local proxy's code_verifier against the challenge
 * captured at /authorize, single-use.
 * @param {string} code
 * @param {string} codeVerifier
 * @returns {Promise<{ok: true, accessToken: string, tokenType: string, expiresIn: number|undefined}|{ok: false, error: string}>}
 */
async function redeemGrant (code, codeVerifier) {
    const grant = await store.takeOAuthGrant(code)
    if (!grant) return { ok: false, error: 'Unknown, expired, or already-used authorization code' }
    if (grant.mcpCodeChallengeMethod && grant.mcpCodeChallengeMethod !== 'S256') {
        return { ok: false, error: 'Unsupported code_challenge_method (only S256 is supported)' }
    }
    const expected = grant.mcpCodeChallenge
    const actual = codeVerifier ? challengeFor(codeVerifier) : ''
    if (!expected || expected !== actual) return { ok: false, error: 'PKCE verification failed (code_verifier does not match)' }
    return { ok: true, accessToken: grant.accessToken, tokenType: grant.tokenType || 'Bearer', expiresIn: grant.expiresIn }
}

/**
 * Trivial Dynamic Client Registration (RFC 7591) responder for a local proxy's DCR attempt.
 * Informational only - it is NOT a security boundary (the real security is server-side PKCE +
 * the upstream provider sign-in); we accept any redirect_uris the caller declares and hand back
 * a public ("none" auth method) client id.
 * @param {{redirect_uris?: string[], client_name?: string, [key: string]: any}} body
 * @returns {object} an RFC 7591 client registration response
 */
function registerClient (body = {}) {
    const clientId = randomId('tpc_')
    return {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code']
    }
}

module.exports = {
    randomVerifier,
    challengeFor,
    randomId,
    beginTransaction,
    consumeTransaction,
    issueGrant,
    redeemGrant,
    registerClient
}
