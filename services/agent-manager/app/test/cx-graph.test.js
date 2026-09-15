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
 * Increment 14 Part 3 (D40/D53): multi-tenant owner isolation (store-level, with seeded
 * owners) + the company CX Knowledge Graph compiler (cross-owner, approved-only), plus the
 * get_cx_graph / rebuild_cx_graph tool path driven through main().
 */

jest.mock('@adobe/aio-lib-files')
const filesLib = require('@adobe/aio-lib-files')

let data
beforeEach(() => {
    data = new Map()
    filesLib.init = jest.fn(async () => ({
        list: jest.fn(async (path) => path.endsWith('/') ? [...data.keys()].filter(k => k.startsWith(path)).map(name => ({ name })) : (data.has(path) ? [{ name: path }] : [])),
        read: jest.fn(async (path) => data.get(path)),
        write: jest.fn(async (path, content) => { const buf = Buffer.isBuffer(content) ? content : Buffer.from(content); data.set(path, buf); return buf.length }),
        delete: jest.fn(async (path) => { data.delete(path); return [] })
    }))
})

const store = require('../lib/store')
const cxGraph = require('../lib/cx-graph')

function seed (id, owner, status, extra = {}) {
    return store.saveResource({ id, title: id, type: extra.type || 'decision', content: id, owner, status, segments: extra.segments, tags: extra.tags, ...extra })
}

describe('multi-tenant owner isolation (D53, tightened in D86) - store level', () => {
    /*
     * This test previously asserted that any recipe whose status canonicalised to "approved" was
     * visible to everyone. That was the bug, not the specification: approving one ingredient
     * auto-promotes its recipe, so a working draft became company-visible the moment its author
     * approved a single ingredient of it. The rule is now four explicit cases, asserted below.
     */
    test('a personal view sees own work only, not a colleague approved-but-unsubmitted draft', async () => {
        await seed('a1', 'alice', 'approved', { tags: ['x'] })
        await seed('c1', 'alice', 'experimental')
        await seed('b1', 'bob', 'approved', { tags: ['x'] })
        await seed('b2', 'bob', 'experimental')

        expect((await store.listResources({ visibleTo: 'alice' })).map(r => r.id).sort()).toEqual(['a1', 'c1'])
        expect((await store.listResources({ visibleTo: 'bob' })).map(r => r.id).sort()).toEqual(['b1', 'b2'])
    })

    test('CX-admitted work is visible to everyone', async () => {
        await seed('a1', 'alice', 'approved')
        await seed('b1', 'bob', 'approved', { baked: true, cx_approved: true })

        expect((await store.listResources({ visibleTo: 'alice' })).map(r => r.id).sort()).toEqual(['a1', 'b1'])
    })

    test('SUBMITTED (baked) work is visible only to a reviewer', async () => {
        await seed('a1', 'alice', 'approved')
        await seed('b1', 'bob', 'baked', { baked: true })

        // A peer sees only their own.
        expect((await store.listResources({ visibleTo: 'alice' })).map(r => r.id)).toEqual(['a1'])
        // A head chef or admin must see the candidate in order to review it.
        expect((await store.listResources({ visibleTo: 'alice', visibleSubmitted: true })).map(r => r.id).sort()).toEqual(['a1', 'b1'])
    })

    test('an ASSIGNED recipe is visible to its assignee, and to nobody else', async () => {
        await seed('b1', 'bob', 'experimental', { assigned_to: ['alice'] })
        await seed('b2', 'bob', 'experimental')

        expect((await store.listResources({ visibleTo: 'alice' })).map(r => r.id)).toEqual(['b1'])
        expect((await store.listResources({ visibleTo: 'carol' })).map(r => r.id)).toEqual([])
    })

    test('listProjects owner filter scopes to the caller (approved recipes aside)', async () => {
        await store.upsertProjectByName({ name: 'Alice Proj', owner: 'alice' })
        await store.upsertProjectByName({ name: 'Bob Proj', owner: 'bob' })
        expect((await store.listProjects({ owner: 'alice' })).map(p => p.name)).toEqual(['Alice Proj'])
        expect((await store.listProjects()).length).toBe(2)
    })
})

