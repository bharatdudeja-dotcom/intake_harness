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
 * Increment 11 (D45) tests: the ordered Step/Job model, per-step approval + the
 * composed cookbook view, retention/expiry/purge, binary asset round-trip, project
 * lifecycle, and the save_resource back-compat wrapper - driven end to end through
 * main() like the other MCP tests, plus a pure-function suite for lib/steps.js.
 */

jest.mock('@adobe/aio-lib-files')

const filesLib = require('@adobe/aio-lib-files')

const TEST_API_KEY = 'test-api-key'

beforeEach(() => {
    const data = new Map()
    filesLib.init = jest.fn(async () => ({
        list: jest.fn(async (path) => (data.has(path) ? [{ name: path }] : [])),
        read: jest.fn(async (path) => data.get(path)),
        write: jest.fn(async (path, content) => {
            const buf = Buffer.isBuffer(content) ? content : Buffer.from(content)
            data.set(path, buf)
            return buf.length
        }),
        delete: jest.fn(async (path) => { data.delete(path); return [] })
    }))
})

const { main } = require('../actions/mcp-server/index.js')

async function rpc (method, params = {}, id = 1) {
    const result = await main({
        SERVICE_API_KEY: TEST_API_KEY,
        __ow_headers: { 'x-api-key': TEST_API_KEY, host: 'unit.test.host' },
        LOG_LEVEL: 'error',
        __ow_method: 'post',
        __ow_body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    })
    return JSON.parse(result.body)
}
async function callTool (name, args, id = 1) {
    return rpc('tools/call', { name, arguments: args }, id)
}
function parseResult (body) {
    return JSON.parse(body.result.content[0].text)
}

describe('ordering (D45): start_job + append_step', () => {
    test('a job starts empty and experimental; steps append in order 0,1,2', async () => {
        const job = parseResult(await callTool('start_job', { project: 'Ordering', title: 'ordered-demo' }))
        expect(job.status).toBe('experimental')

        const appended = []
        for (let i = 0; i < 3; i++) {
            appended.push(parseResult(await callTool('append_step', {
                job_id: job.id, kind: 'message', content: `step ${i}`, source: 'other'
            })))
        }
        expect(appended.map(s => s.order)).toEqual([0, 1, 2])

        const full = parseResult(await callTool('get_job', { id: job.id, view: 'full' }))
        expect(full.steps.map(s => s.order)).toEqual([0, 1, 2])
        expect(full.steps.map(s => s.content)).toEqual(['step 0', 'step 1', 'step 2'])
        expect(full.status).toBe('experimental')
    })

    test('a fresh experimental step expires roughly 30 days out', async () => {
        const job = parseResult(await callTool('start_job', { project: 'Expiry', title: 'expiry-demo' }))
        const before = Date.now()
        const step = parseResult(await callTool('append_step', { job_id: job.id, kind: 'message', content: 'x', source: 'other' }))
        const days = (new Date(step.expires_at).getTime() - before) / (24 * 60 * 60 * 1000)
        expect(days).toBeGreaterThan(29.9)
        expect(days).toBeLessThan(30.1)
    })

    test('append_step requires content or asset', async () => {
        const job = parseResult(await callTool('start_job', { project: 'Validation', title: 'no-content' }))
        const result = await callTool('append_step', { job_id: job.id, kind: 'message' })
        expect(result.result.isError).toBe(true)
    })
})

