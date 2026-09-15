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
 * Dashboard API - the no-secret proxy between the control-plane dashboard SPA
 * (web-src) and the MCP server action (Increment 6/8, D29/D37).
 *
 * SERVICE_API_KEY lives HERE, server-side, and is injected into every upstream
 * call. The SPA never sees it: the browser POSTs plain JSON-RPC to this action
 * and this action forwards it to the mcp-server action with x-api-key attached.
 *
 * The proxy is deliberately narrower than the MCP server itself:
 * - only the JSON-RPC methods the dashboard needs are allowed, and
 * - tools/call is restricted to an explicit tool allowlist, mostly read/approve.
 *   The dashboard observes, configures, and approves; it does not author
 *   arbitrary resources. Three exceptions, checked below (not by the generic
 *   allowlist), each scoped to a narrow argument shape rather than the tool
 *   name alone:
 *     - save_resource is allowed ONLY when arguments.type === 'handoff-prompt'
 *       (D37) - a dashboard visitor can log a task brief but still cannot
 *       author any other recipe kind.
 *     - set_task_status is allowed unconditionally - it only ever flips a
 *       handoff-prompt's open/in_progress/done lifecycle field, never content.
 *     - append_step is allowed ONLY when arguments.kind is 'image' or
 *       'diagram' (D58/Increment 16) - the dashboard's manual "attach
 *       diagram/image" fallback for artifacts the AI can't self-serialize
 *       (raster images from artifacts/image-gen). It cannot author any other
 *       step kind (message/code/decision/doc/...).
 *   Per-user dashboard login (so writes carry real identity) is a planned
 *   enhancement, not this increment.
 *
 * GET returns a redacted-by-construction config/info document (the pluggable
 * seams: OIDC provider, storage adapter, host) - secrets are never copied into
 * the response object in the first place.
 */

const { Core } = require('@adobe/aio-sdk')
const { loadAuthConfig } = require('../../lib/auth/config')

/** JSON-RPC methods the dashboard may proxy. */
const ALLOWED_METHODS = new Set([
    'initialize',
    'tools/list',
    'tools/call',
    'resources/list',
    'resources/read',
    'prompts/list',
    'prompts/get'
])

/**
 * Tools the dashboard may invoke via tools/call unconditionally - read/approve/
 * task-status operations. `save_resource` is handled separately below since it's
 * allowed only for one specific, non-authoring use (logging a handoff-prompt).
 */