describe('CX graph compiler (D40/D53/D64) - cross-owner, approved + Head Chef-admitted only', () => {
    test('includes cx_approved recipes across owners, excludes experimental, links shared tag/segment', async () => {
        await seed('a1', 'alice', 'approved', { tags: ['auth'], segments: { project: 'P1' }, cx_approved: true })
        await seed('b1', 'bob', 'approved', { tags: ['auth'], segments: { project: 'P1' }, cx_approved: true })
        await seed('c1', 'carol', 'experimental', { tags: ['auth'], segments: { project: 'P1' } })

        const g = await cxGraph.buildCxGraph('2026-07-06T00:00:00.000Z')
        expect(g.approved_only).toBe(true)
        expect(g.cross_owner).toBe(true)
        expect(g.generated_at).toBe('2026-07-06T00:00:00.000Z')
        expect(g.recipe_count).toBe(2)
        expect(g.owners.sort()).toEqual(['alice', 'bob'])
        const recipeNodeIds = g.nodes.filter(n => n.node === 'recipe').map(n => n.id).sort()
        expect(recipeNodeIds).toEqual(['a1', 'b1'])
        expect(g.nodes.some(n => n.id === 'c1')).toBe(false) // experimental excluded
        expect(g.edges.some(e => e.rel === 'shared-tag' && e.tag === 'auth')).toBe(true)
        expect(g.edges.some(e => e.rel === 'shared-segment' && e.segment === 'P1')).toBe(true)
    })

    test('D64: an approved recipe that is NOT cx_approved is excluded (baking alone does not admit it)', async () => {
        await seed('a1', 'alice', 'approved', { cx_approved: true }) // Head Chef admitted
        await seed('b1', 'bob', 'approved', { baked: true }) // baked/approved but NOT cx_approved
        await seed('c1', 'carol', 'approved') // approved, no cx flag at all

        const g = await cxGraph.buildCxGraph('2026-07-06T00:00:00.000Z')
        expect(g.recipe_count).toBe(1)
        const recipeNodeIds = g.nodes.filter(n => n.node === 'recipe').map(n => n.id)
        expect(recipeNodeIds).toEqual(['a1'])
        expect(g.nodes.some(n => n.id === 'b1')).toBe(false)
        expect(g.nodes.some(n => n.id === 'c1')).toBe(false)
    })

    test('rebuildAndStore persists a graph that getCxGraph reads back', async () => {
        await seed('a1', 'alice', 'approved', { tags: ['t'], cx_approved: true })
        const built = await cxGraph.rebuildAndStore('2026-07-06T00:00:00.000Z')
        const read = await store.getCxGraph()
        expect(read.generated_at).toBe(built.generated_at)
        expect(read.recipe_count).toBe(1)
    })

    test('a handoff-prompt linked to a cx_approved recipe appears as a lineage node/edge (D54)', async () => {
        await seed('a1', 'alice', 'approved', { cx_approved: true })
        await store.saveResource({ id: 'h1', title: 'a handoff', type: 'handoff-prompt', content: 'do it', owner: 'alice', status: 'approved', linked_recipes: ['a1'] })

        const g = await cxGraph.buildCxGraph('2026-07-06T00:00:00.000Z')
        expect(g.nodes.some(n => n.node === 'handoff' && n.id === 'h1')).toBe(true)
        expect(g.edges.some(e => e.rel === 'lineage' && e.from === 'h1' && e.to === 'a1')).toBe(true)
        expect(g.recipe_count).toBe(1) // the handoff never counts as a "recipe"
    })

    test('an ingredient node carries its steering signal (for steered-recipe styling)', async () => {
        const rec = { id: 'a1', title: 'a1', type: 'decision', content: 'x', owner: 'alice', status: 'approved', cx_approved: true, steps: [{ id: 'a1::s0', order: 0, kind: 'steering', signal: 'correct', status: 'approved', content: 'fixed it' }] }
        await store.saveResource(rec)
        const g = await cxGraph.buildCxGraph('2026-07-06T00:00:00.000Z')
        const ingr = g.nodes.find(n => n.node === 'ingredient' && n.id === 'a1::s0')
        expect(ingr.signal).toBe('correct')
    })

    test('an empty cookbook yields an empty (but valid) graph', async () => {
        const g = await cxGraph.buildCxGraph('2026-07-06T00:00:00.000Z')
        expect(g.recipe_count).toBe(0)
        expect(g.nodes).toEqual([])
        expect(g.edges).toEqual([])
    })
})

