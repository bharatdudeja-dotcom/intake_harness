/*
Copyright 2026 Adobe. All rights reserved.
Licensed under the Apache License, Version 2.0.
*/

/**
 * DEMO REHEARSAL (D89) - walks the exact arc of the live demo against the deployed stage and
 * reports pass/fail on every beat, then removes what it created.
 *
 * Run it 30 minutes before presenting. It answers the only question that matters on the day:
 * is the story I am about to tell actually true right now?
 *
 *   node validation/demo-rehearsal.mjs
 *
 * Exit code 0 means every beat of the demo works. Anything else, read the FAIL lines: each one
 * names the beat that would have broken on stage.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const MCP = 'https://110557-tapmcpconnector-stage.adobeioruntime.net/api/v1/web/tap-mcp-connector/mcp-server'
const DASH = 'https://110557-tapmcpconnector-stage.adobeioruntime.net/api/v1/web/tap-mcp-connector/dashboard-api'
const SPA = 'https://110557-tapmcpconnector-stage.adobeio-static.net/index.html'

const PEOPLE = Object.fromEntries(
    JSON.parse(readFileSync(join(ROOT, 'demo-people.local.json'), 'utf8')).people.map(p => [p.id, p]))

/** One call, retried: a cold serverless action can miss the first request of the day. */
async function call (url, headers, name, args = {}, tries = 4) {
    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
            })
            const body = await res.json()
            if (body.error) return { status: res.status, isError: true, text: body.error.message }
            const text = body.result?.content?.[0]?.text
            return {
                status: res.status,
                isError: !!body.result?.isError,
                text,
                data: (() => { try { return JSON.parse(text) } catch { return null } })()
            }
        } catch (e) {
            if (attempt === tries) return { status: 0, isError: true, text: `network: ${e.message}` }
            await new Promise(r => setTimeout(r, 800 * attempt))
        }
    }
}
const login = (id) => ({ 'x-cookbook-login': `${id}:${PEOPLE[id].password}` })
const asAi = (id, name, args) => call(MCP, login(id), name, args)
const asDash = (id, name, args) => call(DASH, { 'x-cookbook-user-id': id, 'x-cookbook-password': PEOPLE[id].password }, name, args)

let failed = 0
let beat = 0
function ok (label, pass, detail = '') {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
    if (!pass) failed++
}
function scene (title) { beat++; console.log(`\n[${beat}] ${title}`) }

console.log('DEMO REHEARSAL')
console.log(`stage: ${SPA}\n`)

// ── 0. Is anything even up? ──────────────────────────────────────────────────
scene('The deployment is awake and the dashboard loads')
try {
    const page = await fetch(SPA)
    const html = await page.text()
    ok('dashboard HTML serves', page.ok && html.includes('Cookbook'), `HTTP ${page.status}, ${html.length} bytes`)
    ok('no em dashes in the shipped UI', !html.includes('—'))
} catch (e) { ok('dashboard HTML serves', false, e.message) }

// ── 1. Every demo login works, on both surfaces ──────────────────────────────
scene('Every demo login signs in (this is what you type on stage)')
for (const id of Object.keys(PEOPLE)) {
    const viaAi = await asAi(id, 'get_my_roles')
    const viaDash = await asDash(id, 'get_my_roles')
    const who = viaAi.data?.owner
    ok(`${id.padEnd(18)} AI client + dashboard`,
        !viaAi.isError && !viaDash.isError && who === PEOPLE[id].email,
        `${who || viaAi.text} · ${(viaAi.data?.roles || []).join('+')}`)
}
const wrong = await asAi('walter.white', 'get_my_roles')
ok('a wrong password is refused', (await call(MCP, { 'x-cookbook-login': 'walter.white:nope' }, 'get_my_roles')).status === 401, `(control: real login ${wrong.isError ? 'failed' : 'works'})`)

