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
 * Handoff Prompts & Active Tasks tests (Increment 8, D36): the handoff-prompt
 * recipe kind, export_as_skill, list_active_tasks, set_task_status, and
 * link_recipes, driven end to end through main() like the other MCP tests.
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
    return rpc('tools/call', { name, arguments: args }, id)
}

function parseResult (body) {
    return JSON.parse(body.result.content[0].text)
}

async function saveHandoff (overrides = {}) {
    const body = await callTool('save_resource', {
        type: 'handoff-prompt',
        title: 'Fix the flaky auth test',
        content: 'Investigate why test/auth-oidc.test.js flakes under jest --runInBand and fix it.',
        target_agent: 'claude-code',
        epic: 'Tap Portability Layer',
        story: 'Auth',
        ...overrides
    })
    return parseResult(body)
}

describe('save_resource - handoff-prompt kind', () => {
    test('saves approved (auto-approve, exempt from gating) with task_status defaulted to open', async () => {
        const saved = await saveHandoff()
        expect(saved.status).toBe('approved')

        const full = parseResult(await callTool('get_resource', { id: saved.id }))
        expect(full.target_agent).toBe('claude-code')
        expect(full.task_status).toBe('open')
        expect(full.epic).toBe('Tap Portability Layer')
    })

    test('accepts an explicit non-default task_status', async () => {
        const saved = await saveHandoff({ task_status: 'in_progress' })
        const full = parseResult(await callTool('get_resource', { id: saved.id }))
        expect(full.task_status).toBe('in_progress')
    })

    test('rejects an invalid task_status value', async () => {
        const body = await callTool('save_resource', {
            type: 'handoff-prompt', title: 't', content: 'c', task_status: 'blocked'
        })
        expect(body.result.isError).toBe(true)
    })
})

describe('list_active_tasks', () => {
    test('returns open and in_progress handoffs, newest first, excludes done', async () => {
        const first = await saveHandoff({ title: 'Task A' })
        await new Promise(r => setTimeout(r, 2))
        const second = await saveHandoff({ title: 'Task B', task_status: 'in_progress' })
        const third = await saveHandoff({ title: 'Task C' })
        await callTool('set_task_status', { id: first.id, status: 'done' })

        const active = parseResult(await callTool('list_active_tasks', {}))
        const ids = active.map(t => t.id)
        expect(ids).toContain(second.id)
        expect(ids).toContain(third.id)
        expect(ids).not.toContain(first.id)
        // newest first
        expect(ids.indexOf(third.id)).toBeLessThan(ids.indexOf(second.id))
    })

    test('does not include non-handoff recipe kinds', async () => {
        await callTool('save_resource', { type: 'decision', title: 'not a handoff', content: 'x' })
        const active = parseResult(await callTool('list_active_tasks', {}))
        expect(active.find(t => t.title === 'not a handoff')).toBeUndefined()
    })
})

describe('set_task_status', () => {
    test('moves open -> in_progress -> done, and done removes it from list_active_tasks', async () => {
        const handoff = await saveHandoff()

        const toProgress = parseResult(await callTool('set_task_status', { id: handoff.id, status: 'in_progress' }))
        expect(toProgress.task_status).toBe('in_progress')

        const toDone = parseResult(await callTool('set_task_status', { id: handoff.id, status: 'done' }))
        expect(toDone.task_status).toBe('done')

        const active = parseResult(await callTool('list_active_tasks', {}))
        expect(active.find(t => t.id === handoff.id)).toBeUndefined()
    })

    test('rejects an unknown id', async () => {
        const body = await callTool('set_task_status', { id: 'does-not-exist', status: 'done' })
        expect(body.result.isError).toBe(true)
    })

    test('rejects a non-handoff resource', async () => {
        const saved = parseResult(await callTool('save_resource', { type: 'decision', title: 't', content: 'c', project: 'P' }))
        const body = await callTool('set_task_status', { id: saved.id, status: 'done' })
        expect(body.result.isError).toBe(true)
        expect(body.result.content[0].text).toMatch(/not a handoff-prompt/)
    })
})