describe('admin cross-owner tools (D55)', () => {
    const { main } = require('../actions/mcp-server/index.js')
    const KEY = 'k'
    async function callTool (name, args) {
        const res = await main({ SERVICE_API_KEY: KEY, __ow_headers: { 'x-api-key': KEY, host: 'unit.test' }, LOG_LEVEL: 'error', __ow_method: 'post', __ow_body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
        return JSON.parse(JSON.parse(res.body).result.content[0].text)
    }

    /*
     * These two tests previously asserted that admin_list_recipes returned every recipe in the
     * company regardless of state. That assertion WAS the bug (D98): an admin read everybody's
     * private drafts. The cross-owner view now shows work people chose to submit, plus admitted
     * work, plus the caller's own, and the tests say so.
     */
    test('admin_list_recipes spans owners for SUBMITTED and ADMITTED work', async () => {
        await seed('a1', 'alice', 'baked', { baked: true })
        await seed('b1', 'bob', 'approved', { baked: true, cx_approved: true })

        // NOTE: this suite authenticates with the service key, and that principal sits on the
        // seeded head-chef roster, so it is a REVIEWER. It therefore sees the submitted candidate
        // in the personal view too, which is correct. The peer case (a plain chef who must NOT see
        // a submitted candidate) is covered in test/users-and-logins.test.js.
        const admin = await callTool('admin_list_recipes', {})
        expect(admin.map(r => r.id)).toEqual(expect.arrayContaining(['a1', 'b1']))
    })

    test('admin_list_recipes does NOT expose an unsubmitted draft, whatever filter is used', async () => {
        await seed('a2', 'alice', 'experimental')
        await seed('a3', 'alice', 'approved') // approved ingredients, never baked: still private
        await seed('b2', 'bob', 'baked', { baked: true })

        const all = await callTool('admin_list_recipes', {})
        expect(all.map(r => r.id)).not.toContain('a2')
        expect(all.map(r => r.id)).not.toContain('a3')
        expect(all.map(r => r.id)).toContain('b2')

        // Naming the owner does not unlock their drafts either.
        const aliceOnly = await callTool('admin_list_recipes', { owner: 'alice' })
        expect(aliceOnly.map(r => r.id)).not.toContain('a2')
        expect(aliceOnly.map(r => r.id)).not.toContain('a3')
    })

    test('admin_list_projects lists project records across all owners', async () => {
        await store.upsertProjectByName({ name: 'Alice P', owner: 'alice' })
        await store.upsertProjectByName({ name: 'Bob P', owner: 'bob' })
        const all = await callTool('admin_list_projects', {})
        expect(all.map(p => p.name)).toEqual(expect.arrayContaining(['Alice P', 'Bob P']))
    })
})

describe('CX graph via the tool path (main)', () => {
    const { main } = require('../actions/mcp-server/index.js')
    const KEY = 'k'
    async function callTool (name, args) {
        const res = await main({ SERVICE_API_KEY: KEY, __ow_headers: { 'x-api-key': KEY, host: 'unit.test' }, LOG_LEVEL: 'error', __ow_method: 'post', __ow_body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
        return JSON.parse(JSON.parse(res.body).result.content[0].text)
    }
    test('D64 two-tier: baking makes a candidate but NOT a CX member; headchef_approve admits it', async () => {
        const before = await callTool('get_cx_graph', {})
        expect(before.built).toBe(false)

        const rec = await callTool('start_recipe', { project: 'CX Live', title: 'a task' })
        await callTool('append_step', { recipe_id: rec.id, kind: 'decision', content: 'chose X', source: 'desktop' })
        await callTool('bake_recipe', { id: rec.id, approve_all: true })

        // Baked but not yet Head Chef-admitted -> absent from the CX graph, present in the queue.
        let rebuilt = await callTool('rebuild_cx_graph', {})
        expect(rebuilt.recipe_count).toBe(0)
        const pending = await callTool('list_cx_pending', {})
        expect(pending.map(r => r.id)).toContain(rec.id)

        // The service-account principal is on the seeded head-chef roster, so it may admit.
        const admitted = await callTool('headchef_approve', { recipe_id: rec.id })
        expect(admitted.cx_approved).toBe(true)

        rebuilt = await callTool('rebuild_cx_graph', {})
        expect(rebuilt.recipe_count).toBe(1)
        const after = await callTool('get_cx_graph', {})
        expect(after.nodes.some(n => n.node === 'recipe' && n.id === rec.id)).toBe(true)

        // Once admitted, it leaves the pending queue.
        const pendingAfter = await callTool('list_cx_pending', {})
        expect(pendingAfter.map(r => r.id)).not.toContain(rec.id)
    })
})

describe('Head Chef role + guard (D64)', () => {
    const { main } = require('../actions/mcp-server/index.js')
    const KEY = 'k'
    async function callTool (name, args) {
        const res = await main({ SERVICE_API_KEY: KEY, __ow_headers: { 'x-api-key': KEY, host: 'unit.test' }, LOG_LEVEL: 'error', __ow_method: 'post', __ow_body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
        return JSON.parse(res.body)
    }
    async function callOk (name, args) {
        return JSON.parse((await callTool(name, args)).result.content[0].text)
    }

    async function bakedRecipe () {
        const rec = await callOk('start_recipe', { project: 'HC', title: 'a task' })
        await callOk('append_step', { recipe_id: rec.id, kind: 'decision', content: 'x', source: 'desktop' })
        await callOk('bake_recipe', { id: rec.id, approve_all: true })
        return rec
    }

    test('get_role: the seeded service-account is a head-chef; a non-listed owner is a plain chef', async () => {
        const role = await callOk('get_role', {})
        expect(role.owner).toBe('service-account')
        expect(role.role).toBe('head-chef') // seeded in config/settings.json
        expect(role.head_chefs).toContain('service-account')
    })

    test('non-head-chef headchef_approve is REFUSED (guard), and the recipe stays out of the CX graph', async () => {
        // Take the service-account OFF the roster so this caller is a plain chef.
        await callOk('set_head_chefs', { head_chefs: ['someone-else@example.com'] })
        expect((await callOk('get_role', {})).role).toBe('chef')

        const rec = await bakedRecipe()
        const res = await callTool('headchef_approve', { recipe_id: rec.id })
        expect(res.result.isError).toBe(true)
        expect(res.result.content[0].text).toMatch(/only a Head Chef/i)

        const rebuilt = await callOk('rebuild_cx_graph', {})
        expect(rebuilt.recipe_count).toBe(0) // never admitted
    })

    test('headchef_approve requires the recipe to be baked first (candidate only)', async () => {
        const rec = await callOk('start_recipe', { project: 'HC', title: 'unbaked' })
        await callOk('append_step', { recipe_id: rec.id, kind: 'decision', content: 'x', source: 'desktop' })
        const res = await callTool('headchef_approve', { recipe_id: rec.id })
        expect(res.result.isError).toBe(true)
        expect(res.result.content[0].text).toMatch(/not baked/i)
    })

    test('headchef_reject clears cx_approved and removes an admitted recipe from the CX graph', async () => {
        const rec = await bakedRecipe()
        await callOk('headchef_approve', { recipe_id: rec.id })
        expect((await callOk('rebuild_cx_graph', {})).recipe_count).toBe(1)

        const rejected = await callOk('headchef_reject', { recipe_id: rec.id })
        expect(rejected.cx_approved).toBe(false)
        expect((await callOk('rebuild_cx_graph', {})).recipe_count).toBe(0)
    })
})

describe('bake rule: >= 1 approved ingredient (D64)', () => {
    const { main } = require('../actions/mcp-server/index.js')
    const KEY = 'k'
    async function callTool (name, args) {
        const res = await main({ SERVICE_API_KEY: KEY, __ow_headers: { 'x-api-key': KEY, host: 'unit.test' }, LOG_LEVEL: 'error', __ow_method: 'post', __ow_body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
        return JSON.parse(res.body)
    }
    async function callOk (name, args) { return JSON.parse((await callTool(name, args)).result.content[0].text) }

    test('bake without approve_all is REFUSED when no ingredient is approved (no auto-approve)', async () => {
        const rec = await callOk('start_recipe', { project: 'Bake', title: 'r' })
        await callOk('append_step', { recipe_id: rec.id, kind: 'decision', content: 'x', source: 'desktop' })
        const res = await callTool('bake_recipe', { id: rec.id })
        expect(res.result.isError).toBe(true)
        expect(res.result.content[0].text).toMatch(/no approved ingredients/i)
    })

    test('bake succeeds once at least one ingredient is approved', async () => {
        const rec = await callOk('start_recipe', { project: 'Bake', title: 'r2' })
        const step = await callOk('append_step', { recipe_id: rec.id, kind: 'decision', content: 'x', source: 'desktop' })
        await callOk('approve_step', { step_id: step.id })
        const res = await callOk('bake_recipe', { id: rec.id })
        expect(res.baked).toBe(true)
    })
})
