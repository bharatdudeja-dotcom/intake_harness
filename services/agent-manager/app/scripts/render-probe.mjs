/**
 * Render every panel in jsdom and report what throws.
 *
 * Written after claiming an end-to-end test that had not been run. The rule it
 * enforces: nothing is reported working until it has actually been rendered.
 * Tool responses are shaped exactly as the server returns them, including the
 * agents/agent_faults rollup, so the panels are exercised on real shapes.
 */
import { JSDOM } from 'jsdom'
import fs from 'fs'

const html = fs.readFileSync(new URL('../web-src/index.html', import.meta.url), 'utf8')
const wrap = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] })

const RUNS = [
  {
    id: 'recipe-live', title: 'Q4 HSD Upsell', type: 'recipe', owner: 'bharat.dudeja@tapcxm.com',
    author: 'bharat.dudeja@tapcxm.com', project: 'Comcast Intake', segments: { project: 'Comcast Intake' },
    status: 'experimental', step_count: 5, version: 1, created: '2026-09-16T00:00:00Z',
    updated: '2026-09-16T01:00:00Z', updated_at: '2026-09-16T01:00:00Z',
    practice: 'workfront', models_used: ['claude-opus-5'], tokens_used: 4200,
    baked: false, cx_approved: false,
    upstream: { system_id: 'agentic-harness', run_id: 'r-1' },
    agents: ['intake'], agent_faults: ['intake']
  },
  {
    id: 'recipe-done', title: 'Xfinity Mobile Winback', type: 'recipe', owner: 'bharat.dudeja@tapcxm.com',
    author: 'bharat.dudeja@tapcxm.com', project: 'Comcast Intake', segments: { project: 'Comcast Intake' },
    status: 'approved', step_count: 7, version: 2, created: '2026-09-15T00:00:00Z',
    updated: '2026-09-15T09:00:00Z', updated_at: '2026-09-15T09:00:00Z',
    practice: 'workfront', models_used: ['claude-opus-5'], tokens_used: 9100,
    baked: true, cx_approved: false,
    upstream: { system_id: 'agentic-harness', run_id: 'r-0' },
    agents: ['intake', 'review', 'audience_creation'], agent_faults: []
  }
  ,
  {
    id: 'recipe-handmade', title: 'As-built architecture, verified 16 Sep', type: 'recipe',
    owner: 'bharat.dudeja@tapcxm.com', author: 'bharat.dudeja@tapcxm.com',
    project: 'Comcast Intake', segments: { project: 'Comcast Intake' },
    status: 'experimental', step_count: 2, version: 1,
    created: '2026-09-16T02:00:00Z', updated: '2026-09-16T02:00:00Z', updated_at: '2026-09-16T02:00:00Z',
    models_used: ['opus-5'], tokens_used: 1200, baked: false, cx_approved: false
    // deliberately NO upstream and NO agents: nothing here ever touched an agent
  }
]

const STEPS = [
  { id: 's1', recipe_id: 'recipe-live', order: 1, kind: 'message', content: '### The brief', format: 'md', status: 'experimental', source: 'agent-manager', tags: ['brief'] },
  { id: 's2', recipe_id: 'recipe-live', order: 2, kind: 'doc', content: '### Intake', format: 'md', status: 'experimental', source: 'agent-manager', tags: ['agent', 'intake', 'silent-failure'], provenance: { duration_ms: 1200, upstream_payload: { agent: 'intake', upstream_status: 'completed' } } },
  { id: 's3', recipe_id: 'recipe-live', order: 3, kind: 'decision', content: '### Time ledger', format: 'md', status: 'experimental', source: 'agent-manager', tags: ['ledger'] },
  { id: 's4', recipe_id: 'recipe-live', order: 4, kind: 'steering', signal: 'correct', content: 'Wrong audience', status: 'approved', source: 'ide-agent', tags: [] }
]

