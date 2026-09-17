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
 * D79: practice / capability groups (so AEM knowledge stays findable by AEM consultants) and the
 * exclusive read-only `viewer` role. Driven through the real tool path with per-entity API keys,
 * which is also how the multi-entity auth workaround is exercised.
 */

jest.mock('@adobe/aio-lib-files')
const filesLib = require('@adobe/aio-lib-files')

let data
beforeEach(() => {
    data = new Map()
    filesLib.init = jest.fn(async () => ({
        list: jest.fn(async (path) => path.endsWith('/')
            ? [...data.keys()].filter(k => k.startsWith(path)).map(name => ({ name }))
            : (data.has(path) ? [{ name: path }] : [])),
        read: jest.fn(async (path) => data.get(path)),
        write: jest.fn(async (path, content) => { const b = Buffer.isBuffer(content) ? content : Buffer.from(content); data.set(path, b); return b.length }),
        delete: jest.fn(async (path) => { data.delete(path); return [] })
    }))
})

const { main } = require('../actions/mcp-server/index.js')
const settings = require('../lib/settings')

const SERVICE_KEY = 'svc-key'
const K = {
    alice: 'k-alice',
    bob: 'k-bob',
    bharat: 'k-bharat',
    viewer: 'k-viewer'
}
const API_KEY_OWNERS = JSON.stringify({
    [K.alice]: { userId: 'alice', email: 'alice@a.example', roles: ['chef'] },
    [K.bob]: { userId: 'bob', email: 'bob@b.example', roles: ['chef'] },
    [K.bharat]: { userId: 'bharat', email: 'bharat@tap.example', roles: ['chef', 'head-chef', 'admin'] },
    [K.viewer]: { userId: 'viewer', email: 'viewer@demo.example', roles: ['viewer'] }
})

/** Call a tool as a given entity's key. */
async function asKey (key, name, args = {}) {
    const res = await main({
        SERVICE_API_KEY: SERVICE_KEY,
        API_KEY_OWNERS,
        LOG_LEVEL: 'error',
        __ow_method: 'post',
        __ow_headers: { 'x-api-key': key, host: 'unit.test' },
        __ow_body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    })
    return JSON.parse(res.body).result
}
/** Parsed JSON payload of a successful tool call. */
const okJson = (result) => JSON.parse(result.content[0].text)

describe('per-entity API keys resolve distinct identities + roles (D79)', () => {
    test('each key resolves to its own owner with its seeded roles', async () => {
        expect(okJson(await asKey(K.alice, 'get_my_roles'))).toEqual({ owner: 'alice@a.example', roles: ['chef'] })
        expect(okJson(await asKey(K.bob, 'get_my_roles'))).toEqual({ owner: 'bob@b.example', roles: ['chef'] })
        expect(okJson(await asKey(K.bharat, 'get_my_roles'))).toEqual({ owner: 'bharat@tap.example', roles: ['chef', 'head-chef', 'admin'] })
    })

    test('viewer is EXCLUSIVE - it never widens into chef', async () => {
        expect(okJson(await asKey(K.viewer, 'get_my_roles'))).toEqual({ owner: 'viewer@demo.example', roles: ['viewer'] })
    })

    test('an unmapped key is rejected outright', async () => {
        const res = await main({
            SERVICE_API_KEY: SERVICE_KEY,
            API_KEY_OWNERS,
            LOG_LEVEL: 'error',
            __ow_method: 'post',
            __ow_headers: { 'x-api-key': 'not-a-real-key', host: 'unit.test' },
            __ow_body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_my_roles', arguments: {} } })
        })
        expect(res.statusCode).toBe(401)
    })
})

describe('viewer is read-only at a single choke point (D79)', () => {
    test('viewer may READ', async () => {
        const res = await asKey(K.viewer, 'list_jobs', {})
        expect(res.isError).toBeFalsy()
    })

    test.each([
        ['start_project', { name: 'X' }],
        ['start_job', { project: 'X', title: 'T' }],
        ['append_step', { job_id: 'r', kind: 'message', content: 'c' }],
        ['bake_job', { id: 'r' }],
        ['approve_step', { step_id: 'r::s0' }],
        ['set_user_roles', { owner: 'x', roles: ['admin'] }],
        ['set_practices', { practices: [{ id: 'x', label: 'X' }] }],
        ['admin_reset_data', { confirm: true }]
    ])('viewer is REFUSED the write tool %s', async (tool, args) => {
        const res = await asKey(K.viewer, tool, args)
        expect(res.isError).toBe(true)
        expect(res.content[0].text).toMatch(/read-only \(viewer\)/i)
    })

    test('a chef is NOT blocked by the read-only gate', async () => {
        const res = await asKey(K.alice, 'start_project', { name: 'Alice Proj' })
        expect(res.isError).toBeFalsy()
    })
})