const ALLOWED_TOOLS = new Set([
    'get_resource_policy',
    'list_resource_types',
    'get_segmentation_config', // read-only: the configured level labels (D43)
    'list_resources',
    'search_resources',
    'get_resource',
    'approve_resource',
    'certify', // consent approval with note - same gate as approve_resource (D42/D43)
    'export_as_skill',
    'list_active_tasks',
    'set_task_status',
    // Increment 12 (D48) - daily-driver dashboard. READS: the ordered Step/Recipe model.
    'get_recipe',
    'list_recipes',
    'list_steps',
    'list_projects',
    'get_settings',
    // CONSENT / LIFECYCLE WRITES: per-step approval, discard, and recipe/project bake.
    'approve_step',
    'approve_steps',
    'discard_step',
    'bake_recipe',
    'bake_project',
    'set_project_status', // Projects panel archive/lifecycle (disclosed superset of the brief, D48)
    // GUARDED SETTINGS WRITE: runs under the shared service key today; per-user RBAC is a
    // later increment. NOT a general write surface - only the editable settings fields.
    'update_settings',
    // Increment 14 (D53) - company CX knowledge graph: read + guarded rebuild only.
    'get_cx_graph',
    'rebuild_cx_graph',
    // Increment 25 (D106) - the Cook-off board. Counts per person, no recipe identity, readable by
    // everyone on purpose so the standings and the purity colours are the same for every viewer.
    'get_cookoff',
    // Increment 15 (D55) - the admin list tools were proxied for the dashboard's "All owners"
    // toggle. D98 scoped them to the same visibility rules as everything else, which left the
    // toggle promising a cross-owner view it could not deliver, so D103 removed both the toggle
    // and this proxy entry. The tools still exist for AI clients; the dashboard has one view.
    // Increment 18 (D64) - Head Chef CX-graph gate. READS: the caller's role + the review queue.
    // GUARDED WRITES: headchef_approve/reject are self-guarded server-side (head-chef roster);
    // the dashboard calls them under the shared service key, which is on the seeded roster.
    // set_head_chefs is deliberately NOT proxied (admin/x-api-key only).
    'get_role',
    'list_cx_pending',
    'headchef_approve',
    'headchef_reject',
    // Increment 19 (D66) - multi-role RBAC. READS: get_my_roles (anyone), list_user_roles (admin,
    // self-guarded). WRITE: set_user_roles is self-guarded server-side (admin role) - safe to proxy
    // since enforcement is in the tool, not the allowlist.
    'get_my_roles',
    'list_user_roles',
    'set_user_roles',
    // Practice / capability groups (D79): read for everyone (it drives the practice filter),
    // writes are self-guarded server-side (admin for the list, head-chef/admin per user).
    'list_practices',
    'set_practices',
    'set_user_practices',
    // User accounts (D81) - the admin's Team panel creates logins from the dashboard. Every one of
    // these is self-guarded server-side by the admin role, so proxying them adds no privilege; the
    // allowlist only decides which tools the browser may reach at all. No tool here can return
    // password material - list_users returns hashes-stripped records by construction.
    'create_user',
    'list_users',
    'set_user_password',
    'set_user_enabled',
    // Self-service (D82): any signed-in user changes their OWN password. Not admin-gated - it
    // only ever affects the caller's own account, and it re-verifies their current password.
    'change_my_password',
    // Assignment (D86): the explicit route for sharing unfinished work. Self-guarded server-side
    // to the recipe's owner, a head chef or an admin.
    'assign_step',
    'unassign_step',
    'list_my_assignments',
    // The name directory (D96): a read anyone may make, so people appear by name rather than by a
    // name guessed from their email. set_user_display_name is self-guarded to admins.
    'list_people',
    'set_user_display_name'
])

/** The only resource type the dashboard may author via the proxied save_resource (D37). */
const DASHBOARD_AUTHORABLE_TYPE = 'handoff-prompt'

/** The only append_step kinds the dashboard may author via the proxy (D58) - the manual
 * "attach diagram/image" fallback, nothing else. */
const DASHBOARD_APPENDABLE_KINDS = new Set(['image', 'diagram'])

// Fallback Origin when the request has none (e.g. a direct curl) or doesn't match
// the expected static-hosting suffix - the App Builder stage SPA's real origin.
const FALLBACK_ORIGIN = 'https://110557-tapmcpconnector-stage.adobeio-static.net'

/**
 * The SPA (web-src) is served from *.adobeio-static.net while this action lives on
 * *.adobeioruntime.net - a cross-origin call, so every response (including errors and
 * the OPTIONS preflight) must carry a matching Access-Control-Allow-Origin or the
 * browser discards the response before the SPA ever sees it (curl ignores CORS
 * entirely, which is why curl-based verification alone missed this).
 *
 * No cookies/credentials are sent (auth is a static SERVICE_API_KEY held server-side
 * here, never in the browser), so reflecting the calling origin back is safe - it is
 * still restricted to App Builder's own static-hosting domain, not "any site."
 * @param {Record<string, any>} params
 * @returns {object} CORS headers to merge into every response
 */
