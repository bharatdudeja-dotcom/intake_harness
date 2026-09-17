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
 * Increment 12 Part A (D47): model capture, steering steps, job bake, task=job
 * cross-tool linkage (handoff job_id + get_active_job), and the end-to-end replay
 * skill export - driven through main() like the other MCP tests, plus a pure-function
 * suite for the new lib/steps.js helpers.
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

async function callTool (name, args, id = 1) {
    const result = await main({
        SERVICE_API_KEY: TEST_API_KEY,
        __ow_headers: { 'x-api-key': TEST_API_KEY, host: 'unit.test.host' },
        LOG_LEVEL: 'error',
        __ow_method: 'post',
        __ow_body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
    })
    return JSON.parse(result.body)
}
function parseResult (body) {
    return JSON.parse(body.result.content[0].text)
}

describe('model capture (D47)', () => {
    test('append_step records model; it surfaces per step and in the job models_used projection', async () => {
        const job = parseResult(await callTool('start_job', { project: 'Models', title: 'model-demo' }))
        await callTool('append_step', { job_id: job.id, kind: 'message', content: 'a', source: 'desktop-ai', model: 'opus-4.8' })
        await callTool('append_step', { job_id: job.id, kind: 'code', content: 'x()', source: 'ide-agent', model: 'sonnet-5' })

        const full = parseResult(await callTool('get_job', { id: job.id, view: 'full' }))
        expect(full.steps.map(s => s.model)).toEqual(['opus-4.8', 'sonnet-5'])

        const listed = parseResult(await callTool('list_jobs', { project: 'Models' }))
        const meta = listed.find(r => r.id === job.id)
        expect(meta.models_used).toEqual(['opus-4.8', 'sonnet-5'])
    })

    test('save_resource carries model onto step 0', async () => {
        const saved = parseResult(await callTool('save_resource', { type: 'decision', title: 'm', content: 'c', project: 'Models', model: 'opus-4.8' }))
        const full = parseResult(await callTool('get_resource', { id: saved.id }))
        expect(full.steps[0].model).toBe('opus-4.8')
        expect(full.models_used).toEqual(['opus-4.8'])
    })
})

describe('steering steps (D47)', () => {
    test('a steering step carries its signal and appears in the ordered log', async () => {
        const job = parseResult(await callTool('start_job', { project: 'Steering', title: 'steer-demo' }))
        await callTool('append_step', { job_id: job.id, kind: 'message', content: 'draft plan', source: 'desktop-ai' })
        const steer = parseResult(await callTool('append_step', { job_id: job.id, kind: 'steering', signal: 'correct', content: 'use auth0 not okta', source: 'desktop-ai' }))
        expect(steer.kind).toBe('steering')
        expect(steer.signal).toBe('correct')

        const full = parseResult(await callTool('get_job', { id: job.id, view: 'full' }))
        const s = full.steps.find(x => x.id === steer.id)
        expect(s.kind).toBe('steering')
        expect(s.signal).toBe('correct')
    })

    test('a steering step is valid with no content (self-describing via signal)', async () => {
        const job = parseResult(await callTool('start_job', { project: 'Steering', title: 'steer-nocontent' }))
        const steer = parseResult(await callTool('append_step', { job_id: job.id, kind: 'steering', signal: 'affirm', source: 'cli-agent' }))
        expect(steer.signal).toBe('affirm')
    })

    test('signal is ignored for non-steering kinds', async () => {
        const job = parseResult(await callTool('start_job', { project: 'Steering', title: 'steer-ignored' }))
        const step = parseResult(await callTool('append_step', { job_id: job.id, kind: 'message', content: 'x', signal: 'reject', source: 'desktop-ai' }))
        expect(step.signal).toBeUndefined()
    })
})