const TOOLS = {
  list_recipes: RUNS,
  list_resources: RUNS,
  list_projects: [{ name: 'Comcast Intake', status: 'active' }],
  list_steps: STEPS,
  get_recipe: { ...RUNS[0], view: 'full', steps: STEPS },
  list_active_tasks: [{ id: 't1', title: 'Hand to AEP', task_status: 'open', target_agent: 'aep', recipe_id: 'recipe-live' }],
  get_settings: { retention_days: 30, segmentation_levels: [{ key: 'project', label: 'Programme', default_label: 'Project' }, { key: 'epic', label: 'Epic', default_label: 'Epic' }, { key: 'story', label: 'Story', default_label: 'Story' }], kind_labels: {}, kinds: [{ type: 'decision', label: 'Decision', approval: 'auto' }], head_chefs: ['bharat.dudeja@tapcxm.com'], practices: [{ id: 'workfront', label: 'Workfront' }] },
  get_role: { role: 'head-chef', roles: ['head-chef', 'chef'], owner: 'bharat.dudeja@tapcxm.com', head_chefs: ['bharat.dudeja@tapcxm.com'] },
  list_cx_pending: [RUNS[1]],
  list_practices: { practices: [{ id: 'workfront', label: 'Workfront' }], my_practices: ['workfront'], my_default_practice: 'workfront' },
  get_cx_graph: { built: true, generated_at: '2026-09-16T01:00:00Z', recipe_count: 1, node_count: 3, edge_count: 2, owners: ['bharat.dudeja@tapcxm.com'], practices: ['workfront'], projects: ['Comcast Intake'], nodes: [{ id: 'recipe-done', node: 'recipe', label: 'Xfinity Mobile Winback', owner: 'bharat.dudeja@tapcxm.com', project: 'Comcast Intake', practice: 'workfront' }, { id: 'x1', node: 'ingredient', recipe: 'recipe-done', kind: 'doc', label: 'a', tags: ['agent', 'review'] }, { id: 'x2', node: 'ingredient', recipe: 'recipe-done', kind: 'message', label: 'b', tags: ['brief'] }], edges: [{ from: 'recipe-done', to: 'x1', rel: 'artifact' }, { from: 'recipe-done', to: 'x2', rel: 'artifact' }] },
  list_agent_systems: [{ id: 'agentic-harness', label: 'Xfinity Creative Intake', practice: 'workfront', active: true, base_url: 'http://34.203.238.63:3000', agents_path: '/api/tasks', start_path: '/api/runs', run_path: '/api/runs/{run_id}', input_key: 'brief', input_envelope: 'input', mcp_endpoint: 'https://cryuy4x9n5.execute-api.us-east-1.amazonaws.com/mcp', mcp_server_id: 'adobe-aec', auth_configured: false, notes: ['Polled, not intercepted.'] }],
  list_system_agents: { system: 'agentic-harness', agents: [
    { id: 'intake', label: 'Intake', owner: 'Uday' },
    { id: 'review', label: 'Review & Triage', owner: 'Bharat, Dylan, Jeff' },
    { id: 'audience_creation', label: 'Audience Creation', owner: 'Chauncey' },
    { id: 'escalation', label: 'Escalation', owner: 'parked' }
  ] },
  list_mcp_servers: [
    { id: 'adobe-aec', label: 'Adobe Experience Cloud MCP', practice: 'aep', endpoint: 'https://x/mcp', active: true, auth_configured: false, auth_source: null, instance: null, notes: ['238 tools.'] },
    { id: 'workfront-adobe', label: 'Workfront MCP (Adobe)', practice: 'workfront', endpoint: 'https://y/mcp', active: false, auth_configured: false, auth_source: '${WORKFRONT_TOKEN}', instance: 'tap.my.workfront.com', notes: [] }
  ],
  list_users: [{ id: 'bharat.dudeja@tapcxm.com' }],
  list_user_roles: {},
  get_segmentation_config: { levels: [{ key: 'project', label: 'Programme' }] }
}

const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost:3000/' })
const { window } = dom
const errors = []
window.addEventListener('error', e => errors.push('window error: ' + (e.error ? e.error.stack : e.message)))
window.onerror = (m, src, l, c, err) => errors.push('onerror: ' + (err ? err.stack : m))

// vis-network is a CDN script jsdom will not fetch. Stub the surface the graph
// actually uses, so the graph CODE is exercised even though nothing is painted.
window.vis = {
  DataSet: class {
    constructor (rows = []) { this.rows = new Map((rows || []).map(r => [r.id, r])) }
    getIds () { return [...this.rows.keys()] }
    get (id) { return this.rows.get(id) || null }
    update (rows) { for (const r of (rows || [])) if (r) this.rows.set(r.id, { ...(this.rows.get(r.id) || {}), ...r }) }
  },
  Network: class { constructor () {} on () {} getConnectedNodes () { return [] } }
}
window.lucide = { createIcons () {} }
// CDN libraries jsdom will not fetch. Stub the surface the renderers touch, so
// a missing CDN does not masquerade as an application bug.
window.DOMPurify = { sanitize: (h) => String(h) }
window.marked = { parse: (t) => String(t), setOptions () {} }
window.hljs = { highlightElement () {}, highlightAll () {} }
window.prompt = () => null

