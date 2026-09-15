/*
Copyright 2026 Adobe. All rights reserved.
Licensed under the Apache License, Version 2.0.
*/

/**
 * END-TO-END VALIDATION of the deployed Cookbook connector (D79).
 *
 * Exercises every exposed MCP tool against the LIVE stage deployment as four distinct entities
 * (alice / bob / bharat / viewer) to prove per-owner isolation, role enforcement, the
 * approval/bake/CX gates, and practice-group filtering.
 *
 * Reads keys from the git-ignored keys.local.json - no secret is ever written to the transcript
 * (keys are redacted to their `tap_<entity>_` prefix).
 *
 *   node validation/e2e.mjs [--url <mcp-server-url>]
 *
 * Writes: validation/e2e-transcript.md  (full call/response log + a pass/fail checklist)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const URL_ARG = process.argv.indexOf('--url')
const MCP_URL = URL_ARG > -1
    ? process.argv[URL_ARG + 1]
    : 'https://110557-tapmcpconnector-stage.adobeioruntime.net/api/v1/web/tap-mcp-connector/mcp-server'

const keys = JSON.parse(readFileSync(join(ROOT, 'keys.local.json'), 'utf8')).entities
const KEY = Object.fromEntries(Object.entries(keys).map(([n, e]) => [n, e.key]))
const OWNER = Object.fromEntries(Object.entries(keys).map(([n, e]) => [n, e.email]))
/** Redact a key to a safe, identifying prefix so the transcript is committable. */
const redact = (s) => String(s).replace(/tap_([a-z]+)_[0-9a-f]+/g, 'tap_$1_<redacted>')

const log = []
const checklist = new Map() // tool -> {status, note}
let rpcId = 0

function mark (tool, status, note = '') {
    // Never downgrade a pass to a skip, but a fail always wins (it's the signal that matters).
    const prev = checklist.get(tool)
    if (prev && (prev.status === 'FAIL' || (prev.status === 'PASS' && status === 'SKIP'))) return
    checklist.set(tool, { status, note })
}

/**
 * Call one tool as one entity.
 * @returns {{ok: boolean, data: any, raw: object, error?: string}}
 */
async function call (entity, tool, args = {}, opts = {}) {
    const body = { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: tool, arguments: args } }
    let res, text
    try {
        res = await fetch(MCP_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': KEY[entity] },
            body: JSON.stringify(body)
        })
        text = await res.text()
    } catch (e) {
        log.push({ entity, tool, args, http: 'NETWORK', out: e.message })
        mark(tool, 'FAIL', 'network error')
        return { ok: false, data: null, raw: null, error: e.message }
    }

    let parsed
    try { parsed = JSON.parse(text) } catch { parsed = { raw: text } }
    const result = parsed && parsed.result
    const isErr = !!(result && result.isError)
    const textOut = result?.content?.[0]?.text ?? JSON.stringify(parsed)
    let data = null
    if (!isErr && textOut) { try { data = JSON.parse(textOut) } catch { data = textOut } }

    log.push({ entity, tool, args, http: res.status, isError: isErr, out: textOut })

    // `expectError` inverts the expectation: refusing correctly IS the pass (guards, gates).
    if (opts.expectError) mark(tool, isErr ? 'PASS' : 'FAIL', isErr ? (opts.note || 'correctly refused') : 'expected refusal but succeeded')
    else mark(tool, isErr || res.status >= 400 ? 'FAIL' : 'PASS', opts.note || '')

    return { ok: !isErr && res.status < 400, data, raw: parsed, error: isErr ? textOut : undefined }
}

const findings = []
const check = (desc, cond, detail = '') => {
    findings.push({ desc, pass: !!cond, detail })
    console.log(`${cond ? '  PASS' : '  FAIL'}  ${desc}${detail ? ' — ' + detail : ''}`)
}

console.log(`E2E against ${MCP_URL}\n`)

// ---------------------------------------------------------------- 0. clean slate + config
console.log('[0] Reset + practice/role config (as bharat: admin)')
await call('bharat', 'admin_reset_data', { confirm: true })
await call('bharat', 'get_settings')
await call('bharat', 'get_segmentation_config')
await call('bharat', 'get_resource_policy')
await call('bharat', 'list_resource_types')
const roles = await call('bharat', 'get_my_roles')
check('bharat holds chef+head-chef+admin', ['chef', 'head-chef', 'admin'].every(r => roles.data?.roles?.includes(r)), JSON.stringify(roles.data?.roles))
await call('bharat', 'get_role')
await call('bharat', 'list_user_roles')
await call('bharat', 'set_user_roles', { owner: OWNER.alice, roles: ['chef'] })
const pr = await call('bharat', 'list_practices')
check('practices configured', (pr.data?.practices || []).length >= 4, (pr.data?.practices || []).map(p => p.id).join(','))
await call('bharat', 'set_user_practices', { owner: OWNER.alice, practices: ['aem'] })
await call('bharat', 'set_user_practices', { owner: OWNER.bob, practices: ['braze'] })
await call('bharat', 'set_practices', { practices: [
    { id: 'aem', label: 'AEM' }, { id: 'aep', label: 'AEP / Real-Time CDP' },
    { id: 'braze', label: 'Braze' }, { id: 'campaign', label: 'Adobe Campaign' }
] })

