/**
 * The MCP server registry.
 *
 * Adobe ships an MCP per product — Workfront, AEM, AEP — and more will arrive.
 * Each is an entry here with an endpoint and auth, never a branch in code. The
 * same rule as agents and agent systems: a server named in source outside this
 * module is a mistake.
 *
 * Seeded from config/mcp-servers.json, overridable from Settings and from any
 * connected AI client, so an admin can point at a new server without a deploy.
 *
 * Secrets never live in the config file. A value written as `${ENV_VAR}` is
 * resolved from the environment at call time, so the file stays committable.
 */

const fs = require('fs')
const path = require('path')

const SEED_PATH = path.join(__dirname, '..', 'config', 'mcp-servers.json')

/** Shape of an entry, for the Settings form and for validation. */
const FIELDS = [
    { key: 'id', label: 'ID', required: true, hint: 'Stable key, e.g. workfront-adobe' },
    { key: 'label', label: 'Name', required: true, hint: 'What people see' },
    { key: 'practice', label: 'Domain', hint: 'workfront | aep | aem' },
    { key: 'endpoint', label: 'Endpoint URL', required: true, hint: 'Base URL of the MCP server' },
    { key: 'auth', label: 'Authorization header', secret: true, hint: 'Leave blank when the server owns auth. ${ENV_VAR} is read from the environment.' },
    { key: 'instance', label: 'Instance', hint: 'Tenant, where the server needs one (Workfront)' },
    { key: 'active', label: 'Active', type: 'boolean', hint: 'Off leaves it registered but unused' },
    { key: 'gateway', label: 'Expose its tools to Claude', type: 'boolean', hint: 'Re-exposes this server\'s own tools through Agent Manager, namespaced by server id' }
]

let seedCache = null

function seed () {
    if (seedCache) return seedCache
    try {
        const raw = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'))
        seedCache = Array.isArray(raw.servers) ? raw.servers : []
    } catch (e) {
        seedCache = []
    }
    return seedCache
}

function reset () { seedCache = null }

/**
 * Resolve `${ENV_VAR}` against the environment.
 * Returns null when the variable is unset, so a server with an unresolved
 * secret reads as unconfigured rather than sending the literal string.
 */
function resolveSecret (value) {
    if (typeof value !== 'string') return value || null
    const match = value.match(/^\$\{([A-Z0-9_]+)\}$/)
    if (!match) return value
    return process.env[match[1]] || null
}

/**
 * Merge the seed with any Settings override, by id.
 * @param {object[]} [overrides] from settings
 */
function list (overrides) {
    const byId = new Map(seed().map(s => [s.id, { ...s }]))
    for (const o of Array.isArray(overrides) ? overrides : []) {
        if (!o || !o.id) continue
        byId.set(o.id, { ...(byId.get(o.id) || {}), ...o })
    }
    return [...byId.values()]
}

/** Public projection: never returns a resolved secret, only whether there is one. */
function listSafe (overrides) {
    return list(overrides).map(s => ({
        id: s.id,
        label: s.label || s.id,
        practice: s.practice || null,
        endpoint: s.endpoint || '',
        instance: s.instance || null,
        active: !!s.active,
        // Whether this server's own tools are re-exposed through Agent Manager's
        // tools/list. Off by default: discovery is a network call, and putting one
        // in the path of every tools/list buys latency for a feature most servers
        // do not want.
        gateway: !!s.gateway,
        // Enough to know whether it will work, without printing the token.
        auth_configured: !!resolveSecret(s.auth),
        auth_source: typeof s.auth === 'string' && s.auth.startsWith('${')
            ? s.auth
            : (s.oauth && s.oauth.connected_at ? 'oauth' : (s.auth ? 'inline' : null)),
        // The connection, never the credential. No branch below returns the token.
        oauth_connected: !!(s.oauth && s.oauth.connected_at),
        oauth_connected_at: (s.oauth && s.oauth.connected_at) || null,
        oauth_expires_at: (s.oauth && s.oauth.expires_at) || null,
        oauth_can_refresh: !!(s.oauth && s.oauth.refresh_token),
        notes: s.notes || []
    }))
}

function get (id, overrides) {
    return list(overrides).find(s => s.id === id) || null
}

