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
 * Login bridge (D68): makes this connector present as a full OAuth authorization server to
 * `mcp-remote`, so a keyless MCP client config completes browser sign-in with NO manual
 * URL/port editing, while the real authentication happens against the configured provider
 * (Adobe IMS today; any provider is a config swap, D21/D66) via the EXISTING, unchanged
 * lib/auth/oidc.js validation path. See lib/auth/oauthBridge.js for the full design rationale
 * and knowledge/AUTH-PROVIDER-SPIKE.md §6 for why this is necessary at all.
 *
 * Routes (path suffix after the action name, via `params.__ow_path` - confirmed live to work
 * on Adobe I/O Runtime raw-http web actions):
 *   GET  /.well-known/openid-configuration  - this bridge's own AS metadata
 *   POST /register                          - trivial DCR responder (informational only)
 *   GET  /authorize                         - begins a transaction, 302s to the real provider
 *   GET  /callback                          - the provider's redirect target (HTTPS, registered
 *                                              with Adobe); completes the provider leg, 302s to
 *                                              mcp-remote's ORIGINAL localhost redirect_uri
 *   POST /token                             - redeems the one-time code mcp-remote receives
 */

const { Core } = require('@adobe/aio-sdk')
const { loadAuthConfig } = require('../../lib/auth/config')
const { resolveOAuthBridgeUrl } = require('../../lib/auth/urls')
const { getDiscoveryDocument, validateBearerToken } = require('../../lib/auth/oidc')
const bridge = require('../../lib/auth/oauthBridge')

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept'
}

/** @param {Record<string, any>} params @returns {Record<string,string>} lowercase-keyed headers */
function normalizeHeaders (params) {
    const out = {}
    for (const key in (params.__ow_headers || {})) out[key.toLowerCase()] = params.__ow_headers[key]
    return out
}

/** @param {Record<string, any>} params @returns {URLSearchParams} the raw-http query string, parsed */
function query (params) {
    return new URLSearchParams(params.__ow_query || '')
}

/**
 * Best-effort `host:port` extraction from a redirect_uri, for diagnostic logging only (D69) -
 * never logs the full URL (it may carry a code/state) or anything secret.
 * @param {string} uri
 * @returns {string}
 */
function hostPortOf (uri) {
    try { const u = new URL(uri); return `${u.hostname}:${u.port || '(default)'}` } catch (e) { return '(unparseable)' }
}

/**
 * Content-sniffing parse of one candidate body string: JSON if it looks like JSON, else
 * form-urlencoded (only if it actually yields at least one key) - never throws.
 * @param {string} raw
 * @returns {Record<string, string>|null} the parsed object, or null if this candidate doesn't parse
 */
function tryParseBody (raw) {
    if (raw == null) return null
    const trimmed = String(raw).trim()
    if (trimmed.startsWith('{')) {
        try { return JSON.parse(trimmed) } catch (e) { return null }
    }
    const out = {}
    for (const [k, v] of new URLSearchParams(trimmed)) out[k] = v
    return Object.keys(out).length ? out : null
}

/**
 * Parse a raw-http POST body: this action only ever receives JSON (DCR) or form-urlencoded
 * (the standard OAuth token-request content type), matching what mcp-remote actually sends.
 * `Buffer.from(str, 'base64')` never throws on non-base64 input (it decodes leniently, garbling
 * plain text) - so the base64 candidate is only trusted if it ACTUALLY parses; the raw string is
 * always tried too, and whichever one parses wins. Adobe I/O Runtime base64-encodes raw-http
 * bodies in practice, but this doesn't assume that.
 * @param {Record<string, any>} params
 * @returns {Record<string, string>}
 */
function parseBody (params) {
    if (!params.__ow_body) return {}
    const raw = params.__ow_body
    if (typeof raw !== 'string') return raw
    // Try the RAW string first: both expected content types here (JSON, form-urlencoded) are
    // plain text, and base64-decoding plain text with Buffer's lenient decoder can itself
    // produce garbage that accidentally "parses" as a bogus form object (the very trap this
    // function exists to avoid) - so only fall back to a base64 decode if the raw string itself
    // doesn't parse as either expected shape.
    let decoded = null
    try { decoded = Buffer.from(raw, 'base64').toString('utf8') } catch (e) { /* leave null */ }
    return tryParseBody(raw) || tryParseBody(decoded) || {}
}