// ── 2. Capture: an AI client writes into the cookbook ────────────────────────
scene('CAPTURE: work arrives from an AI client and lands under its author')
const rehearsalTitle = `Rehearsal: cart abandonment copy test ${Date.now().toString().slice(-5)}`
const started = await asAi('jesse.pinkman', 'start_job', { project: 'Rehearsal', title: rehearsalTitle })
ok('start_job', !started.isError, started.isError ? started.text : `practice inherited: ${started.data.practice}`)
const jobId = started.data?.id
const stepIds = []
if (jobId) {
    for (const s of [
        { kind: 'decision', content: 'Test subject-line urgency against curiosity. Urgency wins on cart recovery; curiosity wins on browse abandonment.', tokens_used: 820 },
        { kind: 'code', language: 'liquid', content: '{% if items[0].inventory_count < 25 %}Only {{items[0].inventory_count}} left{% endif %}', tokens_used: 460 },
        { kind: 'steering', signal: 'reject', content: 'Rejected the countdown timer in the subject line: it renders as literal text in Outlook.', tokens_used: 180 },
        { kind: 'message', content: 'Dead end kept only to be discarded during curation.', tokens_used: 90 }
    ]) {
        const r = await asAi('jesse.pinkman', 'append_step', { job_id: jobId, source: 'ide-agent', model: 'opus-5', ...s })
        if (r.data?.id) stepIds.push(r.data.id)
    }
    ok('append_step x4 (decision, code, steering-reject, dead end)', stepIds.length === 4, `${stepIds.length}/4`)
    const seen = await asDash('jesse.pinkman', 'get_job', { id: jobId, view: 'full' })
    ok('the dashboard sees it immediately', !seen.isError && (seen.data?.steps || []).length === 4)
    ok('token cost recorded', (seen.data?.tokens_used || 0) > 0, `${seen.data?.tokens_used} tokens`)
}

// ── 3. Private by default ────────────────────────────────────────────────────
scene('PRIVACY: nobody else can see it yet, not even by id')
if (jobId) {
    const peerList = await asAi('saul.goodman', 'list_jobs')
    ok('a peer does not see it in their list', !(peerList.data || []).some(r => r.id === jobId))
    ok('a peer cannot read it by id either', (await asAi('saul.goodman', 'get_job', { id: jobId })).isError)
    ok('the head chef does not see it (never submitted)', !((await asAi('walter.white', 'list_jobs')).data || []).some(r => r.id === jobId))
}

// ── 4. Curate, then bake ─────────────────────────────────────────────────────
scene('CURATE: approve what is reusable, discard the dead end, then bake')
if (jobId && stepIds.length === 4) {
    const blocked = await asAi('jesse.pinkman', 'bake_job', { id: jobId })
    ok('bake is REFUSED before anything is approved', blocked.isError, String(blocked.text || '').slice(0, 64))
    ok('approve 3 ingredients', !(await asAi('jesse.pinkman', 'approve_steps', { step_ids: stepIds.slice(0, 3), note: 'Reusable on any cart programme' })).isError)
    ok('discard the dead end', !(await asAi('jesse.pinkman', 'discard_step', { step_id: stepIds[3] })).isError)
    const baked = await asAi('jesse.pinkman', 'bake_job', { id: jobId, note: 'Ready for review' })
    ok('bake now succeeds', !baked.isError && baked.data?.baked === true)
}

// ── 5. The head chef gate ────────────────────────────────────────────────────
scene('REVIEW: it reaches the Head Chef, and only the Head Chef can admit it')
if (jobId) {
    const queue = await asDash('walter.white', 'list_cx_pending')
    ok('it appears in the Head Chef queue', (queue.data || []).some(r => r.id === jobId), `${(queue.data || []).length} in queue`)
    ok('the head chef can now read it', !(await asAi('walter.white', 'get_job', { id: jobId })).isError)
    ok('a peer still cannot (under review, not published)', (await asAi('saul.goodman', 'get_job', { id: jobId })).isError)
    ok('a plain chef cannot admit it', (await asAi('jesse.pinkman', 'headchef_approve', { job_id: jobId })).isError)
    ok('the head chef admits it', !(await asDash('walter.white', 'headchef_approve', { job_id: jobId })).isError)
}

