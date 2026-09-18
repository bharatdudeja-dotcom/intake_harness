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

const { z } = require('zod')
const mcpServers = require('./mcp-servers')
const { flattenCommentMarkup } = require('./workfront-comment-text.js')

/**
 * JSON Schema -> a Zod raw shape.
 *
 * The MCP wire format describes a tool's arguments in JSON Schema, and the
 * server SDK's registerTool wants Zod. Handing it the JSON Schema verbatim gets
 * "inputSchema must be a Zod schema or raw shape" and the tool is silently not
 * registered - which is how 238 discovered tools became 0 exposed ones.
 *
 * Only the subset real MCP tools use is translated. Anything unrecognised
 * becomes z.any() rather than being dropped: an argument we cannot describe is
 * still an argument the upstream wants, and refusing to pass it through would
 * break the call for the sake of a type we failed to parse.
 */
function zodForProperty (schema) {
    if (!schema || typeof schema !== 'object') return z.any()
    // A union of types, or anything expressed via anyOf/oneOf, is not worth
    // reconstructing faithfully - pass it through.
    if (Array.isArray(schema.type) || schema.anyOf || schema.oneOf || schema.allOf) return z.any()

    let out
    switch (schema.type) {
        case 'string':
            out = Array.isArray(schema.enum) && schema.enum.length
                ? z.enum(schema.enum.map(String))
                : z.string()
            break
        case 'number': out = z.number(); break
        case 'integer': out = z.number().int(); break
        case 'boolean': out = z.boolean(); break
        case 'array': out = z.array(zodForProperty(schema.items)); break
        case 'object':
            out = schema.properties && Object.keys(schema.properties).length
                ? z.object(zodShape(schema)).passthrough()
                : z.record(z.any())
            break
        default: out = z.any()
    }
    if (schema.description) out = out.describe(String(schema.description))
    return out
}

/** @returns {object} property name -> ZodType, with non-required fields optional */
function zodShape (schema) {
    const props = (schema && schema.properties) || {}
    const required = new Set((schema && schema.required) || [])
    const shape = {}
    for (const [key, spec] of Object.entries(props)) {
        const zt = zodForProperty(spec)
        shape[key] = required.has(key) ? zt : zt.optional()
    }
    return shape
}

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
                // What registerTool actually accepts.
                zodShape: zodShape(t.inputSchema || { type: 'object' }),
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
 * Resolve a BARE tool name to the server that actually has it.
 *
 * The namespaced form is what a fresh client should use, but an existing client
 * cannot be expected to rename its calls to adopt a gateway. The agent harness
 * asks for `search_adobe_knowledge` and `wf_core_project_list`, and it is the
 * gateway's job to know where those live - that is the whole point of putting a
 * gateway in front of an estate.
 *
 * Ambiguity is refused, never guessed. Two servers exposing the same tool name
 * is exactly the case where picking one silently would send a write to the
 * wrong tenant.
 *
 * @returns {Promise<{serverId: string, tool: string}>}
 */
async function resolveBareName (name, overrides) {
    const servers = gatewayServers(overrides)
    const hits = []
    for (const s of servers) {
        const { tools } = await discover(s)
        if (tools.some(t => t.name === name)) hits.push(s.id)
    }
    if (hits.length === 1) return { serverId: hits[0], tool: name }
    if (hits.length > 1) {
        throw new Error(`"${name}" is exposed by more than one server (${hits.join(', ')}). Call it by its namespaced name, e.g. ${proxyName(hits[0], name)}.`)
    }
    // Say what IS available. A bare "unknown tool" is what let
    // search_knowledge_base fail silently on every run for weeks.
    const near = []
    for (const s of servers) {
        const { tools } = await discover(s)
        for (const t of tools) {
            if (t.name.includes(name) || name.includes(t.name.split('_')[0])) near.push(proxyName(s.id, t.name))
        }
    }
    throw new Error(`No gateway server exposes a tool called "${name}".` +
        (near.length ? ` Did you mean: ${near.slice(0, 5).join(', ')}?` : ' Check list_gateway_tools for what is available.'))
}

/**
 * Call a proxied tool, by namespaced name or bare name.
 * Errors are THROWN. Folding an upstream failure into a result that still looks
 * successful is the exact pattern that has kept the intake pipeline reading
 * healthy while every grounding call failed.
 */
async function callProxied (name, args, overrides) {
    let parsed = parseProxyName(name)
    // A bare name is resolved against the estate rather than refused, so a
    // client can be pointed at the gateway without being rewritten first.
    if (!parsed) parsed = await resolveBareName(name, overrides)
    const server = mcpServers.get(parsed.serverId, overrides)
    if (!server) throw new Error(`No MCP server registered with id '${parsed.serverId}'`)
    if (!server.gateway) throw new Error(`${parsed.serverId} is registered but not in the gateway`)

    const { args: safeArgs, flattened } = flattenCommentMarkup(parsed.tool, args || {})
    const result = await mcpServers.callTool(server, parsed.tool, safeArgs)
    if (flattened && result && typeof result === 'object') {
        // Said, not hidden. The comment that landed is not the string that was
        // sent, and the caller should know before it describes what it posted.
        result._gateway_note = `The '${flattened}' you sent contained HTML. Workfront's comment stream ` +
            'renders it literally, so it was converted to plain text before posting. Send plain text ' +
            '(line breaks are fine, markdown is not) and open with the agent that wrote the content.'
    }
    return result
}

module.exports = { catalog, callProxied, resolveBareName, zodShape, zodForProperty, discover, gatewayServers, proxyName, parseProxyName, reset, TTL_MS }