/**
 * Is this server usable right now?
 * @returns {{ready: boolean, reason: string|null}}
 */
function readiness (server) {
    if (!server) return { ready: false, reason: 'not registered' }
    if (!server.active) return { ready: false, reason: 'registered but not active' }
    if (!server.endpoint) return { ready: false, reason: 'no endpoint set' }
    if (typeof server.auth === 'string' && server.auth.startsWith('${') && !resolveSecret(server.auth)) {
        return { ready: false, reason: `${server.auth} is not set in the environment` }
    }
    return { ready: true, reason: null }
}

function headersFor (server) {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    const token = resolveSecret(server.auth)
    if (token) h.Authorization = token.startsWith('Bearer ') ? token : `Bearer ${token}`
    // Workfront's connector selects the tenant with its own header.
    if (server.instance) h['wf-url'] = server.instance
    return h
}

/**
 * Read an MCP response body, whichever way the server chose to frame it.
 *
 * MCP's streamable HTTP transport lets a server reply with plain JSON OR with
 * Server-Sent Events, and Adobe's Workfront connector chooses SSE. We sent
 * `Accept: application/json, text/event-stream` - so we ASKED for that
 * possibility - and then called JSON.parse on the raw body, which fails on the
 * very first character of the framing:
 *
 *   event: message
 *   data: {"jsonrpc":"2.0","result":{...}}
 *
 * The user saw `Unexpected token 'd', "data: {"js"... is not valid JSON` from a
 * connector that had authenticated perfectly and was answering correctly. The
 * failure was entirely ours.
 *
 * An SSE body can carry several events; the JSON-RPC reply is the last `data:`
 * payload that parses, so take that.
 *
 * @param {string} text raw response body
 * @param {string} [contentType]
 * @returns {object} the parsed JSON-RPC envelope
 */
function parseMcpBody (text, contentType = '') {
    const body = String(text || '')
    const isSse = /text\/event-stream/i.test(contentType) || /^\s*(event|data|id|retry):/m.test(body)

    if (!isSse) return JSON.parse(body)

    // Continuation lines are part of the preceding data field, per the SSE spec.
    const payloads = []
    let current = null
    for (const raw of body.split(/\r?\n/)) {
        if (/^data:/i.test(raw)) {
            const chunk = raw.replace(/^data:\s?/i, '')
            current = current == null ? chunk : current + '\n' + chunk
        } else if (raw.trim() === '') {
            if (current != null) { payloads.push(current); current = null }
        }
    }
    if (current != null) payloads.push(current)

    for (let i = payloads.length - 1; i >= 0; i--) {
        try {
            const parsed = JSON.parse(payloads[i])
            // The reply we want is a JSON-RPC envelope, not a progress notification.
            if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) return parsed
        } catch (e) { /* try the one before */ }
    }
    // Nothing usable. Say what arrived rather than a parse error about a
    // character, which is what made this so slow to recognise.
    throw new Error(`the server replied with an event stream carrying no JSON-RPC result (${body.slice(0, 120).replace(/\s+/g, ' ')})`)
}

let rpcId = 0

/**
 * Call one tool on one server.
 * Errors are THROWN, never folded into a result that still looks successful -
 * that pattern is exactly what has kept the upstream pipeline looking healthy
 * while failing.
 */
/**
 * Exchange the stored refresh token for a new access token.
 *
 * Adobe's Workfront tokens last about a day, and when ours lapsed every call
 * failed with 401: the gateway dropped all 97 tools and it read as a
 * permissions problem. The sign-in had already stored a refresh_token, and
 * spending it works with nobody present - so an expiry is a token to exchange,
 * not an outage to escalate.
 *
 * Returns the new access token, or null when it cannot be done. Never throws
 * and never logs the token.
 */