describe('practices: config, per-user assignment, inheritance, filtering (D79)', () => {
    test('list_practices exposes the configured groups and the caller\'s own', async () => {
        const out = okJson(await asKey(K.alice, 'list_practices'))
        expect(out.practices.map(p => p.id)).toEqual(expect.arrayContaining(['workfront', 'aep', 'aem']))
        expect(out.my_practices).toEqual([]) // none assigned yet
    })

    test('a head-chef/admin assigns practices; a plain chef cannot', async () => {
        const refused = await asKey(K.alice, 'set_user_practices', { owner: 'alice@a.example', practices: ['aem'] })
        expect(refused.isError).toBe(true)
        expect(refused.content[0].text).toMatch(/only a Head Chef or admin/i)

        const ok = okJson(await asKey(K.bharat, 'set_user_practices', { owner: 'alice@a.example', practices: ['aem'] }))
        expect(ok.practices).toEqual(['aem'])
    })

    test('an unknown practice id is rejected, not silently stored', async () => {
        const res = await asKey(K.bharat, 'set_user_practices', { owner: 'alice@a.example', practices: ['nope'] })
        expect(res.isError).toBe(true)
        expect(res.content[0].text).toMatch(/Unknown practice id/i)
    })

    test('a new job INHERITS the consultant\'s practice with zero extra effort', async () => {
        await asKey(K.bharat, 'set_user_practices', { owner: 'alice@a.example', practices: ['aem'] })
        const rec = okJson(await asKey(K.alice, 'start_job', { project: 'P', title: 'AEM work' }))
        expect(rec.practice).toBe('aem')
    })

    test('an explicit practice overrides the inherited one; an unknown one errors', async () => {
        await asKey(K.bharat, 'set_user_practices', { owner: 'alice@a.example', practices: ['aem'] })
        const rec = okJson(await asKey(K.alice, 'start_job', { project: 'P', title: 'Braze work', practice: 'workfront' }))
        expect(rec.practice).toBe('workfront')

        const bad = await asKey(K.alice, 'start_job', { project: 'P', title: 'Bogus', practice: 'not-a-practice' })
        expect(bad.isError).toBe(true)
        expect(bad.content[0].text).toMatch(/Unknown practice/i)
    })

    test('list_jobs filters by practice, so one discipline sees just its own knowledge', async () => {
        await asKey(K.bharat, 'set_user_practices', { owner: 'alice@a.example', practices: ['aem'] })
        await asKey(K.alice, 'start_job', { project: 'P', title: 'AEM one' })
        await asKey(K.alice, 'start_job', { project: 'P', title: 'Braze one', practice: 'workfront' })

        const aem = okJson(await asKey(K.alice, 'list_jobs', { practice: 'aem' }))
        const braze = okJson(await asKey(K.alice, 'list_jobs', { practice: 'workfront' }))
        expect(aem.map(r => r.title)).toEqual(['AEM one'])
        expect(braze.map(r => r.title)).toEqual(['Braze one'])
    })

    test('set_practices is admin-only and rejects duplicate ids', async () => {
        expect((await asKey(K.alice, 'set_practices', { practices: [{ id: 'x', label: 'X' }] })).isError).toBe(true)
        const dupe = await asKey(K.bharat, 'set_practices', { practices: [{ id: 'a', label: 'A' }, { id: 'a', label: 'A2' }] })
        expect(dupe.isError).toBe(true)
        expect(dupe.content[0].text).toMatch(/Duplicate practice id/i)
        const ok = okJson(await asKey(K.bharat, 'set_practices', { practices: [{ id: 'analytics', label: 'Analytics' }] }))
        expect(ok.practices).toEqual([{ id: 'analytics', label: 'Analytics' }])
    })
})

