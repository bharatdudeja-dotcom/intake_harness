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
 * Increment 9 (D42) model-foundation tests: experimental-by-default + consent,
 * configurable segmentation + per-conversation project, update-not-duplicate
 * (version/history/reapprove-on-change), token accumulation, and owner - driven
 * end to end through main() like the other MCP tests.
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
const statusLib = require('../lib/status')

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

describe('status aliases (lib/status)', () => {
    test('old and new spellings collapse to the same canonical value', () => {
        expect(statusLib.canonical('pending')).toBe('experimental')
        expect(statusLib.canonical('experimental')).toBe('experimental')
        expect(statusLib.canonical('active')).toBe('approved')
        expect(statusLib.canonical('approved')).toBe('approved')
        expect(statusLib.statusMatches('active', 'approved')).toBe(true)
        expect(statusLib.statusMatches('pending', 'experimental')).toBe(true)
        expect(statusLib.statusMatches('approved', 'experimental')).toBe(false)
    })
})

describe('get_segmentation_config', () => {
    test('returns the default ordered levels project -> epic -> story', async () => {
        const cfg = parseResult(await callTool('get_segmentation_config', {}))
        expect(cfg.levels.map(l => l.key)).toEqual(['project', 'epic', 'story'])
        expect(cfg.levels[0].label).toBe('Project')
    })
})

describe('experimental-by-default + consent (D38)', () => {
    test('a save with no status is experimental and excluded from resources/list until certified', async () => {
        const saved = parseResult(await callTool('save_resource', { type: 'decision', title: 'X', content: 'c', project: 'P' }))
        expect(saved.status).toBe('experimental')

        let list = (await rpc('resources/list')).result.resources.map(r => r.uri)
        expect(list).not.toContain(`resource://company/decision/${saved.id}`)

        const certified = parseResult(await callTool('certify', { id: saved.id, note: 'ok' }))
        expect(certified.status).toBe('approved')
        expect(certified.approved_by).toBe('service-account')
        expect(certified.approved_at).toBeDefined()

        list = (await rpc('resources/list')).result.resources.map(r => r.uri)
        expect(list).toContain(`resource://company/decision/${saved.id}`)
    })
})

describe('per-conversation project (D39)', () => {
    test('start_project sets the active project; subsequent saves inherit it; filtering isolates projects', async () => {
        const proj = parseResult(await callTool('start_project', { name: 'Alpha Engagement', note: 'first' }))
        expect(proj.id).toBe('project-alpha-engagement')

        const a = parseResult(await callTool('save_resource', { type: 'decision', title: 'a1', content: 'x' }))
        const fullA = parseResult(await callTool('get_resource', { id: a.id }))
        expect(fullA.segments.project).toBe('Alpha Engagement')

        // switch project
        await callTool('start_project', { name: 'Beta Engagement' })
        const b = parseResult(await callTool('save_resource', { type: 'decision', title: 'b1', content: 'y' }))

        const alphaOnly = parseResult(await callTool('list_resources', { project: 'Alpha Engagement' }))
        expect(alphaOnly.map(r => r.id)).toContain(a.id)
        expect(alphaOnly.map(r => r.id)).not.toContain(b.id)
    })

    test('start_project selects (does not duplicate) an existing project of the same name', async () => {
        const first = parseResult(await callTool('start_project', { name: 'Repeated' }))
        const second = parseResult(await callTool('start_project', { name: 'Repeated' }))
        expect(second.id).toBe(first.id)
        expect(second.selected).toBe(true)
    })

    test('save_resource accepts a generic segments map', async () => {
        const saved = parseResult(await callTool('save_resource', {
            type: 'decision', title: 'segmapped', content: 'x', segments: { project: 'SegProj', epic: 'E9', story: 'S9' }
        }))
        const full = parseResult(await callTool('get_resource', { id: saved.id }))
        expect(full.segments).toEqual({ project: 'SegProj', epic: 'E9', story: 'S9' })
    })
})