function corsHeadersFor (params) {
    const headers = params.__ow_headers || {}
    const origin = headers.origin || headers.Origin || ''
    const allowOrigin = origin.endsWith('.adobeio-static.net') ? origin : FALLBACK_ORIGIN
    return {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        // Authorization added (D65): the browser now sends the signed-in user's IMS Bearer
        // token so the proxy can forward it per-user instead of injecting the shared key.
        // x-cookbook-passcode: the interim static-passcode gate (D65 stopgap).
        // x-cookbook-user-key (D79): the viewer's OWN per-user access key, so the dashboard shows
        // their private cookbook instead of the shared service identity's.
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-cookbook-passcode, x-cookbook-user-key, x-cookbook-user-id, x-cookbook-password',
        'Access-Control-Max-Age': '86400'
    }
}

/** @returns {string} the caller's bearer token, or '' if no Authorization: Bearer header */
function incomingBearer (params) {
    const headers = params.__ow_headers || {}
    const auth = headers.authorization || headers.Authorization || ''
    return auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
}

/**
 * The viewer's own per-user access key (D79). Until per-user IMS login is live for the browser,
 * this is how the dashboard becomes personal: the user supplies THEIR key, the proxy forwards it
 * upstream as x-api-key, and the MCP server resolves their identity - so they see their own work
 * plus everyone's approved/CX knowledge, never another user's private drafts. The shared
 * SERVICE_API_KEY stays server-side and is never sent to the browser.
 * @param {Record<string, any>} params
 * @returns {string} the supplied user key, or ''
 */
function incomingUserKey (params) {
    const headers = params.__ow_headers || {}
    return String(headers['x-cookbook-user-key'] || headers['X-Cookbook-User-Key'] || '').trim()
}

/**
 * Whether this deployment insists every dashboard caller identify themselves (D79). Defaults to
 * ON: a shared-view dashboard is the wrong default for a per-user cookbook. Set
 * DASHBOARD_REQUIRE_IDENTITY=false only for a single-tenant demo deployment.
 * @param {Record<string, any>} params
 * @returns {boolean}
 */
function requireIdentity (params) {
    const raw = params.DASHBOARD_REQUIRE_IDENTITY
    if (raw === undefined || raw === null || raw === '') return true
    return !['false', '0', 'no', 'off'].includes(String(raw).trim().toLowerCase())
}

/**
 * The signed-in user's Cookbook login (D81), forwarded upstream so the MCP server resolves the
 * person - not a shared key. This is the dashboard's primary identity mechanism now that the
 * shared passcode is gone.
 * @param {Record<string, any>} params
 * @returns {{id: string, password: string}|null}
 */
function incomingLogin (params) {
    const headers = params.__ow_headers || {}
    const id = String(headers['x-cookbook-user-id'] || headers['X-Cookbook-User-Id'] || '').trim()
    const password = String(headers['x-cookbook-password'] || headers['X-Cookbook-Password'] || '')
    return (id && password) ? { id, password } : null
}

/** @returns {string} the caller's supplied dashboard passcode header, or '' */
function incomingPasscode (params) {
    const headers = params.__ow_headers || {}
    return String(headers['x-cookbook-passcode'] || headers['X-Cookbook-Passcode'] || '').trim()
}

/**
 * Length-independent equality for the passcode, to avoid leaking length/prefix via early-exit
 * timing. Not a cryptographic guarantee (a short shared code is inherently weak - this is a
 * stopgap), just avoiding the most trivial side channel.
 * @param {string} supplied @param {string} expected @returns {boolean}
 */
function passcodeMatches (supplied, expected) {
    const a = String(supplied || '')
    const b = String(expected || '')
    if (!b) return false
    let diff = a.length ^ b.length
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i % b.length)
    return diff === 0
}

/**
 * @param {number} statusCode
 * @param {object} body
 * @param {object} cors CORS headers for this request (see corsHeadersFor)
 * @returns {{statusCode: number, headers: object, body: string}}
 */
function jsonResponse (statusCode, body, cors) {
    return {
        statusCode,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }
}

/**
 * @param {number} statusCode HTTP status for the response
 * @param {number} code JSON-RPC error code
 * @param {string} message
 * @param {*} id JSON-RPC request id, if known (null if unknown)
 * @param {object} cors CORS headers for this request (see corsHeadersFor)
 * @returns {{statusCode: number, headers: object, body: string}}
 */