describe('WRITE_TOOLS covers every registered state-changing tool (D79 guard integrity)', () => {
    test('no tool that writes is missing from the read-only gate', async () => {
        // Any tool whose name implies mutation must be gated; catches a future write tool that
        // forgets to register itself in WRITE_TOOLS and would silently bypass viewer read-only.
        const res = await main({
            SERVICE_API_KEY: SERVICE_KEY, API_KEY_OWNERS, LOG_LEVEL: 'error',
            __ow_method: 'post', __ow_headers: { 'x-api-key': SERVICE_KEY, host: 'unit.test' },
            __ow_body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        })
        const names = JSON.parse(res.body).result.tools.map(t => t.name)
        const mutating = names.filter(n => /^(save|start|append|approve|certify|discard|bake|set|update|link|purge|rebuild|admin_reset|headchef)/.test(n))
        const { WRITE_TOOLS } = require('../actions/mcp-server/tools.js')
        const missing = mutating.filter(n => !WRITE_TOOLS.has(n))
        expect(missing).toEqual([])
    })
})

afterEach(() => settings._setCache({}))

describe('update-in-place must not silently drop fields (D79 bugfixes)', () => {
    /** The exact sequence the E2E surfaced: create -> bake -> admit to CX -> refine again. */
    test('cx_approved SURVIVES a save_resource update (was: silently evicted from the CX graph)', async () => {
        await asKey(K.bharat, 'set_user_practices', { owner: 'alice@a.example', practices: ['aem'] })
        const rec = okJson(await asKey(K.alice, 'start_job', { project: 'P', title: 'CX survivor' }))
        const step = okJson(await asKey(K.alice, 'append_step', { job_id: rec.id, kind: 'decision', content: 'd', source: 's' }))
        await asKey(K.alice, 'approve_step', { step_id: step.id })
        await asKey(K.alice, 'bake_job', { id: rec.id })
        await asKey(K.bharat, 'headchef_approve', { job_id: rec.id })

        // Refine the SAME job in place - this used to wipe cx_approved.
        await asKey(K.alice, 'save_resource', { id: rec.id, type: 'decision', title: 'CX survivor', content: 'refined', project: 'P' })

        const full = okJson(await asKey(K.bharat, 'get_resource', { id: rec.id }))
        expect(full.cx_approved).toBe(true)
        expect(full.cx_approved_by).toBeTruthy()
    })

    test('practice SURVIVES a save_resource update (was: job vanished from its practice filter)', async () => {
        await asKey(K.bharat, 'set_user_practices', { owner: 'alice@a.example', practices: ['aem'] })
        const rec = okJson(await asKey(K.alice, 'start_job', { project: 'P', title: 'Practice survivor' }))
        expect(rec.practice).toBe('aem')

        await asKey(K.alice, 'save_resource', { id: rec.id, type: 'decision', title: 'Practice survivor', content: 'refined', project: 'P' })

        const stillAem = okJson(await asKey(K.alice, 'list_jobs', { practice: 'aem' }))
        expect(stillAem.map(r => r.id)).toContain(rec.id)
    })

    test('a job created via save_resource inherits the practice too', async () => {
        await asKey(K.bharat, 'set_user_practices', { owner: 'bob@b.example', practices: ['workfront'] })
        const saved = okJson(await asKey(K.bob, 'save_resource', { type: 'decision', title: 'Braze decision', content: 'c', project: 'BP' }))
        const listed = okJson(await asKey(K.bob, 'list_jobs', { practice: 'workfront' }))
        expect(listed.map(r => r.id)).toContain(saved.id)
    })
})

describe('headchef_reject candidate gate (D79 bugfix)', () => {
    test('refuses a NON-baked job - it was never a CX candidate', async () => {
        const rec = okJson(await asKey(K.bob, 'start_job', { project: 'BP', title: 'Not baked' }))
        const res = await asKey(K.bharat, 'headchef_reject', { job_id: rec.id })
        expect(res.isError).toBe(true)
        expect(res.content[0].text).toMatch(/not baked|not a CX candidate/i)
    })

    test('still allows holding back a genuinely baked candidate', async () => {
        const rec = okJson(await asKey(K.alice, 'start_job', { project: 'P', title: 'Baked then held' }))
        const step = okJson(await asKey(K.alice, 'append_step', { job_id: rec.id, kind: 'decision', content: 'd', source: 's' }))
        await asKey(K.alice, 'approve_step', { step_id: step.id })
        await asKey(K.alice, 'bake_job', { id: rec.id })
        const res = okJson(await asKey(K.bharat, 'headchef_reject', { job_id: rec.id }))
        expect(res.cx_approved).toBe(false)
    })
})