// ── 6. The payoff: another person finds and reuses it ────────────────────────
scene('REUSE: another consultant now finds it by searching, and can read it')
if (jobId) {
    ok('a peer can now read it', !(await asAi('saul.goodman', 'get_job', { id: jobId })).isError)
    const found = await asAi('saul.goodman', 'search_resources', { query: 'cart abandonment subject line' })
    ok('search finds it from a natural phrase', (found.data || []).some(r => r.id === jobId), `${(found.data || []).length} hit(s)`)
    const skill = await asAi('saul.goodman', 'export_as_skill', { job_id: jobId })
    ok('it exports as a replayable playbook', !skill.isError, `${String(skill.text || '').length} chars`)
}

// ── 7. The compounding view ──────────────────────────────────────────────────
scene('THE GRAPH: shared knowledge, cross-owner, filterable by domain')
await asDash('walter.white', 'rebuild_cx_graph')
const graph = (await asDash('guest', 'get_cx_graph')).data || {}
ok('the CX graph is populated', (graph.job_count || 0) > 10, `${graph.job_count} jobs, ${graph.node_count} nodes, ${graph.edge_count} edges`)
ok('it spans several owners', (graph.owners || []).length >= 5, `${(graph.owners || []).length} owners`)
ok('it carries domains for the filter', (graph.practices || []).length >= 3, (graph.practices || []).join(', '))
ok('the read-only guest can read it', !!graph.nodes)
ok('the read-only guest cannot write', (await asAi('guest', 'start_job', { project: 'x', title: 'y' })).isError)

// ── 8. Practices ─────────────────────────────────────────────────────────────
scene('PRACTICES: each discipline can see just its own knowledge')
for (const p of ['braze', 'aem', 'security']) {
    const list = await asDash('walter.white', 'list_jobs', { practice: p })
    ok(`practice filter: ${p}`, !list.isError, `${(list.data || []).length} job(s)`)
}

// ── 9. Assignment ────────────────────────────────────────────────────────────
scene('HANDOVER: assigning an ingredient is the only way to share unfinished work')
const draft = await asAi('saul.goodman', 'start_job', { project: 'Rehearsal', title: `Rehearsal: handover check ${Date.now().toString().slice(-5)}` })
const draftId = draft.data?.id
let draftStep
if (draftId) {
    draftStep = (await asAi('saul.goodman', 'append_step', { job_id: draftId, kind: 'doc', content: 'Half-finished note.', source: 'ide-agent', model: 'opus-5', tokens_used: 120 })).data?.id
    ok('a peer cannot see the draft', !((await asAi('hank.schrader', 'list_jobs')).data || []).some(r => r.id === draftId))
    ok('assign the ingredient to them', !(await asAi('saul.goodman', 'assign_step', { step_id: draftStep, assignee: 'hank.schrader', note: 'Need your security read' })).isError)
    ok('now they can see it', ((await asAi('hank.schrader', 'list_jobs')).data || []).some(r => r.id === draftId))
    const inbox = await asAi('hank.schrader', 'list_my_assignments')
    ok('it shows in their assignments with the note', (inbox.data || []).some(i => i.job_id === draftId), `${(inbox.data || []).length} item(s)`)
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
scene('Cleanup: the rehearsal leaves no trace in the demo data')
for (const id of [jobId, draftId].filter(Boolean)) {
    const res = await asAi('walter.white', 'delete_job', { id, force: true })
    ok(`removed ${String(id).slice(0, 44)}`, !res.isError, res.isError ? String(res.text).slice(0, 60) : '')
}
await asDash('walter.white', 'rebuild_cx_graph')
const after = (await asDash('walter.white', 'get_cx_graph')).data || {}
ok('graph rebuilt to its demo state', (after.job_count || 0) > 10, `${after.job_count} jobs`)

console.log(`\n${'='.repeat(70)}`)
if (failed === 0) {
    console.log('EVERY BEAT OF THE DEMO WORKS. You are clear to present.')
} else {
    console.log(`${failed} beat(s) FAILED. Read the FAIL lines above before you present.`)
}
console.log('='.repeat(70))
process.exit(failed ? 1 : 0)