window.fetch = async (url, opts = {}) => {
  let body = {}
  try { body = JSON.parse(opts.body || '{}') } catch (e) {}
  const name = body.params && body.params.name
  const result = Object.prototype.hasOwnProperty.call(TOOLS, name) ? wrap(TOOLS[name]) : wrap([])
  return {
    ok: true, status: 200,
    text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
    json: async () => ({ jsonrpc: '2.0', id: body.id, result })
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

await new Promise(r => window.addEventListener('load', r))
await sleep(300)

const w = window
w.auth = w.auth || {}
w.auth.owner = 'bharat.dudeja@tapcxm.com'
w.auth.cred = { userKey: 'x' }

try { await w.loadAll() } catch (e) { errors.push('loadAll: ' + e.stack) }

const PANELS = ['renderHome', 'renderProjects', 'renderWorklogList', 'renderTasks',
  'renderCookbook', 'renderAgents', 'renderSettings', 'renderConnections']
for (const fn of PANELS) {
  try { if (typeof w[fn] === 'function') w[fn](); else errors.push(fn + ': not defined') }
  catch (e) { errors.push(fn + ': ' + e.stack.split('\n').slice(0, 3).join(' | ')) }
}
for (const fn of ['buildGraph', 'buildCx']) {
  try { await w[fn]() } catch (e) { errors.push(fn + ': ' + e.stack.split('\n').slice(0, 3).join(' | ')) }
}
try { await w.openWorklog('recipe-live') } catch (e) { errors.push('openWorklog: ' + e.stack.split('\n').slice(0, 3).join(' | ')) }
try { await w.openDetail('recipe-live') } catch (e) { errors.push('openDetail: ' + e.stack.split('\n').slice(0, 3).join(' | ')) }
await sleep(200)

// The View JSON button, clicked, in the drawer - the exact thing that was broken.
const jsonBtn = w.document.querySelector('#drawer [data-view-json]')
if (!jsonBtn) errors.push('View JSON: no button rendered in the drawer')
else {
  try {
    w.toggleJson(jsonBtn)
    if (!jsonBtn.closest('.step').querySelector('.json-panel')) errors.push('View JSON: clicked, no panel appeared')
  } catch (e) { errors.push('View JSON threw: ' + e.message) }
}

const D = w.document
const report = (label, sel, must) => {
  const el = D.querySelector(sel)
  const txt = el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''
  const failed = !el || /failed to render/i.test(txt)
  const missing = must && !txt.includes(must)
  console.log(`${failed ? 'FAIL' : missing ? 'THIN' : 'ok  '}  ${label.padEnd(22)} ${txt.slice(0, 95)}`)
}

console.log('\n--- panels ---')
report('home', '#panel-home')
report('programmes', '#panel-projects')
report('live queue', '#panel-tasks')
report('playbooks', '#panel-cookbook')
report('agents', '#panel-agents', 'Hero Agent')
report('settings', '#panel-settings', 'MCP servers')
report('connections', '#panel-connections')

console.log('\n--- specifics ---')
const q = (s) => D.querySelectorAll(s).length
console.log('hero face in Agents      :', q('#panel-agents .hero-face'))
console.log('agent tiles              :', q('#panel-agents .agent-tile'))
console.log('progress bars rendered   :', q('.jrn-bar'))
console.log('progress segments        :', q('.jrn-seg'))
console.log('segments marked faulted  :', q('.jrn-seg.fault'))
// A run no agent ever touched must get NO journey bar. It was getting one, with
// an invented current stage, which is the precise failure this product exists to
// catch - so it is asserted here rather than left to a screenshot.
const handmade = [...D.querySelectorAll('[data-open-worklog],[data-open-recipe]')]
  .map(b => b.closest('.card')).filter(Boolean)
  .filter(c => /As-built architecture/.test(c.textContent))
const bogus = handmade.filter(c => c.querySelector('.jrn-bar'))
console.log('bar on a non-agent run   :', bogus.length === 0 ? 'none (correct)' : 'STILL SHOWN x' + bogus.length)
if (bogus.length) errors.push('journey bar drawn on a run no agent touched')
console.log('MCP rows in Settings     :', q('#panel-settings .mcp-row'))
// Approvals moved into the Hero Agent card, so the check moved with them.
console.log('approvals in hero card   :', q('#panel-agents .hero-queue'))
console.log('no separate approvals nav:', q('nav button[data-panel="headchef"]') === 0 ? 'correct' : 'STILL THERE')
console.log('drawer ledger            :', q('#drawer .ledger, #drawer .jrn-bar'))
console.log('drawer approve button    :', q('#drawer [data-submit-run]'))
const M = { id: 'recipe-live', owner: 'bharat.dudeja@tapcxm.com', author: 'bharat.dudeja@tapcxm.com', status: 'experimental', baked: false, cx_approved: false }
console.log('  recipeStage            :', typeof w.recipeStage === 'function' ? w.recipeStage(M) : 'n/a')
console.log('  isMine                 :', typeof w.isMine === 'function' ? w.isMine(M) : 'n/a')
console.log('  needsBaking            :', typeof w.needsBaking === 'function' ? w.needsBaking(M) : 'n/a')
const dr = D.querySelector('#drawer')
console.log('  drawer head            :', (dr.innerHTML.match(/<div class="rowbtns"[\s\S]{0,160}/) || ['(none)'])[0].replace(/\s+/g, ' '))
console.log('cookbook words left      :', (D.body.textContent.match(/\brecipe|ingredient|cookbook|head chef|bake\b/gi) || []).length)

console.log('\n--- errors ---')
if (!errors.length) console.log('none')
else for (const e of errors) console.log('  * ' + e)
process.exit(errors.length ? 1 : 0)