describe('link_recipes', () => {
    test('records lineage from a handoff to the recipes it produced', async () => {
        const handoff = await saveHandoff()
        const decision = parseResult(await callTool('save_resource', { type: 'decision', title: 'outcome', content: 'x', project: 'P' }))

        const linked = parseResult(await callTool('link_recipes', { handoff_id: handoff.id, recipe_ids: [decision.id] }))
        expect(linked.linked_recipes).toEqual([decision.id])

        const full = parseResult(await callTool('get_resource', { id: handoff.id }))
        expect(full.linked_recipes).toEqual([decision.id])
    })

    test('accumulates without duplicating on repeated calls', async () => {
        const handoff = await saveHandoff()
        await callTool('link_recipes', { handoff_id: handoff.id, recipe_ids: ['a', 'b'] })
        const second = parseResult(await callTool('link_recipes', { handoff_id: handoff.id, recipe_ids: ['b', 'c'] }))
        expect(second.linked_recipes.sort()).toEqual(['a', 'b', 'c'])
    })

    test('rejects a non-handoff resource', async () => {
        const decision = parseResult(await callTool('save_resource', { type: 'decision', title: 't', content: 'c', project: 'P' }))
        const body = await callTool('link_recipes', { handoff_id: decision.id, recipe_ids: ['x'] })
        expect(body.result.isError).toBe(true)
    })
})

describe('export_as_skill tool', () => {
    test('exports an approved recipe as a prompt by default (after certify)', async () => {
        const saved = parseResult(await callTool('save_resource', { type: 'decision', title: 'Exportable', content: 'body text', project: 'P' }))
        await callTool('approve_resource', { id: saved.id }) // must be certified to export
        const exported = parseResult(await callTool('export_as_skill', { recipe_id: saved.id }))
        expect(exported.format).toBe('prompt')
        expect(exported.content).toContain('body text')
    })

    test('exports as a claude-skill SKILL.md when requested (after certify)', async () => {
        const saved = parseResult(await callTool('save_resource', { type: 'decision', title: 'Exportable', content: 'body text', project: 'P' }))
        await callTool('approve_resource', { id: saved.id })
        const exported = parseResult(await callTool('export_as_skill', { recipe_id: saved.id, format: 'claude-skill' }))
        expect(exported.filename).toBe('SKILL.md')
        expect(exported.content).toMatch(/^---/)
    })

    test('refuses to export an experimental (uncertified) recipe', async () => {
        const saved = parseResult(await callTool('save_resource', {
            type: 'architecture-diagram', title: 'Gated', content: 'graph TD;', format: 'mermaid', project: 'P'
        }))
        const body = await callTool('export_as_skill', { recipe_id: saved.id })
        expect(body.result.isError).toBe(true)
        expect(body.result.content[0].text).toMatch(/experimental/i)
    })

    test('errors clearly for an unknown recipe id', async () => {
        const body = await callTool('export_as_skill', { recipe_id: 'no-such-id' })
        expect(body.result.isError).toBe(true)
    })
})

describe('server instructions mention handoff prompts', () => {
    test('initialize instructions reference handoff-prompt and target_agent', async () => {
        const body = await rpc('initialize', {
            protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' }
        })
        expect(body.result.instructions).toMatch(/handoff-prompt/)
        expect(body.result.instructions).toMatch(/target_agent/)
    })
})

describe('use-recipe prompt', () => {
    test('prompts/get renders a message that calls export_as_skill with the given id', async () => {
        const body = await rpc('prompts/get', { name: 'use-recipe', arguments: { recipe_id: 'decision-example-1' } })
        expect(body.result.messages[0].content.text).toContain('export_as_skill')
        expect(body.result.messages[0].content.text).toContain('decision-example-1')
    })
})