function json (statusCode, body) {
    return { statusCode, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

function redirect (location) {
    return { statusCode: 302, headers: { ...CORS_HEADERS, Location: location }, body: '' }
}

/**
 * This bridge's own AS metadata. mcp-remote's discovery tries the OIDC-typed candidate for a
 * path-bearing issuer (see AUTH-PROVIDER-SPIKE.md §6), so this must satisfy the FULL OpenID
 * Connect Discovery schema, not just the looser RFC 8414 OAuth AS Metadata shape - confirmed
 * live: omitting `jwks_uri`/`subject_types_supported`/`id_token_signing_alg_values_supported`
 * fails mcp-remote's zod validation outright. The bridge never issues an ID token (only a
 * passed-through provider access_token via /token), so these are schema-satisfying stand-ins,
 * not used by mcp-remote in this authorization_code + PKCE flow: `jwks_uri` points at this same
 * action's own empty key set (`/jwks`).
 * @param {string} bridgeUrl
 * @param {{scopesSupported: string[]}} config
 */
function metadataDoc (bridgeUrl, config) {
    return {
        issuer: bridgeUrl,
        authorization_endpoint: `${bridgeUrl}/authorize`,
        token_endpoint: `${bridgeUrl}/token`,
        registration_endpoint: `${bridgeUrl}/register`,
        jwks_uri: `${bridgeUrl}/jwks`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: config.scopesSupported && config.scopesSupported.length ? config.scopesSupported : ['openid']
    }
}

/**
 * @param {Record<string, any>} params
 * @returns {Promise<{statusCode: number, headers: object, body: string}>}
 */
async function main (params) {
  /*
   * Runtime passes configuration as PARAMETERS; this code reads process.env.
   * Bridge them before anything else runs - lib/storage, lib/auth and the MCP
   * gateway all read the environment at first use, and on this host that was
   * empty. See lib/params-env.js.
   */
  require('../../lib/params-env').applyParams(params)
    const logger = Core.Logger('tap-mcp-connector-oauth-bridge', { level: params.LOG_LEVEL || 'info' })
    const method = (params.__ow_method || 'get').toLowerCase()

    if (method === 'options') return { statusCode: 200, headers: CORS_HEADERS, body: '' }

    const path = params.__ow_path || ''
    const config = loadAuthConfig(params)
    const headers = normalizeHeaders(params)
    const request = { host: headers.host || '', packageName: config.packageName || params.MCP_PACKAGE_NAME || '' }
    const bridgeUrl = resolveOAuthBridgeUrl(request, config)

    try {
        if (method === 'get' && path === '/.well-known/openid-configuration') {
            return json(200, metadataDoc(bridgeUrl, config))
        }

        if (method === 'get' && path === '/jwks') {
            // Never signs anything (no ID tokens issued) - an empty key set is correct, not a stub.
            return json(200, { keys: [] })
        }

        if (method === 'post' && path === '/register') {
            return json(201, bridge.registerClient(parseBody(params)))
        }

        if (method === 'get' && path === '/authorize') {
            const q = query(params)
            const mcpRedirectUri = q.get('redirect_uri')
            const mcpState = q.get('state') || ''
            const mcpCodeChallenge = q.get('code_challenge')
            const mcpCodeChallengeMethod = q.get('code_challenge_method') || 'S256'
            logger.info('[D69][authorize] request received', {
                mcpRedirectHostPort: hostPortOf(mcpRedirectUri || ''), hasState: !!mcpState, hasCodeChallenge: !!mcpCodeChallenge,
                codeChallengeMethod: mcpCodeChallengeMethod, clientId: q.get('client_id') || null
            })
            if (!mcpRedirectUri || !mcpCodeChallenge) {
                logger.warn('[D69][authorize] rejected: missing redirect_uri or code_challenge')
                return json(400, { error: 'invalid_request', error_description: 'redirect_uri and code_challenge are required' })
            }
            if (!config.issuer) {
                logger.error('[D69][authorize] no upstream provider configured (OIDC_ISSUER unset)')
                return json(500, { error: 'server_error', error_description: 'No upstream OIDC provider configured on this server' })
            }
            const discovery = await getDiscoveryDocument(config.discoveryUrl, logger)
            const authorizationEndpoint = discovery && discovery.authorization_endpoint
            if (!authorizationEndpoint) {
                logger.error('[D69][authorize] upstream discovery missing authorization_endpoint', { discoveryUrl: config.discoveryUrl, gotDiscovery: !!discovery })
                return json(500, { error: 'server_error', error_description: 'Upstream provider does not expose an authorization_endpoint' })
            }

            const { txnId, upstreamChallenge } = await bridge.beginTransaction({
                redirectUri: mcpRedirectUri, state: mcpState, codeChallenge: mcpCodeChallenge, codeChallengeMethod: mcpCodeChallengeMethod
            })

            // Hardening (D71): the IMS redirect_uri is ALWAYS this connector's own deployed HTTPS
            // callback - built from bridgeUrl (a configured public base URL, MCP_OAUTH_BRIDGE_URL),
            // never from the caller's redirect_uri (mcpRedirectUri), regardless of its scheme/host/
            // port. mcpRedirectUri is stored in the transaction ONLY for the final relay below - it
            // must never appear in the upstream authorize/token requests to IMS.
            const upstreamRedirectUri = `${bridgeUrl}/callback`
            const upstreamUrl = new URL(authorizationEndpoint)
            upstreamUrl.searchParams.set('client_id', config.clientId)
            upstreamUrl.searchParams.set('redirect_uri', upstreamRedirectUri)
            upstreamUrl.searchParams.set('response_type', 'code')
            upstreamUrl.searchParams.set('scope', (config.scopesSupported || []).join(' ') || 'openid')
            upstreamUrl.searchParams.set('state', txnId)
            upstreamUrl.searchParams.set('code_challenge', upstreamChallenge)
            upstreamUrl.searchParams.set('code_challenge_method', 'S256')
            // D74 mitigation attempt: force a fresh sign-in every time (standard OIDC `prompt`
            // param, not IMS-documented but low-risk/no-op if ignored) - directly counters the
            // leading hypothesis from D69/D70 that the browser was silently resuming/replaying a
            // STALE, already-authorized session from an earlier attempt (whose redirect_uri was
            // baked into that old flow) instead of processing THIS request's parameters fresh.
            upstreamUrl.searchParams.set('prompt', 'login')
            // Logged so a live incident can confirm byte-for-byte this is EXACTLY what /callback
            // sends to the token endpoint below (D69) - a mismatch is IMS's #1 invalid_grant cause.
            logger.info('[D69][authorize] redirecting browser to upstream provider', {
                txnId, provider: config.provider, upstreamAuthorizeEndpoint: authorizationEndpoint,
                upstreamRedirectUri, mcpRedirectHostPort: hostPortOf(mcpRedirectUri), bridgeUrl
            })
            // [D70] The exact, full redirect_uri emitted to the upstream authorize call - compare
            // byte-for-byte against the "[D70][token]" line below (same txnId) to rule out a
            // mismatch between the authorize leg and the token-exchange leg. Not a secret (a URL).
            logger.info('[D70][authorize] emitted redirect_uri', { txnId, redirect_uri: upstreamRedirectUri })
            // [D71] The received caller redirect_uri and the emitted IMS redirect_uri, on ONE line,
            // so a live run shows both at a glance - proves the caller's value (any scheme/host/
            // port) never leaks into what IMS receives. Full URLs logged (not a secret).
            logger.info('[D71][authorize] received-vs-emitted redirect_uri', {
                txnId, receivedCallerRedirectUri: mcpRedirectUri, emittedImsRedirectUri: upstreamRedirectUri,
                match: mcpRedirectUri === upstreamRedirectUri // MUST always be false - they are different legs by design
            })
            return redirect(upstreamUrl.toString())
        }

        if (method === 'get' && path === '/callback') {
            const q = query(params)
            const upstreamCode = q.get('code')
            const txnId = q.get('state')
            const upstreamError = q.get('error')
            logger.info('[D69][callback] received from upstream provider', { txnId: txnId || null, hasCode: !!upstreamCode, hasError: !!upstreamError })
            if (upstreamError) {
                logger.warn('[D69][callback] upstream returned an error - browser will show it, mcp-remote never gets a code', { error: upstreamError, description: q.get('error_description') || null })
                return json(400, { error: upstreamError, error_description: q.get('error_description') || 'The upstream provider returned an error' })
            }
            if (!upstreamCode || !txnId) {
                logger.warn('[D69][callback] rejected: missing code or state')
                return json(400, { error: 'invalid_request', error_description: 'Missing code or state from the upstream provider callback' })
            }
            const txn = await bridge.consumeTransaction(txnId)
            if (!txn) {
                logger.warn('[D69][callback] unknown/expired/already-used transaction', { txnId })
                return json(400, { error: 'invalid_request', error_description: 'Unknown, expired, or already-used sign-in attempt. Please retry.' })
            }
            logger.info('[D69][callback] transaction found', { txnId, mcpRedirectHostPort: hostPortOf(txn.mcp.redirectUri) })

            const discovery = await getDiscoveryDocument(config.discoveryUrl, logger)
            const tokenEndpoint = discovery && discovery.token_endpoint
            if (!tokenEndpoint) {
                logger.error('[D69][callback] upstream discovery missing token_endpoint')
                return json(500, { error: 'server_error', error_description: 'Upstream provider does not expose a token_endpoint' })
            }

            // MUST be byte-identical to the redirect_uri sent at /authorize above, or the
            // provider returns invalid_grant (D69's #1 suspected cause) - both are built from the
            // same `bridgeUrl` + '/callback' literal, logged here for direct comparison.
            const callbackRedirectUri = `${bridgeUrl}/callback`
            logger.info('[D69][callback] exchanging code with upstream token endpoint', { tokenEndpoint, redirectUriUsed: callbackRedirectUri, hasUpstreamVerifier: !!txn.upstreamVerifier })
            // [D70] The exact, full redirect_uri sent to the upstream TOKEN endpoint - compare
            // byte-for-byte against the "[D70][authorize]" line above (same txnId). IMS returns
            // invalid_grant if these two ever differ. Not a secret (a URL).
            logger.info('[D70][token] emitted redirect_uri', { txnId, redirect_uri: callbackRedirectUri })

            // D77: support a CONFIDENTIAL provider credential as well as a public/PKCE one. The
            // bridge does this exchange server-side, so it is architecturally a confidential
            // client (D76 defect 2) - a confidential credential REQUIRES client authentication
            // here and returns invalid_client without it. A public/PKCE credential (no secret
            // configured) keeps working exactly as before, authenticating with client_id +
            // code_verifier. The secret comes from server-side config only; it is never logged
            // and never sent to any client (see the secret-leak test).
            //
            // WHICH auth style - SETTLED EMPIRICALLY (D78). D77 flagged a real contradiction
            // between two of Adobe's own docs: the current IMS reference documents an
            // `Authorization: Basic base64(id:secret)` HEADER, the older adobeio-auth doc says
            // Basic is unsupported and to use a `client_secret` FORM PARAM. A live sign-in
            // settled it - with the Basic header IMS answered:
            //     {"error":"invalid_grant","error_description":"missing client_secret parameter"}
            // So the OLDER doc is correct for IMS: it wants the form param. Form style is now the
            // PRIMARY attempt. The Basic-header fallback is retained for a different provider that
            // requires it (this is a provider-neutral seam, D21) - retried only when the provider
            // rejects the client credentials themselves, never on a plain grant failure, since an
            // authorization code is single-use. RFC 6749 §2.3 forbids sending both styles at once,
            // hence sequential attempts. NOTE the retry trigger is deliberately broad: IMS reports
            // this condition as `invalid_grant` (not the RFC-conventional `invalid_client`), so a
            // narrow `invalid_client`-only check silently failed to retry (the D78 bug).
            const baseTokenParams = {
                grant_type: 'authorization_code',
                client_id: config.clientId,
                code: upstreamCode,
                redirect_uri: callbackRedirectUri,
                code_verifier: txn.upstreamVerifier
            }
            const confidential = !!config.clientSecret
            logger.info('[D77][token] client authentication mode', { txnId, confidentialClient: confidential, sendsPkceVerifier: !!txn.upstreamVerifier })

            /**
             * One token-exchange attempt.
             * @param {'basic'|'form'|'none'} authStyle
             * @returns {Promise<{res: Response, body: object}>}
             */
            const attemptTokenExchange = async (authStyle) => {
                const headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
                const params = { ...baseTokenParams }
                if (authStyle === 'basic') {
                    headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`
                } else if (authStyle === 'form') {
                    params.client_secret = config.clientSecret
                }
                const res = await fetch(tokenEndpoint, { method: 'POST', headers, body: new URLSearchParams(params).toString() })
                const body = await res.json().catch(() => ({}))
                return { res, body }
            }

            /**
             * True when a failed attempt looks like the provider rejecting the client-authentication
             * STYLE (rather than the grant itself), so retrying with the other style is worthwhile.
             * Deliberately not keyed on `invalid_client` alone: IMS reports a missing/!unacceptable
             * client_secret as `invalid_grant` + "missing client_secret parameter" (D78).
             * @param {{res: Response, body: object}} attempt
             */
            const looksLikeClientAuthRejection = ({ res, body }) => {
                if (res.ok) return false
                if (body.error === 'invalid_client') return true
                return /client[_\s-]?secret|client authentication|unauthorized[_\s-]?client/i.test(
                    `${body.error || ''} ${body.error_description || ''}`
                )
            }

            let tokenRes, tokenBody
            try {
                // Form param first - empirically what IMS requires (D78).
                let attempt = await attemptTokenExchange(confidential ? 'form' : 'none')
                // One retry with the other style, only for a client-auth rejection. Never retried
                // on an ordinary grant failure: an authorization code is single-use.
                if (confidential && looksLikeClientAuthRejection(attempt)) {
                    logger.warn('[D78][token] form-param client auth rejected - retrying once with the Basic header style', { txnId, error: attempt.body.error || null, description: attempt.body.error_description || null })
                    attempt = await attemptTokenExchange('basic')
                    logger.info('[D78][token] Basic-header retry result', { txnId, status: attempt.res.status, ok: attempt.res.ok, error: attempt.body.error || null })
                }
                tokenRes = attempt.res
                tokenBody = attempt.body
            } catch (e) {
                logger.error('[D69][callback] upstream token endpoint unreachable', { message: e.message })
                return json(502, { error: 'server_error', error_description: `Upstream token exchange unreachable: ${e.message}` })
            }
            logger.info('[D69][callback] upstream token exchange result', { status: tokenRes.status, ok: tokenRes.ok, hasAccessToken: !!tokenBody.access_token, upstreamError: tokenBody.error || null })
            if (!tokenRes.ok || !tokenBody.access_token) {
                logger.warn('[D69][callback] upstream token exchange failed', { status: tokenRes.status, error: tokenBody.error, description: tokenBody.error_description })
                return json(400, { error: 'invalid_grant', error_description: tokenBody.error_description || 'Upstream token exchange failed' })
            }

            // Validate through the SAME path every real MCP request uses, so owner resolution
            // (email) is identical and a broken upstream token fails fast here, not later.
            const validated = await validateBearerToken(tokenBody.access_token, config, logger)
            logger.info('[D69][callback] connector validation of the upstream token', { ok: validated.ok, error: validated.ok ? null : validated.error })
            if (!validated.ok) {
                logger.warn('[D69][callback] upstream token failed connector validation', { error: validated.error })
                return json(400, { error: 'invalid_grant', error_description: `Signed in, but the resulting token failed validation: ${validated.error}` })
            }
            logger.info('[D69][callback] login bridge completed', { owner: validated.userInfo && (validated.userInfo.email || validated.userInfo.sub) })

            const code = await bridge.issueGrant({
                accessToken: tokenBody.access_token,
                tokenType: tokenBody.token_type || 'Bearer',
                expiresIn: tokenBody.expires_in,
                mcpCodeChallenge: txn.mcp.codeChallenge,
                mcpCodeChallengeMethod: txn.mcp.codeChallengeMethod
            })

            const relayUrl = new URL(txn.mcp.redirectUri)
            relayUrl.searchParams.set('code', code)
            if (txn.mcp.state) relayUrl.searchParams.set('state', txn.mcp.state)
            logger.info('[D69][callback] relaying to the local client callback', { relayHostPort: hostPortOf(relayUrl.toString()), hasState: !!txn.mcp.state })
            return redirect(relayUrl.toString())
        }

        if (method === 'post' && path === '/token') {
            const body = parseBody(params)
            logger.info('[D69][token] redeem request received', { grantType: body.grant_type || null, hasCode: !!body.code, hasVerifier: !!body.code_verifier })
            if (body.grant_type !== 'authorization_code') {
                logger.warn('[D69][token] unsupported grant_type', { grantType: body.grant_type || null })
                return json(400, { error: 'unsupported_grant_type' })
            }
            const result = await bridge.redeemGrant(body.code, body.code_verifier)
            logger.info('[D69][token] redeem result', { ok: result.ok, error: result.ok ? null : result.error })
            if (!result.ok) return json(400, { error: 'invalid_grant', error_description: result.error })
            const resp = { access_token: result.accessToken, token_type: result.tokenType }
            if (result.expiresIn) resp.expires_in = result.expiresIn
            return json(200, resp)
        }

        return json(404, { error: 'not_found', error_description: `No login-bridge route for ${method.toUpperCase()} ${path || '/'}` })
    } catch (error) {
        logger.error('Unhandled oauth-bridge error:', error)
        return json(500, { error: 'server_error', error_description: error.message })
    }
}

module.exports = { main }
