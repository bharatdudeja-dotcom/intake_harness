/**
 * Agent systems — the upstreams that actually execute agents.
 *
 * This is the ONLY file that knows how to talk to an executing system. Its
 * shape comes from config/agent-systems.json, so onboarding an agentic AEM or
 * an agentic Campaign later is a config entry, not a code change.
 *
 * Two rules it exists to keep:
 *
 *   1. No agent name appears here. Agents are discovered from the upstream's
 *      own catalog, so that system stays the source of truth for what its
 *      agents are called. A fifth agent appears with nothing changed here.
 *
 *   2. Capture is POLLED, not intercepted. The upstream orchestrator calls its
 *      agents server-side, so we start a run and then read it back. Said
 *      plainly, because claiming interception would be claiming a guarantee we
 *      do not have.
 */

const fs = require('fs')
const path = require('path')

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'agent-systems.json')

let cache = null

/** @returns {{systems: object[]}} the registry, read once */
function registry () {
    if (cache) return cache
    try {
        cache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    } catch (e) {
        cache = { systems: [] }
    }
    if (!Array.isArray(cache.systems)) cache.systems = []
    return cache
}

/** Test seam, and used after a registry edit. */
function reset () { cache = null }

/**
 * The shape of an entry, for the Settings form and for validation.
 *
 * Every field here is something an upstream can legitimately differ on, which
 * is the point: a second harness is a row in this form, never a branch in code.
 * The paths and keys are how we read ITS catalog and ITS run envelope, so a
 * system that calls its agents something else, under a different route, is
 * configuration rather than an adapter rewrite.
 */
const FIELDS = [
    { key: 'id', label: 'ID', required: true, hint: 'Stable key, e.g. agentic-harness' },
    { key: 'label', label: 'Name', required: true, hint: 'What people see' },
    { key: 'practice', label: 'Domain', hint: 'workfront | aep | aem' },
    { key: 'base_url', label: 'Base URL', required: true, hint: 'Where the harness answers' },
    { key: 'auth', label: 'Authorization header', secret: true, hint: 'Blank when the host has no auth. An ${ENV_VAR} value is read from the environment.' },
    { key: 'mcp_endpoint', label: 'MCP endpoint it calls', hint: 'Which MCP estate the harness itself reaches' },
    { key: 'mcp_server_id', label: 'Backed by MCP server', hint: 'Which registered MCP server it should use' },
    { key: 'agents_path', label: 'Agent catalog path', hint: 'Where its own agent list lives, e.g. /api/tasks' },
    { key: 'start_path', label: 'Start-run path', hint: 'e.g. /api/runs' },
    { key: 'run_path', label: 'Read-run path', hint: 'e.g. /api/runs/{run_id}' },
    { key: 'input_key', label: 'Input key', hint: 'The field the brief goes in, e.g. brief' },
    { key: 'input_envelope', label: 'Input envelope', hint: 'Wrapper around the input, e.g. input. Blank for top level.' },
    { key: 'active', label: 'Active', type: 'boolean', hint: 'Off leaves it registered but unused' }
]

/**
 * The seed file merged with whatever an admin changed in Settings, by id.
 *
 * config/agent-systems.json claimed to be "editable from Settings" and was
 * not: there was no override list and no setter, so wiring a second harness
 * meant editing a file inside the image and redeploying.
 * @param {object[]} [overrides] from settings.agentSystems()
 */
function merged (overrides) {
    const byId = new Map(registry().systems.map(s => [s.id, { ...s }]))
    for (const o of Array.isArray(overrides) ? overrides : []) {
        if (!o || !o.id) continue
        byId.set(o.id, { ...(byId.get(o.id) || {}), ...o })
    }
    return [...byId.values()]
}

/** @returns {object[]} every registered system, active or not */
function list (overrides) {
    return merged(overrides).map(s => ({
        id: s.id,
        label: s.label,
        practice: s.practice || null,
        adapter: s.adapter || null,
        active: !!s.active,
        base_url: s.base_url || null,
        mcp_endpoint: s.mcp_endpoint || null,
        mcp_server_id: s.mcp_server_id || null,
        // Enough for a Settings form to round-trip an entry without a second call.
        agents_path: s.agents_path || null,
        start_path: s.start_path || null,
        run_path: s.run_path || null,
        input_key: s.input_key || null,
        input_envelope: s.input_envelope || null,
        auth_configured: !!s.auth,
        notes: s.notes || []
    }))
}

/** @param {string} id @returns {object|null} the raw entry, with its endpoint config */
function get (id, overrides) {
    return merged(overrides).find(s => s.id === id) || null
}

/**
 * The system to use when the caller did not name one. Exactly one active system
 * is the common case; more than one is ambiguous and says so rather than
 * guessing.
 * @param {string} [practice]
 * @returns {{system: object|null, error: string|null}}
 */
function resolve (id, practice, overrides) {
    if (id) {
        const found = get(id, overrides)
        if (!found) return { system: null, error: `Unknown agent system '${id}'. Known: ${list().map(s => s.id).join(', ')}` }
        if (!found.active) return { system: null, error: `Agent system '${id}' is registered but not active.` }
        return { system: found, error: null }
    }
    const active = registry().systems.filter(s => s.active && (!practice || s.practice === practice))
    if (active.length === 1) return { system: active[0], error: null }
    if (active.length === 0) return { system: null, error: 'No active agent system is registered.' }
    return {
        system: null,
        error: `More than one active agent system (${active.map(s => s.id).join(', ')}). Name one with system_id.`
    }
}