async function refreshAccessToken (server) {
    const oauth = server && server.oauth
    const endpoint = oauth && oauth.as && oauth.as.token_endpoint
    if (!oauth || !oauth.refresh_token || !oauth.client_id || !endpoint) return null

    const form = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: oauth.refresh_token,
        client_id: oauth.client_id
    })
    if (oauth.client_secret) form.set('client_secret', oauth.client_secret)

    let payload
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: form.toString()
        })
        if (!res.ok) return null
        payload = await res.json()
    } catch (e) {
        return null
    }
    if (!payload || !payload.access_token) return null

    /*
     * Persist it in the shape the sign-in wrote, so nothing downstream can tell
     * the difference - including the new refresh token, which Adobe rotates.
     * Losing that would make this work exactly once.
     */
    try {
        /*
         * The same path the sign-in uses, so the stored shape is identical and
         * nothing downstream can tell a refresh from a fresh sign-in. Required
         * lazily: store pulls in storage and status, and mcp-servers is loaded
         * early enough that a top-level require would risk a cycle.
         */
        const store = require('./store')
        const settingsLib = require('./settings')
        const current = (await store.getSettingsOverride()) || {}
        const list = Array.isArray(current.mcp_servers) ? current.mcp_servers : []
        const row = list.find(x => x && x.id === server.id)
        if (row) {
            row.auth = payload.access_token
            row.oauth = {
                ...(row.oauth || {}),
                // Adobe ROTATES the refresh token. Dropping the new one would
                // make this work exactly once.
                refresh_token: payload.refresh_token || (row.oauth || {}).refresh_token,
                expires_at: payload.expires_in
                    ? new Date(Date.now() + (Number(payload.expires_in) * 1000)).toISOString()
                    : (row.oauth || {}).expires_at,
                refreshed_at: new Date().toISOString()
            }
            const stored = await store.saveSettingsOverride({ ...current, mcp_servers: list })
            settingsLib._setCache(stored)
        }
    } catch (e) {
        // The token is good even if writing it down failed; the call can still
        // proceed, and the next 401 will simply refresh again.
    }

    // Keep the in-memory server usable for the retry below.
    server.auth = `Bearer ${payload.access_token}`
    return payload.access_token
}

async function callTool (server, name, args = {}, timeoutMs = 45000) {
    const state = readiness(server)
    if (!state.ready) throw new Error(`${server && server.id}: ${state.reason}`)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const res = await fetch(server.endpoint, {
            method: 'POST',
            headers: headersFor(server),
            body: JSON.stringify({
                jsonrpc: '2.0', id: ++rpcId, method: 'tools/call',
                params: { name, arguments: args }
            }),
            signal: controller.signal
        })
        const text = await res.text()
        if (res.status === 401 && !args.__refreshed) {
            /*
             * Not an outage - a token that needs exchanging. One attempt, and
             * if the fresh token is refused too the original 401 stands: a
             * revoked grant needs a person, and retrying would be a storm.
             */
            const fresh = await refreshAccessToken(server)
            if (fresh) {
                clearTimeout(timer)
                return callTool(server, name, { ...args, __refreshed: true }, timeoutMs)
            }
        }
        if (!res.ok) throw new Error(`${server.id} returned HTTP ${res.status} for ${name}`)
        const body = parseMcpBody(text, res.headers && res.headers.get('content-type'))
        if (body.error) throw new Error(`${name}: ${body.error.message || 'unknown MCP error'}`)
        const result = body.result || {}
        if (result.isError) {
            const detail = (result.content || []).map(c => c.text).filter(Boolean).join('\n')
            throw new Error(`${name} returned an error: ${detail || 'unknown'}`)
        }
        const first = (result.content || [])[0]
        if (first && typeof first.text === 'string') {
            try { return JSON.parse(first.text) } catch (e) { return first.text }
        }
        return result
    } finally {
        clearTimeout(timer)
    }
}

/** What a server actually exposes. Used to verify a new entry from Settings. */
async function listTools (server, timeoutMs = 30000) {
    const state = readiness(server)
    if (!state.ready) throw new Error(`${server && server.id}: ${state.reason}`)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const res = await fetch(server.endpoint, {
            method: 'POST',
            headers: headersFor(server),
            body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' }),
            signal: controller.signal
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = parseMcpBody(await res.text(), res.headers && res.headers.get('content-type'))
        if (body.error) throw new Error(body.error.message || 'unknown MCP error')
        return (body.result && body.result.tools) || []
    } finally {
        clearTimeout(timer)
    }
}

module.exports = { FIELDS, list, listSafe, get, readiness, callTool, listTools, resolveSecret, reset, parseMcpBody }