describe('bake_job (D47)', () => {
    test('approve_all bakes the job and makes all non-discarded steps followable, in order', async () => {
        const job = parseResult(await callTool('start_job', { project: 'Bake', title: 'bake-all' }))
        await callTool('append_step', { job_id: job.id, kind: 'message', content: 'A', source: 'desktop-ai' })
        await callTool('append_step', { job_id: job.id, kind: 'message', content: 'B', source: 'desktop-ai' })

        const baked = parseResult(await callTool('bake_job', { id: job.id, approve_all: true, note: 'ship it' }))
        expect(baked.baked).toBe(true)
        expect(baked.status).toBe('baked')
        expect(baked.approved_steps).toBe(2)

        const approvedView = parseResult(await callTool('get_job', { id: job.id, view: 'approved' }))
        expect(approvedView.steps.map(s => s.content)).toEqual(['A', 'B'])

        // a baked job is exposed as a cookbook resource
        const listed = parseResult(await callTool('list_jobs', { project: 'Bake', status: 'approved' }))
        expect(listed.map(r => r.id)).toContain(job.id)
    })

    test('bake without approve_all bakes as-is (only already-approved steps are followable)', async () => {
        const job = parseResult(await callTool('start_job', { project: 'Bake', title: 'bake-asis' }))
        const s0 = parseResult(await callTool('append_step', { job_id: job.id, kind: 'message', content: 'keep', source: 'desktop-ai' }))
        await callTool('append_step', { job_id: job.id, kind: 'message', content: 'draft', source: 'desktop-ai' })
        await callTool('approve_step', { step_id: s0.id })

        const baked = parseResult(await callTool('bake_job', { id: job.id }))
        expect(baked.baked).toBe(true)
        expect(baked.approved_steps).toBe(1)
        const approvedView = parseResult(await callTool('get_job', { id: job.id, view: 'approved' }))
        expect(approvedView.steps.map(s => s.content)).toEqual(['keep'])
    })

    test('a baked job stays baked even after an experimental step is purged', async () => {
        const job = parseResult(await callTool('start_job', { project: 'Bake', title: 'bake-purge' }))
        await callTool('append_step', { job_id: job.id, kind: 'message', content: 'keeper', source: 'desktop-ai' })
        await callTool('bake_job', { id: job.id, approve_all: true })
        // add a fresh experimental step, then purge far in the future
        await callTool('append_step', { job_id: job.id, kind: 'message', content: 'late draft', source: 'desktop-ai' })

        const { purgeExpired } = require('../lib/retention')
        await purgeExpired(new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString())

        const full = parseResult(await callTool('get_job', { id: job.id, view: 'full' }))
        expect(full.status).toBe('baked')
    })

    test('bake_job rejects a handoff-prompt', async () => {
        const saved = parseResult(await callTool('save_resource', { type: 'handoff-prompt', title: 'task', content: 'do it', target_agent: 'other' }))
        const result = await callTool('bake_job', { id: saved.id })
        expect(result.result.isError).toBe(true)
    })
})

describe('task = job across tools (D47)', () => {
    test('a handoff-prompt carries job_id and it survives in list_active_tasks', async () => {
        const job = parseResult(await callTool('start_job', { project: 'CrossTool', title: 'task-thread' }))
        await callTool('save_resource', { type: 'handoff-prompt', title: 'go build', content: 'implement X', target_agent: 'cli-agent', job_id: job.id })

        const tasks = parseResult(await callTool('list_active_tasks', {}))
        const t = tasks.find(x => x.title === 'go build')
        expect(t.job_id).toBe(job.id)
    })

    test('get_active_job resolves the most recently updated open job in a project', async () => {
        const older = parseResult(await callTool('start_job', { project: 'Resolve', title: 'older' }))
        const newer = parseResult(await callTool('start_job', { project: 'Resolve', title: 'newer' }))
        // touch `older` last so it becomes the most-recently-updated open job
        await callTool('append_step', { job_id: older.id, kind: 'message', content: 'touch', source: 'desktop-ai' })

        const active = parseResult(await callTool('get_active_job', { project: 'Resolve' }))
        expect(active.active_job.id).toBe(older.id)

        // baking the active one drops it from the resolution
        await callTool('bake_job', { id: older.id, approve_all: true })
        const next = parseResult(await callTool('get_active_job', { project: 'Resolve' }))
        expect(next.active_job.id).toBe(newer.id)
    })

    test('get_active_job returns null when a project has no open job', async () => {
        const active = parseResult(await callTool('get_active_job', { project: 'Empty Project' }))
        expect(active.active_job).toBeNull()
    })
})