// ---------------------------------------------------------------- 1. alice captures (AEM)
console.log('\n[1] alice (chef, AEM practice) captures a real task')
await call('alice', 'start_project', { name: 'ACME AEM Migration' })
await call('alice', 'set_work_context', { project: 'ACME AEM Migration', epic: 'Content Migration' })
const aRec = await call('alice', 'start_recipe', { project: 'ACME AEM Migration', title: 'Migrate WKND templates to editable templates' })
const aId = aRec.data?.id
check('alice recipe inherits practice=aem', aRec.data?.practice === 'aem', String(aRec.data?.practice))

const KINDS = [
    { kind: 'message', content: 'Client wants WKND static templates migrated to editable templates.', format: 'md' },
    { kind: 'decision', content: 'Decision: use editable templates + core components, not static.', format: 'md' },
    { kind: 'doc', content: '# Migration plan\n\n1. Audit\n2. Convert\n3. Verify\n\n```mermaid\nflowchart TB\n  A[Audit] --> B[Convert] --> C[Verify]\n```', format: 'md' },
    { kind: 'code', content: 'curl -u $AEM_AUTH "$AEM/bin/querybuilder.json?type=cq:Template"', language: 'bash' },
    { kind: 'diagram', content: 'flowchart LR\n  Static[Static Template] --> Editable[Editable Template]\n  Editable --> Policy[Content Policy]', format: 'mermaid' },
    { kind: 'diagram', content: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#C96442"/><text x="10" y="25" fill="#fff">AEM</text></svg>', format: 'svg' },
    { kind: 'image', asset: { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', mime_type: 'image/png' } },
    { kind: 'config', content: '{"templateType":"editable","policy":"wknd/policies/hero"}', format: 'json' },
    { kind: 'handoff', content: 'Hand to the dev agent: convert the hero component policy.', format: 'md' },
    { kind: 'steering', signal: 'affirm', content: 'Confirmed: editable templates is the right call.' },
    { kind: 'steering', signal: 'correct', content: 'Correction: keep the existing breadcrumb component, do not replace it.' },
    { kind: 'steering', signal: 'reject', content: 'Rejected: do not migrate the legacy campaign pages in this phase.' }
]
const stepIds = []
for (const [i, k] of KINDS.entries()) {
    const r = await call('alice', 'append_step', {
        recipe_id: aId, source: 'desktop-ai', model: 'opus-4.8', tokens_used: 900 + i * 25, ...k
    })
    if (r.data?.id) stepIds.push({ id: r.data.id, kind: k.kind, signal: k.signal })
}
check(`all ${KINDS.length} ingredient kinds captured`, stepIds.length === KINDS.length, `${stepIds.length}/${KINDS.length}`)

await call('alice', 'list_steps', { recipe_id: aId })
await call('alice', 'get_recipe', { id: aId, view: 'full' })
await call('alice', 'get_active_recipe', { project: 'ACME AEM Migration' })
await call('alice', 'list_recipes', {})
await call('alice', 'list_projects')
await call('alice', 'list_resources', {})
const searchHit = await call('alice', 'search_resources', { query: 'editable templates' })
check('search finds the captured work (reuse-before-rebuild)', Array.isArray(searchHit.data) && searchHit.data.length > 0, `${searchHit.data?.length} hit(s)`)
await call('alice', 'find_similar', { query: 'editable templates' })

// update-in-place (no duplicate)
const before = (await call('alice', 'list_resources', {})).data?.length || 0
await call('alice', 'save_resource', { id: aId, type: 'architecture-doc', title: 'Migrate WKND templates to editable templates', content: 'Updated in place - v2', project: 'ACME AEM Migration' })
const after = (await call('alice', 'list_resources', {})).data?.length || 0
check('save_resource with an existing id UPDATES, does not duplicate', after === before, `${before} -> ${after}`)

// handoff task lifecycle
const ho = await call('alice', 'save_resource', { type: 'handoff-prompt', title: 'Convert hero policy', content: 'Convert the hero component policy to editable template', project: 'ACME AEM Migration', target_agent: 'claude-code' })
await call('alice', 'list_active_tasks')
if (ho.data?.id) {
    await call('alice', 'set_task_status', { id: ho.data.id, status: 'in_progress' })
    await call('alice', 'link_recipes', { handoff_id: ho.data.id, recipe_ids: [aId] })
    await call('alice', 'set_task_status', { id: ho.data.id, status: 'done' })
}

// ---------------------------------------------------------------- 2. bob (Braze) + isolation
console.log('\n[2] bob (chef, Braze practice) - separate tenant, isolation check')
await call('bob', 'start_project', { name: 'BETA Braze Onboarding' })
const bRec = await call('bob', 'start_recipe', { project: 'BETA Braze Onboarding', title: 'Braze content block strategy' })
const bId = bRec.data?.id
check('bob recipe inherits practice=braze', bRec.data?.practice === 'braze', String(bRec.data?.practice))
await call('bob', 'append_step', { recipe_id: bId, kind: 'message', content: 'Braze content blocks for onboarding journey.', source: 'desktop-ai', model: 'opus-4.8', tokens_used: 400 })

const bobSees = (await call('bob', 'list_recipes', {})).data || []
check('ISOLATION: bob cannot see alice\'s un-approved recipe', !bobSees.some(r => r.id === aId), `bob sees ${bobSees.length}`)
const aliceSees = (await call('alice', 'list_recipes', {})).data || []
check('ISOLATION: alice cannot see bob\'s un-approved recipe', !aliceSees.some(r => r.id === bId), `alice sees ${aliceSees.length}`)

const aemOnly = (await call('alice', 'list_recipes', { practice: 'aem' })).data || []
check('PRACTICE FILTER: aem filter returns only aem work', aemOnly.length > 0 && aemOnly.every(r => r.practice === 'aem'), `${aemOnly.length} aem recipe(s)`)

// ---------------------------------------------------------------- 3. curate + bake gates
console.log('\n[3] Curate: approve / discard, then the bake gate')
const bakeTooEarly = await call('alice', 'bake_recipe', { id: aId }, { expectError: true, note: 'bake blocked with 0 approved' })
check('BAKE GATE: bake refused with zero approved ingredients', !!bakeTooEarly.error, String(bakeTooEarly.error).slice(0, 80))

await call('alice', 'approve_step', { step_id: stepIds[0].id })
await call('alice', 'approve_steps', { step_ids: stepIds.slice(1, 6).map(s => s.id) })
await call('alice', 'discard_step', { step_id: stepIds[stepIds.length - 1].id })
await call('alice', 'certify', { id: aId, note: 'Consent recorded before bake' })
const baked = await call('alice', 'bake_recipe', { id: aId, note: 'Reviewed - reusable migration how-to' })
check('BAKE: succeeds once ingredients are approved', baked.ok && baked.data?.baked === true, JSON.stringify(baked.data?.baked))
const extra = await call('alice', 'save_resource', { type: 'decision', title: 'Use core components', content: 'Decision record', project: 'ACME AEM Migration' })
if (extra.data?.id) await call('alice', 'approve_resource', { id: extra.data.id })
await call('alice', 'export_as_skill', { recipe_id: aId, format: 'prompt' })
await call('alice', 'bake_project', { project: 'ACME AEM Migration' })
await call('alice', 'set_project_status', { project: 'ACME AEM Migration', status: 'active' })

// cross-owner visibility of APPROVED work
const bobSeesApproved = (await call('bob', 'list_recipes', {})).data || []
check('SHARING: bob now sees alice\'s BAKED/approved recipe', bobSeesApproved.some(r => r.id === aId), `bob sees ${bobSeesApproved.length}`)

// ---------------------------------------------------------------- 4. head-chef CX gate
console.log('\n[4] bharat (head-chef): CX gate')
const pending = (await call('bharat', 'list_cx_pending', {})).data || []
check('CX QUEUE: baked recipe appears pending head-chef', pending.some(r => r.id === aId), `${pending.length} pending`)
const cxBefore = await call('bharat', 'get_cx_graph')
const inCxBefore = (cxBefore.data?.nodes || []).some(n => n.id === aId)
check('CX GATE: baked-but-unapproved recipe is NOT yet in the CX graph', !inCxBefore)

const notHeadChef = await call('alice', 'headchef_approve', { recipe_id: aId }, { expectError: true, note: 'non-head-chef refused' })
check('CX GATE: a plain chef cannot admit to the CX graph', !!notHeadChef.error)

await call('bharat', 'headchef_approve', { recipe_id: aId })
await call('bharat', 'rebuild_cx_graph')
const cxAfter = await call('bharat', 'get_cx_graph')
const nodes = cxAfter.data?.nodes || []
check('CX GATE: head-chef admission puts it in the CX graph', nodes.some(n => n.id === aId), `${nodes.length} nodes`)
check('CX INTEGRITY: bob\'s un-approved recipe is NOT in the CX graph', !nodes.some(n => n.id === bId))
const rejUnbaked = await call('bharat', 'headchef_reject', { recipe_id: bId }, { expectError: true, note: 'refuses a non-baked recipe' })
check('CX GATE: headchef_reject refuses a NON-BAKED recipe (candidate gate)', !!rejUnbaked.error, String(rejUnbaked.error).slice(0,70))
await call('bharat', 'headchef_reject', { recipe_id: aId })
await call('bharat', 'headchef_approve', { recipe_id: aId })
await call('bharat', 'admin_list_recipes', {})
await call('bharat', 'admin_list_projects')
await call('bharat', 'set_head_chefs', { head_chefs: ['service-account', OWNER.bharat] })
await call('bharat', 'update_settings', { retention_days: 30 })
await call('bharat', 'purge_expired', {})
await call('bharat', 'get_resource', { id: aId })

// ---------------------------------------------------------------- 5. viewer read-only
console.log('\n[5] viewer: read-only enforcement')
const vRoles = await call('viewer', 'get_my_roles')
check('viewer role is exclusive (no chef)', JSON.stringify(vRoles.data?.roles) === JSON.stringify(['viewer']), JSON.stringify(vRoles.data?.roles))
const vList = await call('viewer', 'list_recipes', {})
check('viewer CAN read', vList.ok)
const vWrite = await call('viewer', 'start_recipe', { project: 'X', title: 'nope' }, { expectError: true, note: 'read-only enforced' })
check('viewer CANNOT write', !!vWrite.error)
const vCx = await call('viewer', 'get_cx_graph')
check('viewer can read the CX graph (shared knowledge)', vCx.ok)

// ---------------------------------------------------------------- report
const rows = [...checklist.entries()].sort(([a], [b]) => a.localeCompare(b))
const passed = findings.filter(f => f.pass).length
const toolFails = rows.filter(([, v]) => v.status === 'FAIL')

let md = `# Cookbook E2E validation transcript\n\n`
md += `- **Target:** \`${MCP_URL}\`\n- **Entities:** alice (chef/AEM), bob (chef/Braze), bharat (chef+head-chef+admin), viewer (read-only)\n`
md += `- **Behaviour assertions:** ${passed}/${findings.length} passed\n- **Tools exercised:** ${rows.length}\n`
md += `- Keys are redacted in this file. Generated by \`validation/e2e.mjs\`.\n\n`

md += `## Behaviour assertions\n\n| Result | Assertion | Detail |\n|---|---|---|\n`
for (const f of findings) md += `| ${f.pass ? '✅' : '❌'} | ${f.desc} | ${redact(f.detail || '')} |\n`

md += `\n## Tool checklist\n\n| Tool | Result | Note |\n|---|---|---|\n`
for (const [tool, v] of rows) md += `| \`${tool}\` | ${v.status === 'PASS' ? '✅ PASS' : v.status === 'FAIL' ? '❌ FAIL' : '➖ ' + v.status} | ${v.note} |\n`

md += `\n## Full call log\n\n`
for (const e of log) {
    md += `### ${e.tool} — as ${e.entity} (HTTP ${e.http}${e.isError ? ', tool error' : ''})\n`
    md += `\`\`\`json\n${redact(JSON.stringify(e.args).slice(0, 700))}\n\`\`\`\n`
    md += `\`\`\`\n${redact(String(e.out).slice(0, 900))}\n\`\`\`\n\n`
}

mkdirSync(join(ROOT, 'validation'), { recursive: true })
writeFileSync(join(ROOT, 'validation', 'e2e-transcript.md'), md)

console.log(`\n${'='.repeat(60)}`)
console.log(`Assertions: ${passed}/${findings.length} passed`)
console.log(`Tools exercised: ${rows.length}; tool failures: ${toolFails.length}`)
if (toolFails.length) console.log('FAILED TOOLS: ' + toolFails.map(([t, v]) => `${t} (${v.note})`).join(', '))
const failed = findings.filter(f => !f.pass)
if (failed.length) console.log('FAILED ASSERTIONS:\n' + failed.map(f => '  - ' + f.desc + (f.detail ? ` [${f.detail}]` : '')).join('\n'))
console.log('transcript -> validation/e2e-transcript.md')
process.exit(failed.length || toolFails.length ? 1 : 0)
