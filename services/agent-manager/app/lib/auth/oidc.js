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
 * Provider-neutral OIDC Bearer token validation (D19/D21/D24).
 *
 * Two validation strategies, selected by config (not hardcoded to any provider -
 * see lib/auth/config.js for how a deployment picks one):
 *
 * - JWKS/JWT (config.audience set - providers that issue audience-bound JWTs):
 *   the access token is verified as a signed JWT against the provider's published
 *   JWKS - signature, issuer, audience, and expiry are all checked
 *   cryptographically by `jose`. This is REAL RFC 8707 audience binding: a token
 *   not issued for OIDC_AUDIENCE is rejected outright (see
 *   knowledge/OAUTH-SPIKE.md and D19's "hard gate before Increment 4"). D55 bugfix:
 *   this path used to return only `claims`, never `userInfo` - so a real per-user
 *   OAuth login on the configured JWKS provider always collapsed to the
 *   service-account owner downstream. It now builds `userInfo` from the verified
 *   claims (sub is always present on an access token; email/username if the
 *   provider includes them) so multi-user identity actually flows end to end.
 *
 * - userinfo (config.audience unset - providers without audience-bound tokens):
 *   the configured provider's userinfo endpoint must accept the token, the one
 *   validation mechanism such providers document (no introspection endpoint, no
 *   audience claim - see knowledge/OAUTH-SPIKE.md §3). Compensating controls
 *   layered on top (best-effort, NOT a replacement for real audience binding):
 *   if the token is a decodable JWT, its client_id/azp claim must match
 *   OAUTH_CLIENT_ID; if the token is opaque, accept on userinfo validity alone
 *   and log that the compensating check wasn't possible.
 *
 * Both strategies additionally enforce OAUTH_CLIENT_ID (client-binding) and
 * OIDC_REQUIRED_SCOPE as defense-in-depth once the authoritative check passes.
 */

const { jwtVerify } = require('jose')
const { getJwks } = require('./jwks')

const DISCOVERY_CACHE = new Map() // discoveryUrl -> { doc, fetchedAt }
const DISCOVERY_TTL_MS = 10 * 60 * 1000

/**
 * @param {string} discoveryUrl
 * @param {{warn?: Function}} [logger]
 * @returns {Promise<object|null>} the OIDC discovery document, or null if unavailable
 */
async function getDiscoveryDocument (discoveryUrl, logger = console) {
    if (!discoveryUrl) return null
    const cached = DISCOVERY_CACHE.get(discoveryUrl)
    if (cached && (Date.now() - cached.fetchedAt) < DISCOVERY_TTL_MS) return cached.doc

    try {
        const res = await fetch(discoveryUrl)
        if (!res.ok) {
            try { logger.warn('[auth] OIDC discovery fetch failed', { discoveryUrl, status: res.status }) } catch { /* ignore logger errors */ }
            return cached ? cached.doc : null
        }
        const doc = await res.json()
        DISCOVERY_CACHE.set(discoveryUrl, { doc, fetchedAt: Date.now() })
        return doc
    } catch (e) {
        try { logger.warn('[auth] OIDC discovery fetch error', e?.message || e) } catch { /* ignore logger errors */ }
        return cached ? cached.doc : null
    }
}

/**
 * Best-effort decode of a JWT's payload WITHOUT verifying its signature. Only
 * used for the compensating checks layered on top of the authoritative userinfo
 * check - never trusted as proof of validity on its own.
 * @param {string} token
 * @returns {object|null}
 */
function decodeJwtPayload (token) {
    const parts = String(token || '').split('.')
    if (parts.length !== 3) return null
    try {
        const payload = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
        const parsed = JSON.parse(payload)
        return (parsed && typeof parsed === 'object') ? parsed : null
    } catch (e) {
        return null
    }
}

/**
 * Scopes carried by a token's claims, tolerant of both delimiter conventions (D78).
 *
 * RFC 6749 §3.3 specifies a SPACE-delimited scope string, but some providers emit a
 * COMMA-separated list instead (observed live: `"scope":"openid,profile,email,..."`). A
 * whitespace-only split collapses such a value into ONE bogus scope containing every name
 * joined by commas, so the required-scope check then fails for every token the provider
 * issues - which is exactly the bug this splits on both to fix. Splitting on either
 * delimiter is safe: neither space nor comma is legal inside a single scope token
 * (RFC 6749 restricts scope characters and excludes both).
 *
 * @param {object|null} claims
 * @returns {string[]}
 */
function scopesFromClaims (claims) {
    if (!claims) return []
    if (typeof claims.scope === 'string') return claims.scope.split(/[\s,]+/).filter(Boolean)
    if (Array.isArray(claims.scp)) return claims.scp
    if (typeof claims.scp === 'string') return claims.scp.split(/[\s,]+/).filter(Boolean)
    if (Array.isArray(claims.permissions)) return claims.permissions
    return []
}

/**
 * Translate a jose verification error into a stable, human-readable message.
 * @param {Error} e
 * @returns {string}
 */
function describeJwtVerifyError (e) {
    const code = e && e.code
    if (code === 'ERR_JWT_EXPIRED') return 'Token expired'
    if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') return `Token claim validation failed (${e.claim || 'unknown claim'})`
    if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') return 'Invalid token signature'
    if (code === 'ERR_JWKS_NO_MATCHING_KEY') return 'Invalid token signature (no matching key)'
    if (code === 'ERR_JWS_INVALID' || code === 'ERR_JWT_INVALID') return 'Malformed token'
    return `Token validation failed: ${(e && e.message) || 'invalid token'}`
}

/**
 * Real audience-bound JWT verification (RFC 8707) via the provider's JWKS -
 * signature, issuer, audience, and expiry are all checked cryptographically.
 * Used when `config.audience` is set (any provider issuing audience-bound JWTs).
 * @param {string} token
 * @param {{issuer: string, discoveryUrl: string, audience: string, clientId: string, requiredScope: string}} config
 * @param {{info?: Function, warn?: Function}} [logger]
 * @returns {Promise<{ok: boolean, error?: string, claims?: object}>}
 */
async function validateViaJwks (token, config, logger = console) {
    const discovery = await getDiscoveryDocument(config.discoveryUrl, logger)
    const jwksUri = discovery && discovery.jwks_uri
    if (!jwksUri) {
        return { ok: false, error: 'OIDC provider does not expose a jwks_uri - cannot validate token' }
    }

    let payload
    try {
        const keyResolver = getJwks(jwksUri)
        const result = await jwtVerify(token, keyResolver, {
            issuer: config.issuer,
            audience: config.audience
        })
        payload = result.payload
    } catch (e) {
        return { ok: false, error: describeJwtVerifyError(e) }
    }

    if (config.clientId) {
        // The OIDC standard claim for the client that requested the token is `azp`
        // (authorized party); `aud` here is the verified API audience, not a client id.
        const tokenClientId = payload.azp || payload.client_id
        if (tokenClientId && tokenClientId !== config.clientId) {
            return { ok: false, error: 'Token was not issued for this connector (client mismatch)' }
        }
    }

    if (config.requiredScope) {
        const scopes = scopesFromClaims(payload)
        if (!scopes.includes(config.requiredScope)) {
            return { ok: false, error: `Token missing required scope '${config.requiredScope}'` }
        }
    }

    // sub is a mandatory claim on any OIDC/OAuth2 access token; email/username are
    // provider- and scope-dependent extras, included when present (D55).
    const userInfo = { sub: payload.sub, email: payload.email, username: payload.preferred_username || payload.nickname }
    return { ok: true, claims: payload, userInfo }
}

/**
 * IMS-style validation: authoritative check via the userinfo endpoint, with
 * best-effort compensating controls layered on top (see file header).
 * @param {string} token
 * @param {{issuer: string, discoveryUrl: string, clientId: string, requiredScope: string}} config
 * @param {{info?: Function, warn?: Function}} [logger]
 * @returns {Promise<{ok: boolean, error?: string, userInfo?: object, claims?: object}>}
 */
async function validateViaUserinfo (token, config, logger = console) {
    const claims = decodeJwtPayload(token)

    if (claims && typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) {
        return { ok: false, error: 'Token expired' }
    }

    const discovery = await getDiscoveryDocument(config.discoveryUrl, logger)
    const userinfoUrl = discovery && discovery.userinfo_endpoint
    if (!userinfoUrl) {
        return { ok: false, error: 'OIDC provider does not expose a userinfo endpoint - cannot validate token' }
    }

    let userInfo
    try {
        const res = await fetch(userinfoUrl, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) {
            return { ok: false, error: res.status === 401 ? 'Invalid or expired token' : `Token validation failed (${res.status})` }
        }
        userInfo = await res.json().catch(() => ({}))
    } catch (e) {
        return { ok: false, error: 'Token validation unavailable' }
    }

    if (claims && config.clientId) {
        const tokenClientId = claims.client_id || claims.azp || claims.aud
        if (tokenClientId && tokenClientId !== config.clientId) {
            return { ok: false, error: 'Token was not issued for this connector (client mismatch)' }
        }
        const scopes = scopesFromClaims(claims)
        if (scopes.length && config.requiredScope && !scopes.includes(config.requiredScope)) {
            return { ok: false, error: `Token missing required scope '${config.requiredScope}'` }
        }
    } else if (!claims) {
        try { logger.info('[auth] Bearer token is opaque - accepted on userinfo validity alone (no client/scope compensating check possible)') } catch { /* ignore logger errors */ }
    }

    return { ok: true, userInfo, claims }
}

/**
 * @param {string} token bearer token (no "Bearer " prefix)
 * @param {{issuer: string, discoveryUrl: string, audience: string, clientId: string, requiredScope: string}} config
 * @param {{info?: Function, warn?: Function}} [logger]
 * @returns {Promise<{ok: boolean, error?: string, userInfo?: object, claims?: object}>}
 */
async function validateBearerToken (token, config, logger = console) {
    if (!token) return { ok: false, error: 'Missing bearer token' }
    if (!config.issuer) return { ok: false, error: 'No OIDC provider configured on this server' }

    // The host config selects the strategy (config layer owns provider selection - D21/D66).
    // Fall back to the audience heuristic if a legacy config didn't set validationStrategy.
    const strategy = config.validationStrategy || (config.audience ? 'jwks' : 'userinfo')
    return strategy === 'userinfo'
        ? validateViaUserinfo(token, config, logger)
        : validateViaJwks(token, config, logger)
}

module.exports = { getDiscoveryDocument, decodeJwtPayload, validateBearerToken, validateViaJwks, validateViaUserinfo }