describe('replay-skill export (D47)', () => {
    test('export_as_skill on a baked multi-step job returns an ordered end-to-end walkthrough', async () => {
        const job = parseResult(await callTool('start_job', { project: 'Replay', title: 'replay-demo' }))
        await callTool('append_step', { job_id: job.id, kind: 'decision', content: 'Chose Auth0', source: 'desktop-ai', model: 'opus-4.8' })
        await callTool('append_step', { job_id: job.id, kind: 'code', content: 'const x = 1', language: 'javascript', source: 'ide-agent' })
        await callTool('bake_job', { id: job.id, approve_all: true })

        const promptExport = parseResult(await callTool('export_as_skill', { job_id: job.id, format: 'prompt' }))
        expect(promptExport.content).toContain('Step 1')
        expect(promptExport.content).toContain('Step 2')
        expect(promptExport.content).toContain('Chose Auth0')
        expect(promptExport.content).toContain('```javascript')
        expect(promptExport.content).toContain('const x = 1')

        const skillExport = parseResult(await callTool('export_as_skill', { job_id: job.id, format: 'claude-skill' }))
        expect(skillExport.filename).toBe('SKILL.md')
        expect(skillExport.content).toContain('Step 1')
    })

    test('export_as_skill refuses an experimental job', async () => {
        const job = parseResult(await callTool('start_job', { project: 'Replay', title: 'not-baked' }))
        await callTool('append_step', { job_id: job.id, kind: 'message', content: 'draft', source: 'desktop-ai' })
        const result = await callTool('export_as_skill', { job_id: job.id })
        expect(result.result.isError).toBe(true)
    })
})

describe('lib/steps - Increment 12 helpers', () => {
    const stepsLib = require('../lib/steps')

    test('aggregateModels returns distinct models in first-appearance order', () => {
        const steps = [
            { order: 0, model: 'opus-4.8' },
            { order: 1, model: 'sonnet-5' },
            { order: 2, model: 'opus-4.8' },
            { order: 3 }
        ]
        expect(stepsLib.aggregateModels(steps)).toEqual(['opus-4.8', 'sonnet-5'])
        expect(stepsLib.aggregateModels([{ order: 0 }])).toBeUndefined()
    })

    test('composeReplay renders ordered headings, code fences, steering signals, and asset refs', () => {
        const steps = [
            { order: 0, kind: 'decision', content: 'Chose Auth0', source: 'desktop-ai', model: 'opus-4.8', status: 'approved' },
            { order: 1, kind: 'code', content: 'x()', language: 'js', status: 'approved' },
            { order: 2, kind: 'steering', signal: 'correct', content: 'use PKCE', status: 'approved' },
            { order: 3, kind: 'image', asset: { mime_type: 'image/png', path: 'assets/a.png' }, status: 'approved' },
            { order: 4, kind: 'message', content: 'draft', status: 'experimental' }
        ]
        const replay = stepsLib.composeReplay(steps, { approvedOnly: true })
        expect(replay).toContain('## Step 1. Decision (source: desktop-ai, model: opus-4.8)')
        expect(replay).toContain('```js')
        expect(replay).toContain('signal: correct')
        expect(replay).toContain('assets/a.png')
        expect(replay).not.toContain('draft') // experimental step excluded from approvedOnly
    })
})
