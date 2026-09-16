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
 * Work-context dimension tests (Increment 7, D33/D34): epic/story/task on
 * save_resource, the set_work_context default, epic/story filters on
 * list/search, and stable-id upserts (the idempotent-ingest primitive).
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
        })
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
    const body = await rpc('tools/call', { name, arguments: args }, id)
    return body
}

function parseResult (body) {
    return JSON.parse(body.result.content[0].text)
}

describe('work context on save_resource', () => {
    test('explicit epic/story/task are stored and appear in catalog metadata', async () => {
        const save = await callTool('save_resource', {
            type: 'decision', title: 'ctx decision', content: 'x',
            project: 'Proj X', epic: 'Epic A', story: 'Story 1', task: 'Task i'
        })
        const { id } = parseResult(save)

        const full = parseResult(await callTool('get_resource', { id }))
        expect(full.segments.project).toBe('Proj X')
        expect(full.epic).toBe('Epic A')
        expect(full.story).toBe('Story 1')
        expect(full.task).toBe('Task i')

        const listed = parseResult(await callTool('list_resources', {}))
        const entry = listed.find(r => r.id === id)
        expect(entry.segments.project).toBe('Proj X')
        expect(entry.epic).toBe('Epic A')
        expect(entry.story).toBe('Story 1')
    })

    test('set_work_context provides per-level defaults; explicit values on save win', async () => {
        const ctx = parseResult(await callTool('set_work_context', { project: 'Proj', epic: 'Default Epic', story: 'Default Story' }))
        expect(ctx.project).toBe('Proj')
        expect(ctx.segments.epic).toBe('Default Epic')

        // no work context on the save -> project + all segment defaults apply
        const s1 = parseResult(await callTool('save_resource', { type: 'decision', title: 'inherits', content: 'x' }))
        const r1 = parseResult(await callTool('get_resource', { id: s1.id }))
        expect(r1.segments.project).toBe('Proj')
        expect(r1.epic).toBe('Default Epic')
        expect(r1.story).toBe('Default Story')

        // explicit epic overrides that level; project + story still come from the defaults
        const s2 = parseResult(await callTool('save_resource', {
            type: 'decision', title: 'explicit', content: 'x', epic: 'Other Epic'
        }))
        const r2 = parseResult(await callTool('get_resource', { id: s2.id }))
        expect(r2.segments.project).toBe('Proj')
        expect(r2.epic).toBe('Other Epic')
        expect(r2.story).toBe('Default Story')
    })

    test('set_work_context with no arguments clears the default', async () => {
        await callTool('set_work_context', { project: 'Old', epic: 'Old Epic' })
        const cleared = parseResult(await callTool('set_work_context', {}))
        expect(cleared.project).toBeUndefined()
        expect(cleared.epic).toBeUndefined()

        // project cleared -> must pass one explicitly now
        const s = parseResult(await callTool('save_resource', { type: 'decision', title: 'no ctx', content: 'x', project: 'P' }))
        const r = parseResult(await callTool('get_resource', { id: s.id }))
        expect(r.epic).toBeUndefined()
        expect(r.segments.project).toBe('P')
    })
})

describe('epic/story filters', () => {
    beforeEach(async () => {
        await callTool('save_resource', { type: 'decision', title: 'A1 findable', content: 'alpha', project: 'P', epic: 'E1', story: 'S1' }, 1)
        await callTool('save_resource', { type: 'decision', title: 'A2 findable', content: 'alpha', project: 'P', epic: 'E1', story: 'S2' }, 2)
        await callTool('save_resource', { type: 'decision', title: 'B1 findable', content: 'alpha', project: 'P', epic: 'E2', story: 'S1' }, 3)
    })

    test('list_resources filters by epic and by story', async () => {
        const byEpic = parseResult(await callTool('list_resources', { epic: 'E1' }))
        expect(byEpic.map(r => r.title).sort()).toEqual(['A1 findable', 'A2 findable'])

        const byStory = parseResult(await callTool('list_resources', { epic: 'E1', story: 'S2' }))
        expect(byStory).toHaveLength(1)
        expect(byStory[0].title).toBe('A2 findable')
    })

    test('search_resources respects epic/story filters', async () => {
        const found = parseResult(await callTool('search_resources', { query: 'findable', epic: 'E2' }))
        expect(found).toHaveLength(1)
        expect(found[0].title).toBe('B1 findable')
    })
})

describe('stable-id upsert (idempotent ingest primitive)', () => {
    test('same id twice updates in place - no duplicate, created preserved, version bumps', async () => {
        const first = parseResult(await callTool('save_resource', {
            type: 'decision', title: 'v1', content: 'first', id: 'decision-knowledge-x-d1', project: 'P'
        }))
        expect(first.id).toBe('decision-knowledge-x-d1')
        expect(first.updated).toBeUndefined()
        expect(first.version).toBe(1)

        const v1 = parseResult(await callTool('get_resource', { id: first.id }))

        const second = parseResult(await callTool('save_resource', {
            type: 'decision', title: 'v2', content: 'second', id: 'decision-knowledge-x-d1', project: 'P'
        }))
        expect(second.updated).toBe(true)
        expect(second.version).toBe(2) // material change bumps version

        const listed = parseResult(await callTool('list_resources', {}))
        expect(listed.filter(r => r.id === 'decision-knowledge-x-d1')).toHaveLength(1)

        const v2 = parseResult(await callTool('get_resource', { id: first.id }))
        expect(v2.title).toBe('v2')
        expect(v2.content).toBe('second')
        expect(v2.created).toBe(v1.created)
        expect(v2.updated).toBeDefined()
        expect(v2.history).toHaveLength(1) // prior version kept in lineage
        expect(v2.history[0].version).toBe(1)
    })

    test('rejects an invalid stable id shape', async () => {
        const body = await callTool('save_resource', {
            type: 'decision', title: 't', content: 'c', id: 'has spaces!'
        })
        expect(body.result.isError).toBe(true)
    })

    test('server instructions mention the work-context tools', async () => {
        const body = await rpc('initialize', {
            protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' }
        })
        expect(body.result.instructions).toMatch(/set_work_context/)
        expect(body.result.instructions).toMatch(/epic/)
    })
})
