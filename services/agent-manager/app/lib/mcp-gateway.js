/**
 * The gateway: an agent's own tools, re-exposed through Agent Manager.
 *
 * THE ARCHITECTURE THIS EXISTS FOR
 *
 * If you connected one of these agents straight to Claude Desktop, it would
 * hand Claude a set of tools. Agent Manager sits in the middle instead: the
 * agents connect here, and Agent Manager re-exposes what they offer to whatever
 * is connected to IT. Swapping one team's agent for another's then happens in
 * Settings, and Claude sees the new capability on its next tools/list - no
 * deploy, no code change, nothing in this file naming a single tool.
 *
 * WHY THE NAMESPACE
 *
 * Two upstreams will eventually both expose something called `search`, and a
 * flat merge would silently shadow one of them. Every proxied tool is prefixed
 * with the server it came from - `adobe-aec__search_adobe_knowledge` - so the
 * name says where the call is going. It also means a native Agent Manager tool
 * can never be shadowed by an upstream, which matters: `approve_step` deciding
 * to mean something else because a vendor shipped a tool with that name would
 * be a very quiet disaster.
 *
 * WHY IT IS OPT-IN
 *
 * A server is proxied only when its registry entry says `gateway: true`. Tools
 * are discovered over the network, and putting a network call in the path of
 * every single tools/list - including the one the test suite makes, and the one
 * a health check makes - buys latency and flakiness for a feature most servers
 * do not want. Off is the safe default; Settings turns it on per server.
 *
 * FAILURE
 *
 * An upstream that does not answer contributes no tools and logs why. It never
 * fails the request. The one thing that must not happen is the failure mode
 * this whole product exists to catch: reporting success while something below
 * quietly did not work. A missing upstream means missing tools, visibly.
 */

const mcpServers = require('./mcp-servers')

/** Discovery is over the network; cache it so only the first caller pays. */
const TTL_MS = 60_000
const cache = new Map()

function cacheKey (server) {
    return `${server.id}|${server.endpoint}|${server.instance || ''}`
}

/**
 * The tools one server exposes, cached.
 * @returns {Promise<{tools: object[], error: string|null}>}
 */
async function discover (server, now = Date.now()) {
    const key = cacheKey(server)
    const hit = cache.get(key)
    if (hit && now - hit.at < TTL_MS) return hit.value

    let value
    try {
        value = { tools: await mcpServers.listTools(server), error: null }
    } catch (e) {
        // Cached too, deliberately: a server that is down should not be
        // re-dialled on every tools/list for the next minute.
        value = { tools: [], error: e.message }
    }
    cache.set(key, { at: now, value })
    return value
}

/** Used by tests and after a Settings edit, so a change is visible at once. */
function reset () { cache.clear() }

/** `adobe-aec` + `search_adobe_knowledge` -> `adobe-aec__search_adobe_knowledge` */
function proxyName (serverId, toolName) {
    return `${String(serverId).replace(/[^a-zA-Z0-9_-]/g, '-')}__${toolName}`
}

/** Split a proxied name back into its parts, or null when it is not one. */
function parseProxyName (name) {
    const at = String(name || '').indexOf('__')
    if (at <= 0) return null
    return { serverId: name.slice(0, at), tool: name.slice(at + 2) }
}

/**
 * Which servers are in the gateway right now.
 * @param {object[]} [overrides] from settings.mcpServers()
 */
function gatewayServers (overrides) {
    return mcpServers.list(overrides).filter(s => {
        if (!s.gateway) return false
        return mcpServers.readiness(s).ready
    })
}

/**
 * Every upstream tool, flattened and namespaced, with where each came from.
 * @param {object[]} [overrides]
 * @returns {Promise<{tools: object[], servers: object[]}>}
 */
async function catalog (overrides) {
    const servers = gatewayServers(overrides)
    const results = await Promise.all(servers.map(async (s) => {
        const { tools, error } = await discover(s)
        return { server: s, tools, error }
    }))

    const tools = []
    for (const { server, tools: upstream } of results) {
        for (const t of upstream) {
            tools.push({
                name: proxyName(server.id, t.name),
                // The description says whose tool this is. A model choosing
                // between two similar tools from two vendors needs to know.
                description: `[via ${server.label || server.id}] ${t.description || t.name}`,
                inputSchema: t.inputSchema || { type: 'object' },
                _server: server.id,
                _tool: t.name
            })
        }
    }
    return {
        tools,
        servers: results.map(r => ({
            id: r.server.id,
            label: r.server.label || r.server.id,
            tool_count: r.tools.length,
            error: r.error
        }))
    }
}

/**
 * Call a proxied tool.
 * Errors are THROWN. Folding an upstream failure into a result that still looks
 * successful is the exact pattern that has kept the intake pipeline reading
 * healthy while every grounding call failed.
 */
async function callProxied (name, args, overrides) {
    const parsed = parseProxyName(name)
    if (!parsed) throw new Error(`${name} is not a gateway tool`)
    const server = mcpServers.get(parsed.serverId, overrides)
    if (!server) throw new Error(`No MCP server registered with id '${parsed.serverId}'`)
    if (!server.gateway) throw new Error(`${parsed.serverId} is registered but not in the gateway`)
    return mcpServers.callTool(server, parsed.tool, args || {})
}

module.exports = { catalog, callProxied, discover, gatewayServers, proxyName, parseProxyName, reset, TTL_MS }
