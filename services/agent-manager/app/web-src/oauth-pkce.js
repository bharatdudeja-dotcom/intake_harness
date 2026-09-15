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
 * OAuth 2.1 Authorization Code + PKCE helpers for the dashboard's per-user IMS login (D65).
 *
 * Provider-neutral: everything is driven by the OIDC discovery document (authorize/token
 * endpoints) and the public SPA client id + issuer that the dashboard-api GET info exposes -
 * so the same code logs in against Adobe IMS, Auth0, Entra, etc. No client secret ever exists
 * in the browser (public SPA client, PKCE S256).
 *
 * The pure, deterministic pieces (base64url, authorize-URL building, callback parsing, token
 * body building, expiry math) are exported for unit tests. The crypto (random verifier + S256
 * challenge) uses the Web Crypto API and runs only in the browser.
 */

/** base64url-encode a Uint8Array or ArrayBuffer (RFC 4648 §5, no padding). */
function base64UrlEncode (bytes) {
    const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes
    let str = ''
    for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i])
    const b64 = (typeof btoa === 'function') ? btoa(str) : Buffer.from(str, 'binary').toString('base64')
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Build the IdP authorize URL for an Authorization Code + PKCE (S256) request. */
function buildAuthorizeUrl (authorizationEndpoint, { clientId, redirectUri, scope, state, codeChallenge }) {
    const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scope || 'openid',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
    })
    return `${authorizationEndpoint}?${q.toString()}`
}

/**
 * Parse an OAuth redirect callback's query string.
 * @param {string} search e.g. location.search ("?code=...&state=...") or an error callback
 * @returns {{code?: string, state?: string, error?: string, errorDescription?: string}}
 */
function parseCallbackParams (search) {
    const p = new URLSearchParams(String(search || '').replace(/^\?/, ''))
    const out = {}
    if (p.get('code')) out.code = p.get('code')
    if (p.get('state')) out.state = p.get('state')
    if (p.get('error')) out.error = p.get('error')
    if (p.get('error_description')) out.errorDescription = p.get('error_description')
    return out
}

/** Build the token-exchange request body (public client - no secret). */
function buildTokenRequestBody ({ clientId, code, redirectUri, codeVerifier }) {
    return new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier
    }).toString()
}

/**
 * Compute the absolute expiry epoch (ms) from a token response's expires_in (seconds),
 * minus a safety skew so we refresh/re-login slightly early.
 * @param {number} expiresInSeconds
 * @param {number} nowMs current time (ms)
 * @param {number} [skewMs] safety margin (default 60s)
 * @returns {number} expiry epoch in ms
 */
function computeExpiresAt (expiresInSeconds, nowMs, skewMs = 60000) {
    const secs = Number(expiresInSeconds)
    if (!Number.isFinite(secs) || secs <= 0) return nowMs // treat as already-stale
    return nowMs + (secs * 1000) - skewMs
}

/** @returns {boolean} true if a stored token is missing or past its (skew-adjusted) expiry. */
function isExpired (expiresAt, nowMs) {
    return !expiresAt || nowMs >= expiresAt
}

// ---- browser-only crypto (not exercised by the pure unit tests) ----

/** @returns {string} a high-entropy PKCE code_verifier (RFC 7636 §4.1). */
function randomCodeVerifier () {
    const bytes = new Uint8Array(64)
    crypto.getRandomValues(bytes)
    return base64UrlEncode(bytes)
}

/** @returns {string} a random opaque `state` value for CSRF protection. */
function randomState () {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    return base64UrlEncode(bytes)
}

/** @param {string} verifier @returns {Promise<string>} the S256 code_challenge. */
async function codeChallengeS256 (verifier) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    return base64UrlEncode(digest)
}

const api = {
    base64UrlEncode,
    buildAuthorizeUrl,
    parseCallbackParams,
    buildTokenRequestBody,
    computeExpiresAt,
    isExpired,
    randomCodeVerifier,
    randomState,
    codeChallengeS256
}

if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof window !== 'undefined') window.OAuthPKCE = api
