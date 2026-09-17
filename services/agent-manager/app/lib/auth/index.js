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
 * Dual auth resolver for the MCP server (D19/D21):
 * - `Authorization: Bearer <token>` -> OIDC path (per-user identity; configured
 *   provider, not hardcoded - see lib/auth/config.js and .env.example).
 * - `x-api-key: <key>`              -> headless-agent path (unchanged since Increment 1).
 * - neither/invalid                 -> caller gets `error` + `prmUrl` so the host wrapper can
 *   respond 401 with `WWW-Authenticate: Bearer resource_metadata="<prmUrl>"`, letting
 *   any MCP client discover how to authenticate (RFC 9728).
 *
 * Host-neutral: takes a plain, already-normalized request shape
 * `{ headers, host, packageName }` (headers lowercase-keyed) plus a loaded auth
 * config - the host wrapper (actions/<action>/index.js) normalizes its
 * transport's request format and loads the config before calling in. No
 * platform-specific request shapes are referenced here.
 */

const { loadAuthConfig } = require('./config')
const { validateBearerToken } = require('./oidc')
const { resolvePrmUrl } = require('./urls')
const { resolveApiKeyOwner } = require('./apiKeys')
const usersLib = require('./users')

/** @returns {string} bearer token, or '' if the Authorization header isn't a Bearer token */
function extractBearer (headers) {
    const auth = headers.authorization
    return (auth && auth.startsWith('Bearer ')) ? auth.slice(7).trim() : ''
}

/** @returns {string} x-api-key header value, or '' */
function extractApiKey (headers) {
    return (headers['x-api-key'] && String(headers['x-api-key']).trim()) || ''
}

/**
 * A Cookbook user login (D81), sent either as two headers or as one `id:password` pair. The
 * single-header form exists because MCP client configs typically express exactly one credential
 * header, so a consultant can use the same login in their AI client and in the dashboard.
 * @param {Record<string, string>} headers
 * @returns {{id: string, password: string}|null}
 */
function extractLogin (headers) {
    const id = headers['x-cookbook-user-id']
    const password = headers['x-cookbook-password']
    if (id && password) return { id: String(id).trim(), password: String(password) }

    // Single-header form: "id:password". Split on the FIRST colon only - a password is allowed to
    // contain colons, an id is not.
    const combined = headers['x-cookbook-login']
    if (combined && String(combined).includes(':')) {
        const raw = String(combined)
        const at = raw.indexOf(':')
        const parsedId = raw.slice(0, at).trim()
        const parsedPassword = raw.slice(at + 1)
        if (parsedId && parsedPassword) return { id: parsedId, password: parsedPassword }
    }
    return null
}

/**
 * @param {{headers?: Record<string, string>, host?: string, packageName?: string}} request
 *   plain request values, normalized by the host wrapper (headers lowercase-keyed)
 * @param {ReturnType<typeof loadAuthConfig>} config loaded auth configuration
 * @param {{info?: Function, warn?: Function}} [logger]
 * @param {{loadUsers?: Function}} [deps] injectable user-list loader (D81)
 * @returns {Promise<{ok: boolean, mode?: 'oidc'|'api-key'|'user-login', userInfo?: object, error?: string, prmUrl?: string}>}
 */
async function resolveRequestAuth (request, config, logger = console, deps = {}) {
    const headers = (request && request.headers) || {}
    const prmUrl = resolvePrmUrl(request, config)

    const bearer = extractBearer(headers)
    if (bearer) {
        const result = await validateBearerToken(bearer, config, logger)
        if (result.ok) return { ok: true, mode: 'oidc', userInfo: result.userInfo }
        return { ok: false, error: result.error, prmUrl }
    }

    // D81: a Cookbook user login. Checked before the api-key path so that a client sending both
    // gets the identity of the person, not of a shared key.
    const login = extractLogin(headers)
    if (login) {
        // The user list is injectable so this module stays host-neutral and unit-testable; it
        // defaults to the same swappable store every other persisted thing goes through (D21).
        const loadUsers = (deps && deps.loadUsers) || (() => require('../store').listUsers())
        const users = await loadUsers()
        const result = usersLib.authenticate(users, login.id, login.password)
        if (!result.ok) return { ok: false, error: result.error, prmUrl }
        const user = result.user
        const userInfo = { sub: user.owner || user.id }
        if (user.email) userInfo.email = user.email
        if (user.roles && user.roles.length) userInfo.roles = user.roles
        return { ok: true, mode: 'user-login', userInfo }
    }

    const apiKey = extractApiKey(headers)
    if (apiKey) {
        const resolved = resolveApiKeyOwner(apiKey, config)
        if (resolved.ok) {
            // D55/D79: a mapped extra key carries its own identity (a distinct per-entity
            // owner, optionally with a human-readable email and SEED roles); the default
            // service key carries none, so resolvePrincipal's SERVICE_PRINCIPAL fallback
            // applies as before. `roles` here are seeds only - settings.user_roles stays
            // authoritative and admin-editable (see tools.js#callerRoles).
            if (!resolved.owner) return { ok: true, mode: 'api-key' }
            const userInfo = { sub: resolved.userId || resolved.owner }
            if (resolved.email) userInfo.email = resolved.email
            if (resolved.roles && resolved.roles.length) userInfo.roles = resolved.roles
            return { ok: true, mode: 'api-key', userInfo }
        }
        return { ok: false, error: 'Invalid API key', prmUrl }
    }

    return {
        ok: false,
        error: 'Authentication required: sign in with your Cookbook login (x-cookbook-login: id:password), or provide an Authorization: Bearer token or x-api-key header',
        prmUrl
    }
}

module.exports = { resolveRequestAuth, loadAuthConfig }