describe('per-step approval + composed cookbook view (D45)', () => {
    test('approve_steps on 0 and 2 -> get_job("approved") returns exactly those, in order', async () => {
        const job = parseResult(await callTool('start_job', { project: 'Compose', title: 'compose-demo' }))
        const s0 = parseResult(await callTool('append_step', { job_id: job.id, kind: 'message', content: 'A', source: 'other' }))
        await callTool('append_step', { job_id: job.id, kind: 'message', content: 'B', source: 'other' })
        const s2 = parseResult(await callTool('append_step', { job_id: job.id, kind: 'message', content: 'C', source: 'other' }))

        const approvals = parseResult(await callTool('approve_steps', { step_ids: [s0.id, s2.id], note: 'looks good' }))
        expect(approvals.every(r => r.status === 'approved')).toBe(true)

        const approvedView = parseResult(await callTool('get_job', { id: job.id, view: 'approved' }))
        expect(approvedView.steps.map(s => s.order)).toEqual([0, 2])
        expect(approvedView.steps.map(s => s.content)).toEqual(['A', 'C'])
        expect(approvedView.status).toBe('approved')
    })

    test('the job now appears in list_resources/resources/list as a composed how-to (approved steps only)', async () => {
        const job = parseResult(await callTool('start_job', { project: 'Compose', title: 'compose-demo-2' }))
        const s0 = parseResult(await callTool('append_step', { job_id: job.id, kind: 'message', content: 'A', source: 'other' }))
        await callTool('append_step', { job_id: job.id, kind: 'message', content: 'B (still a draft)', source: 'other' })
        await callTool('approve_step', { step_id: s0.id })

        const listed = parseResult(await callTool('list_resources', { project: 'Compose' }))
        expect(listed.map(r => r.id)).toContain(job.id)

        const nativeList = (await rpc('resources/list')).result.resources.map(r => r.uri)
        expect(nativeList).toContain(`resource://company/job/${job.id}`)

        const read = await rpc('resources/read', { uri: `resource://company/job/${job.id}` })
        expect(read.result.contents[0].text).toBe('A') // only the approved step, not the draft
    })

    test('discard_step excludes a step from views; an approved step cannot be discarded', async () => {
        const job = parseResult(await callTool('start_job', { project: 'Discard', title: 'discard-demo' }))
        const keep = parseResult(await callTool('append_step', { job_id: job.id, kind: 'message', content: 'keep', source: 'other' }))
        const toss = parseResult(await callTool('append_step', { job_id: job.id, kind: 'message', content: 'toss', source: 'other' }))

        await callTool('discard_step', { step_id: toss.id })
        const full = parseResult(await callTool('get_job', { id: job.id, view: 'full' }))
        expect(full.steps.map(s => s.id)).toEqual([keep.id])

        await callTool('approve_step', { step_id: keep.id })
        const err = await callTool('discard_step', { step_id: keep.id })
        expect(err.result.isError).toBe(true)
    })
})

describe('retention / expiry / purge (D44/D45)', () => {
    test('purge_expired removes an artificially-expired experimental step but keeps the approved one', async () => {
        const job = parseResult(await callTool('start_job', { project: 'Retention', title: 'purge-demo' }))
        const keep = parseResult(await callTool('append_step', { job_id: job.id, kind: 'message', content: 'keep me', source: 'other' }))
        parseResult(await callTool('append_step', { job_id: job.id, kind: 'message', content: 'expire me', source: 'other' }))
        await callTool('approve_step', { step_id: keep.id })

        const farFuture = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString()
        const { purgeExpired } = require('../lib/retention')
        const result = await purgeExpired(farFuture)
        expect(result.purged_steps).toBe(1)
        expect(result.purged_jobs).toBe(0)

        const full = parseResult(await callTool('get_job', { id: job.id, view: 'full' }))
        expect(full.steps.map(s => s.id)).toEqual([keep.id])
        expect(full.status).toBe('approved')
    })

    test('purge_expired removes a job left with no approved/active steps at all', async () => {
        const job = parseResult(await callTool('start_job', { project: 'Retention', title: 'fully-expired' }))
        await callTool('append_step', { job_id: job.id, kind: 'message', content: 'nothing kept', source: 'other' })

        const farFuture = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString()
        const { purgeExpired } = require('../lib/retention')
        const result = await purgeExpired(farFuture)
        expect(result.purged_jobs).toBe(1)

        const gone = await callTool('get_resource', { id: job.id })
        expect(gone.result.isError).toBe(true)
    })

    test('purge_expired is idempotent - a second run finds nothing left to purge', async () => {
        const job = parseResult(await callTool('start_job', { project: 'Retention', title: 'idempotent-demo' }))
        await callTool('append_step', { job_id: job.id, kind: 'message', content: 'temp', source: 'other' })

        const farFuture = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString()
        const { purgeExpired } = require('../lib/retention')
        await purgeExpired(farFuture)
        const second = await purgeExpired(farFuture)
        expect(second.purged_steps).toBe(0)
        expect(second.purged_jobs).toBe(0)
    })

    test('purge_expired tool is wired and callable on demand', async () => {
        const result = parseResult(await callTool('purge_expired', {}))
        expect(result).toHaveProperty('checked')
        expect(result).toHaveProperty('purged_steps')
        expect(result).toHaveProperty('purged_jobs')
    })
})