describe('update-not-duplicate: version, history, reapprove-on-change (D38/D39)', () => {
    test('a material change to an approved recipe bumps version, keeps history, and reverts to experimental', async () => {
        const saved = parseResult(await callTool('save_resource', { type: 'decision', title: 'evolving', content: 'v1', id: 'decision-evolving', project: 'P' }))
        await callTool('certify', { id: saved.id })
        const approved = parseResult(await callTool('get_resource', { id: saved.id }))
        expect(statusLib.isApproved(approved.status)).toBe(true)

        // material change (content differs) -> version 2, back to experimental for re-consent
        const updated = parseResult(await callTool('save_resource', { type: 'decision', title: 'evolving', content: 'v2 different', id: 'decision-evolving', project: 'P' }))
        expect(updated.version).toBe(2)
        expect(updated.reapproved_to_experimental).toBe(true)

        const full = parseResult(await callTool('get_resource', { id: saved.id }))
        expect(full.status).toBe('experimental')
        expect(full.history).toHaveLength(1)
        expect(full.history[0].status).toBe('approved') // prior approval preserved in lineage
    })

    test('a metadata-only re-save (same content) does NOT bump version or re-trigger approval', async () => {
        const saved = parseResult(await callTool('save_resource', { type: 'decision', title: 't', content: 'same', id: 'decision-meta', project: 'P' }))
        await callTool('certify', { id: saved.id })

        // re-save identical content with an added tag -> metadata update, still approved, version 1
        const again = parseResult(await callTool('save_resource', { type: 'decision', title: 't', content: 'same', id: 'decision-meta', project: 'P', tags: ['added'] }))
        expect(again.version).toBe(1)
        expect(again.reapproved_to_experimental).toBeUndefined()

        const full = parseResult(await callTool('get_resource', { id: saved.id }))
        expect(statusLib.isApproved(full.status)).toBe(true)
        expect(full.tags).toEqual(['added'])
    })
})

describe('token accumulation (D39)', () => {
    test('tokens_used accumulates across saves; tokens_last tracks the delta', async () => {
        const saved = parseResult(await callTool('save_resource', { type: 'decision', title: 'costed', content: 'v1', id: 'decision-costed', project: 'P', tokens_used: 100 }))
        let full = parseResult(await callTool('get_resource', { id: saved.id }))
        expect(full.tokens_used).toBe(100)
        expect(full.tokens_last).toBe(100)

        await callTool('save_resource', { type: 'decision', title: 'costed', content: 'v2 changed', id: 'decision-costed', project: 'P', tokens_used: 40 })
        full = parseResult(await callTool('get_resource', { id: saved.id }))
        expect(full.tokens_used).toBe(140) // 100 + 40
        expect(full.tokens_last).toBe(40)
    })
})

describe('owner (D40)', () => {
    test('owner is the service principal on the x-api-key path and is filterable', async () => {
        const saved = parseResult(await callTool('save_resource', { type: 'decision', title: 'owned', content: 'x', project: 'P' }))
        const full = parseResult(await callTool('get_resource', { id: saved.id }))
        expect(full.owner).toBe('service-account')

        const mine = parseResult(await callTool('list_resources', { owner: 'service-account' }))
        expect(mine.map(r => r.id)).toContain(saved.id)
        const others = parseResult(await callTool('list_resources', { owner: 'someone-else' }))
        expect(others.map(r => r.id)).not.toContain(saved.id)
    })
})

describe('find_similar (D39)', () => {
    test('surfaces an existing recipe so the AI updates instead of duplicating', async () => {
        const saved = parseResult(await callTool('save_resource', { type: 'decision', title: 'Use Auth0 for OIDC', content: 'chose auth0', project: 'P' }))
        const matches = parseResult(await callTool('find_similar', { query: 'Auth0' }))
        expect(matches.map(m => m.id)).toContain(saved.id)
        expect(matches[0]).toHaveProperty('status')
        expect(matches[0]).toHaveProperty('segments')
    })
})