function rpcError (statusCode, code, message, id, cors) {
    return jsonResponse(statusCode, { jsonrpc: '2.0', error: { code, message }, id }, cors)
}

/**
 * @param {Record<string, any>} params
 * @returns {object|null} parsed JSON body, or null if absent/unparseable
 */
function parseBody (params) {
    if (!params.__ow_body) return null
    try {
        if (typeof params.__ow_body === 'string') {
            try {
                return JSON.parse(Buffer.from(params.__ow_body, 'base64').toString('utf8'))
            } catch (e) {
                return JSON.parse(params.__ow_body)
            }
        }
        return params.__ow_body
    } catch (e) {
        return null
    }
}

/**
 * The dashboard's "connections & seams" document: which OIDC provider, storage
 * adapter, and host this deployment is wired to. Built field-by-field from
 * non-secret values only - SERVICE_API_KEY, OAUTH_CLIENT_SECRET, and
 * OAUTH_CLIENT_ID are never read into it, so they cannot leak.
 * @param {Record<string, any>} params
 * @returns {object}
 */
function buildInfo (params) {
    const config = loadAuthConfig(params)
    return {
        connector: {
            name: 'tap-mcp-connector',
            mcpServerUrl: config.resourceUrl || null,
            prmUrl: config.prmUrl || null
        },
        seams: {
            oidc: {
                provider: config.provider,
                providerLabel: config.providerLabel,
                providerScaffold: config.providerScaffold || false,
                adapter: config.validationStrategy === 'jwks' ? 'jwks (audience-bound JWT verification)' : 'userinfo (endpoint validation)',
                issuer: config.issuer || null,
                audience: config.audience || null,
                requiredScope: config.requiredScope || null,
                swappable: 'Config-only swap: set AUTH_PROVIDER (adobe-ims | microsoft-entra) + its client id - D21/D66/D73'
            },
            storage: {
                adapter: '@adobe/aio-lib-files (App Builder blob storage)',
                swapPoint: 'lib/store.js - SharePoint/Graph or S3 swap planned (Increment 4, D27)'
            },
            host: {
                adapter: 'Adobe I/O Runtime (App Builder web actions)',
                swapPoint: 'actions/* transport shims - any HTTP host works (D21)'
            }
        },
        downstream: [
            { system: 'AEM', status: 'planned', note: 'Gateway tools - Increment 5' },
            { system: 'Braze', status: 'planned', note: 'Gateway tools - Increment 5' },
            { system: 'CJA', status: 'planned', note: 'Gateway tools - Increment 5' }
        ],
        // Per-user dashboard login (D65). All values here are PUBLIC (issuer, discovery URL,
        // the public SPA client id, scopes) - never a secret. When `enabled` is false (no SPA
        // client id provisioned yet) the SPA stays in anonymous shared-key mode.
        login: {
            enabled: !!config.dashboardClientId,
            issuer: config.issuer || null,
            discoveryUrl: config.discoveryUrl || null,
            clientId: config.dashboardClientId || null,
            scope: config.requiredScope ? `openid ${config.requiredScope}`.replace(/\bopenid openid\b/, 'openid') : 'openid'
        },
        // Interim static-passcode gate (D65 stopgap). Only advertises WHETHER a passcode is
        // required, never the passcode itself. Superseded once per-user login is enabled.
        passcodeRequired: !!config.dashboardPasscode,
        // D79: tells the SPA to ask for the viewer's own access key, so each person opens THEIR
        // cookbook. Advertises only that a key is needed - never any key value.
        identity: {
            required: requireIdentity(params),
            userKeyAccepted: true,
            loginSupported: true,
            header: 'x-cookbook-user-id / x-cookbook-password',
            note: 'Your private work is visible only to you. Approved recipes and the Company CX Graph are shared with everyone.'
        },
        dashboardAuth: config.dashboardClientId
            ? 'per-user OIDC login (PKCE); the signed-in user\'s token is forwarded to the MCP server, so the view is private to them'
            : 'anonymous proxy (shared service key); set DASHBOARD_OAUTH_CLIENT_ID to require per-user login'
    }
}