describe('faithful capture: binary asset round-trip (D45)', () => {
    test('an image step round-trips its binary asset', async () => {
        const job = parseResult(await callTool('start_job', { project: 'Assets', title: 'img-demo' }))
        const base64 = Buffer.from('fake-png-bytes').toString('base64')
        const appended = parseResult(await callTool('append_step', {
            job_id: job.id, kind: 'image', asset: { data: base64, mime_type: 'image/png' }
        }))

        const full = parseResult(await callTool('get_job', { id: job.id, view: 'full' }))
        const step = full.steps.find(s => s.id === appended.id)
        expect(step.asset.mime_type).toBe('image/png')
        expect(step.asset.data).toBe(base64)

        // list_steps is the lightweight view - pointer only, no bytes
        const lightweight = parseResult(await callTool('list_steps', { job_id: job.id }))
        expect(lightweight[0].asset.data).toBeUndefined()
        expect(lightweight[0].asset.mime_type).toBe('image/png')
    })

    test('a diagram step can keep its mermaid source alongside a rendered asset', async () => {
        const job = parseResult(await callTool('start_job', { project: 'Assets', title: 'diagram-demo' }))
        const base64 = Buffer.from('fake-png-bytes').toString('base64')
        const appended = parseResult(await callTool('append_step', {
            job_id: job.id, kind: 'diagram', content: 'graph TD; A-->B;', format: 'mermaid',
            asset: { data: base64, mime_type: 'image/png' }
        }))
        const full = parseResult(await callTool('get_job', { id: job.id, view: 'full' }))
        const step = full.steps.find(s => s.id === appended.id)
        expect(step.content).toBe('graph TD; A-->B;')
        expect(step.asset.data).toBe(base64)
    })
})

describe('project lifecycle (D44/D45)', () => {
    test('bake_project flips project status; set_project_status/list_projects work', async () => {
        await callTool('start_project', { name: 'Lifecycle Co' })

        const baked = parseResult(await callTool('bake_project', { project: 'Lifecycle Co' }))
        expect(baked.status).toBe('baked')

        const archived = parseResult(await callTool('set_project_status', { project: 'Lifecycle Co', status: 'archived' }))
        expect(archived.status).toBe('archived')

        const all = parseResult(await callTool('list_projects', {}))
        expect(all.find(p => p.name === 'Lifecycle Co').status).toBe('archived')
    })

    test('bake_project errors clearly for an unknown project', async () => {
        const result = await callTool('bake_project', { project: 'Never Started' })
        expect(result.result.isError).toBe(true)
    })
})

describe('save_resource back-compat wrapper (D45)', () => {
    test('save_resource creates a single-step job; certify syncs step 0', async () => {
        const saved = parseResult(await callTool('save_resource', { type: 'decision', title: 'wrapper test', content: 'v1', project: 'Wrapper' }))
        const full = parseResult(await callTool('get_resource', { id: saved.id }))
        expect(full.steps).toHaveLength(1)
        expect(full.steps[0].order).toBe(0)
        expect(full.steps[0].content).toBe('v1')
        expect(full.steps[0].kind).toBe('decision')
        expect(full.steps[0].status).toBe('experimental')

        await callTool('certify', { id: saved.id, note: 'ok' })
        const approved = parseResult(await callTool('get_job', { id: saved.id, view: 'approved' }))
        expect(approved.steps).toHaveLength(1)
        expect(approved.steps[0].approved_by).toBe('service-account')
        expect(approved.steps[0].approval_note).toBe('ok')
    })

    test('list_jobs excludes handoff-prompts and reflects status', async () => {
        await callTool('save_resource', { type: 'decision', title: 'a job', content: 'x', project: 'ListJobs' })
        await callTool('save_resource', { type: 'handoff-prompt', title: 'a task', content: 'do the thing', target_agent: 'other' })

        const jobs = parseResult(await callTool('list_jobs', { project: 'ListJobs' }))
        expect(jobs.every(r => r.type !== 'handoff-prompt')).toBe(true)
        expect(jobs.some(r => r.title === 'a job')).toBe(true)
    })
})

