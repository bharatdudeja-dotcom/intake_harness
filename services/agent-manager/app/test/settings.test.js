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
 * Increment 12 (D48): editable settings - get_settings / update_settings, the store-backed
 * override layered on config/settings.json, and that retention_days actually takes effect
 * (a fresh step's expiry follows the edited window). Driven through main() so the
 * per-request settings.refresh() in the host wrapper is exercised end to end.
 */

jest.mock('@adobe/aio-lib-files')

const filesLib = require('@adobe/aio-lib-files')

const TEST_API_KEY = 'test-api-key'

beforeEach(() => {
    const data = new Map()
    filesLib.init = jest.fn(async () => ({
        // Real aio-lib-files list(path) does prefix listing when path ends with "/";
        // otherwise it is an existence check for a single file.
        list: jest.fn(async (path) => {
            if (path.endsWith('/')) return [...data.keys()].filter(k => k.startsWith(path)).map(name => ({ name }))
            return data.has(path) ? [{ name: path }] : []
        }),
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

describe('get_settings (D48)', () => {
    test('returns the default retention window plus editable segmentation levels and kinds', async () => {
        const s = parseResult(await callTool('get_settings', {}))
        expect(s.retention_days).toBe(30)
        expect(s.segmentation_levels.map(l => l.key)).toEqual(['project', 'epic', 'story'])
        expect(s.kinds.some(k => k.type === 'decision')).toBe(true)
    })

    test('exposes the seeded Head Chef roster (D64)', async () => {
        const s = parseResult(await callTool('get_settings', {}))
        expect(s.head_chefs).toContain('service-account')
    })
})

describe('Head Chef roster settings (D64)', () => {
    test('set_head_chefs replaces the roster and get_role reflects the new membership', async () => {
        // default: service-account is a head-chef
        expect(parseResult(await callTool('get_role', {})).role).toBe('head-chef')

        await callTool('set_head_chefs', { head_chefs: ['alice@example.com'] })
        const role = parseResult(await callTool('get_role', {}))
        expect(role.role).toBe('chef') // service-account no longer on the roster
        expect(role.head_chefs).toEqual(['alice@example.com'])

        const s = parseResult(await callTool('get_settings', {}))
        expect(s.head_chefs).toEqual(['alice@example.com'])
    })

    test('set_head_chefs dedupes and trims', async () => {
        const out = parseResult(await callTool('set_head_chefs', { head_chefs: [' a ', 'a', 'b'] }))
        expect(out.head_chefs).toEqual(['a', 'b'])
    })
})

describe('update_settings (D48)', () => {
    test('editing retention_days persists and actually takes effect on a new step\'s expiry', async () => {
        const updated = parseResult(await callTool('update_settings', { retention_days: 7 }))
        expect(updated.retention_days).toBe(7)

        const after = parseResult(await callTool('get_settings', {}))
        expect(after.retention_days).toBe(7)

        // a freshly appended experimental step should now expire ~7 days out, not 30
        const recipe = parseResult(await callTool('start_recipe', { project: 'Retention Edit', title: 'r' }))
        const before = Date.now()
        const step = parseResult(await callTool('append_step', { recipe_id: recipe.id, kind: 'message', content: 'x', source: 'other' }))
        const days = (new Date(step.expires_at).getTime() - before) / (24 * 60 * 60 * 1000)
        expect(days).toBeGreaterThan(6.9)
        expect(days).toBeLessThan(7.1)
    })

    test('a segmentation label override is reflected by get_segmentation_config', async () => {
        await callTool('update_settings', { segmentation_labels: { epic: 'Workstream' } })
        const cfg = parseResult(await callTool('get_segmentation_config', {}))
        const epic = cfg.levels.find(l => l.key === 'epic')
        expect(epic.label).toBe('Workstream')
        // internal key is unchanged
        expect(cfg.levels.map(l => l.key)).toEqual(['project', 'epic', 'story'])
    })

    test('a kind label override is reflected by get_resource_policy', async () => {
        await callTool('update_settings', { kind_labels: { decision: 'ADR' } })
        const policy = parseResult(await callTool('get_resource_policy', {}))
        expect(policy.find(t => t.type === 'decision').title).toBe('ADR')
    })

    test('partial updates do not clobber previously-set overrides', async () => {
        await callTool('update_settings', { retention_days: 14 })
        await callTool('update_settings', { segmentation_labels: { story: 'Ticket' } })
        const s = parseResult(await callTool('get_settings', {}))
        expect(s.retention_days).toBe(14)
        expect(s.segmentation_levels.find(l => l.key === 'story').label).toBe('Ticket')
    })

    test('rejects an unknown segmentation level key', async () => {
        const result = await callTool('update_settings', { segmentation_labels: { nope: 'X' } })
        expect(result.result.isError).toBe(true)
    })

    test('rejects an unknown kind id', async () => {
        const result = await callTool('update_settings', { kind_labels: { not_a_kind: 'X' } })
        expect(result.result.isError).toBe(true)
    })
})

describe('admin_reset_data (D52)', () => {
    test('requires confirm=true; wipes recipes and projects but keeps settings', async () => {
        // seed a project + a recipe + a settings override
        await callTool('update_settings', { retention_days: 21 })
        await callTool('start_project', { name: 'Doomed Project' })
        const rec = parseResult(await callTool('start_recipe', { project: 'Doomed Project', title: 'to be wiped' }))
        await callTool('append_step', { recipe_id: rec.id, kind: 'message', content: 'x', source: 'other' })

        // guard: confirm must be true
        const guarded = await callTool('admin_reset_data', { confirm: false })
        expect(guarded.result.isError).toBe(true)

        const reset = parseResult(await callTool('admin_reset_data', { confirm: true }))
        expect(reset.reset).toBe(true)
        expect(reset.recipes).toBeGreaterThanOrEqual(1)

        // everything gone
        expect(parseResult(await callTool('list_recipes', {}))).toHaveLength(0)
        expect(parseResult(await callTool('list_projects', {}))).toHaveLength(0)
        // config (settings override) preserved
        expect(parseResult(await callTool('get_settings', {})).retention_days).toBe(21)
    })
})