function headers (system) {
    const h = { 'Content-Type': 'application/json' }
    if (system.auth) h.Authorization = system.auth
    return h
}

async function request (url, options, timeoutMs = 30000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const res = await fetch(url, { ...options, signal: controller.signal })
        const text = await res.text()
        let body = null
        try { body = text ? JSON.parse(text) : null } catch (e) { body = { raw: text } }
        if (!res.ok) {
            const err = new Error(`${options.method || 'GET'} ${url} returned HTTP ${res.status}`)
            err.status = res.status
            err.body = body
            throw err
        }
        return body
    } finally {
        clearTimeout(timer)
    }
}

/**
 * The upstream's own agent catalog. Never a hardcoded list.
 * @returns {Promise<Array<{id,label,owner}>>}
 */
async function discoverAgents (system) {
    if (!system.base_url || !system.agents_path) return []
    const body = await request(`${system.base_url}${system.agents_path}`, { headers: headers(system) })
    const items = Array.isArray(body) ? body : (body?.[system.agents_key || 'agents'] || [])
    return items.map(i => ({
        id: i[system.agent_id_key || 'id'],
        label: i[system.agent_label_key || 'label'] || i[system.agent_id_key || 'id'],
        owner: i[system.agent_owner_key || 'owner'] || null
    })).filter(a => a.id)
}

/**
 * Start a run upstream.
 * @returns {Promise<{upstream_run_id: string, raw: object}>}
 */
async function startRun (system, input) {
    // Two shapes in the wild: the payload at the top level, or nested under an
    // envelope key. Config decides, so a second system with a different contract
    // needs no code here.
    const inner = { [system.input_key || 'brief']: input }
    const payload = system.input_envelope ? { [system.input_envelope]: inner } : inner
    const body = await request(`${system.base_url}${system.start_path}`, {
        method: 'POST', headers: headers(system), body: JSON.stringify(payload)
    })
    const envelope = body?.run || body
    const runId = envelope?.[system.run_id_key || 'run_id']
    if (!runId) {
        const err = new Error('The upstream accepted the request but returned no run id')
        err.body = body
        throw err
    }
    return { upstream_run_id: String(runId), raw: body }
}

/** @returns {Promise<object>} the upstream's run envelope, verbatim */
async function getRun (system, upstreamRunId) {
    const url = `${system.base_url}${(system.run_path || '/api/runs/{run_id}').replace('{run_id}', encodeURIComponent(upstreamRunId))}`
    return request(url, { headers: headers(system) })
}

const TERMINAL = ['completed', 'failed', 'needs_input']

/**
 * Poll until the run reaches a terminal state or we run out of patience.
 *
 * Returns whatever it last saw either way, with `settled` false on a timeout -
 * a partial run that says so is more use than an exception.
 */
async function waitForRun (system, upstreamRunId, { timeoutMs = 25000, intervalMs = 1500 } = {}) {
    const deadline = Date.now() + timeoutMs
    let last = null
    for (;;) {
        last = await getRun(system, upstreamRunId)
        const status = last?.run?.status
        if (TERMINAL.includes(status)) return { envelope: last, settled: true }
        if (Date.now() >= deadline) return { envelope: last, settled: false }
        await new Promise(r => setTimeout(r, intervalMs))
    }
}

/**
 * Find an error embedded anywhere in a payload.
 *
 * The upstream does not raise tool failures - it catches them, writes them into
 * the step's output and still reports `completed`. Anything that trusts the
 * status field records those runs as clean successes. So we go looking.
 *
 * Verified live: intake calls `search_knowledge_base`, which does not exist on
 * the MCP server (the tool is `search_adobe_knowledge`), and the run still
 * reads as completed.
 */
function findEmbeddedError (value, depth = 0) {
    if (depth > 6 || value == null) return null
    if (Array.isArray(value)) {
        for (const v of value) {
            const hit = findEmbeddedError(v, depth + 1)
            if (hit) return hit
        }
        return null
    }
    if (typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            if (['error', 'err', 'exception'].includes(k.toLowerCase()) && v) return String(v).slice(0, 500)
            const hit = findEmbeddedError(v, depth + 1)
            if (hit) return hit
        }
    }
    return null
}

/**
 * Normalise the upstream's steps into what we log.
 * `task_run_id` is per STEP and belongs on the event; the run's own id is the
 * join key. Both are kept - neither is a foreign key across the boundary.
 */
function toSteps (envelope) {
    const rows = envelope?.taskRuns || envelope?.task_runs || []
    return rows.map(r => ({
        upstream_task_run_id: r.task_run_id != null ? String(r.task_run_id) : null,
        agent_id: r.task_id,
        step_index: r.step_index,
        upstream_status: r.status,
        input: r.input,
        output: r.output,
        metadata: r.metadata || {},
        duration_ms: r.duration_ms,
        started_at: r.started_at,
        finished_at: r.finished_at,
        embedded_error: findEmbeddedError(r.output)
    }))
}

/**
 * B1's health metric. loopCount is per-step and inconsistently shaped upstream
 * ({loopCount:0} on intake, {} on review, an echo of input elsewhere), so read
 * it defensively rather than assuming a uniform metadata object.
 */
function loopCount (steps) {
    for (const s of steps) {
        if (s.metadata && typeof s.metadata === 'object' && 'loopCount' in s.metadata) {
            const n = Number(s.metadata.loopCount)
            if (Number.isFinite(n)) return n
        }
    }
    return null
}

module.exports = {
    FIELDS,
    merged,
    registry, reset, list, get, resolve,
    discoverAgents, startRun, getRun, waitForRun,
    toSteps, loopCount, findEmbeddedError
}