describe('project records are the source of truth (D49/D52)', () => {
    test('start_job auto-creates a project record', async () => {
        await callTool('start_job', { project: 'Auto From Job', title: 'r' })
        const projects = parseResult(await callTool('list_projects', {}))
        expect(projects.map(p => p.name)).toContain('Auto From Job')
    })

    test('the first save_resource into a new project auto-creates its record', async () => {
        await callTool('save_resource', { type: 'decision', title: 'd', content: 'c', project: 'Auto From Save' })
        const projects = parseResult(await callTool('list_projects', {}))
        expect(projects.map(p => p.name)).toContain('Auto From Save')
    })

    test('set_work_context auto-creates the active project record', async () => {
        await callTool('set_work_context', { project: 'Auto From Context' })
        const projects = parseResult(await callTool('list_projects', {}))
        expect(projects.map(p => p.name)).toContain('Auto From Context')
    })
})

describe('lib/steps - pure helpers', () => {
    const stepsLib = require('../lib/steps')

    test('wrapLegacyStep synthesizes an order-0 step from legacy flat fields', () => {
        const resource = { id: 'decision-1', type: 'decision', content: 'hi', status: 'approved', owner: 'me', tokens_used: 5 }
        const step = stepsLib.wrapLegacyStep(resource)
        expect(step.order).toBe(0)
        expect(step.kind).toBe('decision')
        expect(step.content).toBe('hi')
        expect(step.source).toBe('unknown')
    })

    test('ensureSteps returns a real (even empty) steps array as-is, else wraps the legacy fields', () => {
        expect(stepsLib.ensureSteps({ id: 'r1', steps: [] })).toEqual([])
        expect(stepsLib.ensureSteps({ id: 'r2', content: 'c', status: 'approved' })[0].order).toBe(0)
    })

    test('composeContent joins ordered, non-discarded steps; approvedOnly filters to certified ones', () => {
        const steps = [
            { order: 0, content: 'A', status: 'approved' },
            { order: 1, content: 'B', status: 'experimental' },
            { order: 2, content: 'C', status: 'discarded' }
        ]
        expect(stepsLib.composeContent(steps)).toBe('A\n\n---\n\nB')
        expect(stepsLib.composeContent(steps, { approvedOnly: true })).toBe('A')
    })

    test('jobStatusFromSteps is approved once any single step is approved', () => {
        expect(stepsLib.jobStatusFromSteps([{ status: 'experimental' }])).toBe('experimental')
        expect(stepsLib.jobStatusFromSteps([{ status: 'experimental' }, { status: 'approved' }])).toBe('approved')
    })

    test('aggregateTokens sums tokens_used in order and takes the latest tokens_last', () => {
        const steps = [{ order: 0, tokens_used: 10, tokens_last: 10 }, { order: 1, tokens_used: 5, tokens_last: 5 }]
        expect(stepsLib.aggregateTokens(steps)).toEqual({ total: 15, last: 5 })
    })

    test('makeStepId/parseStepId round trip', () => {
        const id = stepsLib.makeStepId('job-123', 4)
        expect(stepsLib.parseStepId(id)).toEqual({ jobId: 'job-123', order: 4 })
        expect(stepsLib.parseStepId('not-a-step-id')).toBeNull()
    })
})