/**
 * Forward an allowed JSON-RPC request to the MCP server with the service key attached.
 * @param {object} rpc the JSON-RPC request from the SPA
 * @param {Record<string, any>} params action params (for config)
 * @param {object} logger
 * @param {object} cors CORS headers for this request (see corsHeadersFor)
 * @returns {Promise<{statusCode: number, headers: object, body: string}>}
 */
async function proxyRpc (rpc, params, logger, cors, userToken, userKey, login) {
    const config = loadAuthConfig(params)
    if (!config.resourceUrl) {
        return rpcError(500, -32603, 'Proxy is not configured: MCP_RESOURCE_URL is unset', rpc.id, cors)
    }

    // D65 per-user auth: when the signed-in user sends their IMS Bearer token, forward IT
    // (so the MCP server resolves the caller's own identity and returns their private view),
    // NEVER the shared service key. The shared key is used only in anonymous mode - i.e. when
    // per-user login is not configured on this deployment (no DASHBOARD_OAUTH_CLIENT_ID).
    // Identity precedence: a signed-in IMS token wins; else the user's OWN access key (D79);
    // else - only when this deployment has not required identity - the shared service key.
    const upstreamHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    if (userToken) {
        upstreamHeaders.Authorization = `Bearer ${userToken}`
    } else if (login) {
        // D81: forward the login itself; the MCP server verifies it against the user store.
        upstreamHeaders['x-cookbook-user-id'] = login.id
        upstreamHeaders['x-cookbook-password'] = login.password
    } else if (userKey) {
        upstreamHeaders['x-api-key'] = userKey
    } else {
        if (!config.serviceApiKey) {
            return rpcError(500, -32603, 'Proxy is not configured: SERVICE_API_KEY is unset', rpc.id, cors)
        }
        upstreamHeaders['x-api-key'] = config.serviceApiKey
    }

    let upstream
    try {
        upstream = await fetch(config.resourceUrl, {
            method: 'POST',
            headers: upstreamHeaders,
            body: JSON.stringify(rpc)
        })
    } catch (error) {
        logger.error('Upstream MCP call failed:', error.message)
        return rpcError(502, -32603, `Upstream MCP server unreachable: ${error.message}`, rpc.id, cors)
    }

    const text = await upstream.text()
    return {
        statusCode: upstream.status,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: text
    }
}

/**
 * @param {Record<string, any>} params Adobe I/O Runtime action params
 * @returns {Promise<{statusCode: number, headers: object, body: string}>}
 */
async function main (params) {
    const logger = Core.Logger('dashboard-api', { level: params.LOG_LEVEL || 'info' })
    const cors = corsHeadersFor(params)

    try {
        const method = (params.__ow_method || 'get').toLowerCase()

        // Preflight must bypass SERVICE_API_KEY/upstream logic entirely - it's just
        // the browser asking permission before it will send the real request.
        if (method === 'options') {
            return { statusCode: 200, headers: cors, body: '' }
        }

        if (method === 'get') {
            return jsonResponse(200, buildInfo(params), cors)
        }

        if (method !== 'post') {
            return rpcError(405, -32000, `Method '${params.__ow_method}' not allowed. Supported: GET, POST, OPTIONS`, null, cors)
        }

        const rpc = parseBody(params)
        if (!rpc || typeof rpc.method !== 'string') {
            return rpcError(400, -32700, 'Body must be a JSON-RPC 2.0 request with a "method"', null, cors)
        }

        // D81: the shared deployment passcode is GONE. The gate is now the per-user login below,
        // which is strictly better: a shared code proved only that someone was allowed in, never
        // who they were, so it could not scope anyone's data. DASHBOARD_PASSCODE is still honoured
        // if a deployment sets it, purely so an existing environment doesn't silently lose a lock
        // it thinks it has - but it is no longer the way anyone signs in.
        const gateConfig = loadAuthConfig(params)
        if (gateConfig.dashboardPasscode) {
            const supplied = incomingPasscode(params)
            if (!passcodeMatches(supplied, gateConfig.dashboardPasscode)) {
                logger.warn('Blocked: missing/incorrect dashboard passcode')
                return rpcError(401, -32001, 'This cookbook is locked. Enter the access code to continue.', rpc.id, cors)
            }
        }

        if (!ALLOWED_METHODS.has(rpc.method)) {
            logger.warn(`Blocked non-allowlisted JSON-RPC method: ${rpc.method}`)
            return rpcError(403, -32601, `Method '${rpc.method}' is not available through the dashboard proxy`, rpc.id, cors)
        }
        if (rpc.method === 'tools/call') {
            const toolName = rpc.params && rpc.params.name
            const args = (rpc.params && rpc.params.arguments) || {}
            const isScopedSave = toolName === 'save_resource' && args.type === DASHBOARD_AUTHORABLE_TYPE
            const isScopedAppend = toolName === 'append_step' && DASHBOARD_APPENDABLE_KINDS.has(args.kind)
            if (!ALLOWED_TOOLS.has(toolName) && !isScopedSave && !isScopedAppend) {
                logger.warn(`Blocked non-allowlisted tool call: ${toolName}`)
                let hint = ''
                if (toolName === 'save_resource') hint = ` (save_resource is only permitted through the dashboard for type "${DASHBOARD_AUTHORABLE_TYPE}")`
                else if (toolName === 'append_step') hint = ` (append_step is only permitted through the dashboard for kind "image" or "diagram")`
                return rpcError(403, -32601, `Tool '${toolName}' is not available through the dashboard proxy${hint}`, rpc.id, cors)
            }
        }

        // D65 per-user auth. When login is configured (DASHBOARD_OAUTH_CLIENT_ID set), the SPA
        // MUST send the signed-in user's Bearer token; a request without one is rejected 401 so
        // the browser re-authenticates (no anonymous shared-key fallback = no open view). When
        // login is NOT configured, we stay in anonymous shared-key mode for backward-compat.
        const config = loadAuthConfig(params)
        const userToken = incomingBearer(params)
        const login = userToken ? null : incomingLogin(params)
        const userKey = (userToken || login) ? '' : incomingUserKey(params)
        if (config.dashboardClientId && !userToken) {
            logger.warn('Per-user login required but no Bearer token presented')
            return rpcError(401, -32001, 'Sign-in required: this dashboard forwards your Adobe IMS identity. Log in and retry.', rpc.id, cors)
        }
        // D79: when this deployment requires identity, refuse to fall back to the shared service
        // key - otherwise every user would land in ONE shared cookbook view (whoever owns the
        // service key) instead of their own.
        if (requireIdentity(params) && !userToken && !login && !userKey) {
            logger.warn('Identity required but neither a Bearer token nor a user access key was presented')
            return rpcError(401, -32002, 'Sign in with your Cookbook login to open your own cookbook. Your private work is only visible to you; approved recipes and the CX graph are shared with everyone.', rpc.id, cors)
        }

        const mode = userToken ? 'per-user-token' : (login ? 'user-login' : (userKey ? 'per-user-key' : 'shared-service-key'))
        logger.info(`Proxying ${rpc.method}${rpc.params && rpc.params.name ? ` (${rpc.params.name})` : ''} [${mode}]`)
        return await proxyRpc(rpc, params, logger, cors, userToken, userKey, login)
    } catch (error) {
        logger.error('Unhandled dashboard-api error:', error)
        return rpcError(500, -32603, `Internal proxy error: ${error.message}`, null, cors)
    }
}

module.exports = { main }
