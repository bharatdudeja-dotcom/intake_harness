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
 * Unit tests for lib/store.js, with @adobe/aio-lib-files faked out by an
 * in-memory path->Buffer map so no real Azure/TVM credentials are needed.
 */

jest.mock('@adobe/aio-lib-files')

const filesLib = require('@adobe/aio-lib-files')
const store = require('../lib/store')

/** @returns {object} a fake Files instance backed by the given in-memory map */
function createFakeFiles (data) {
    return {
        list: jest.fn(async (path) => (data.has(path) ? [{ name: path }] : [])),
        read: jest.fn(async (path) => data.get(path)),
        write: jest.fn(async (path, content) => {
            const buf = Buffer.isBuffer(content) ? content : Buffer.from(content)
            data.set(path, buf)
            return buf.length
        }),
        delete: jest.fn(async (path) => { data.delete(path); return [] })
    }
}

let data

beforeEach(() => {
    data = new Map()
    filesLib.init = jest.fn(async () => createFakeFiles(data))
})

describe('lib/store', () => {
    test('saveResource writes the full resource and an upserted catalog entry', async () => {
        const resource = {
            id: 'note-1-ping',
            title: 'ping test',
            type: 'note',
            content: 'hello',
            author: 'unknown',
            created: '2026-07-02T00:00:00.000Z'
        }

        const metadata = await store.saveResource(resource)

        expect(metadata).toEqual({
            id: 'note-1-ping',
            title: 'ping test',
            type: 'note',
            project: undefined,
            tags: undefined,
            author: 'unknown',
            created: '2026-07-02T00:00:00.000Z'
        })
        expect(data.has('resources/note-1-ping.json')).toBe(true)
        expect(data.has('resources/index.json')).toBe(true)

        const catalog = JSON.parse(data.get('resources/index.json').toString('utf8'))
        expect(catalog).toHaveLength(1)
        expect(catalog[0].id).toBe('note-1-ping')
    })

    test('saveResource upserts (does not duplicate) an existing catalog entry', async () => {
        const base = { id: 'note-1', title: 'v1', type: 'note', content: 'a', author: 'unknown', created: 't1' }
        await store.saveResource(base)
        await store.saveResource({ ...base, title: 'v2', content: 'b', created: 't2' })

        const catalog = await store.listResources()
        expect(catalog).toHaveLength(1)
        expect(catalog[0].title).toBe('v2')

        const full = await store.getResource('note-1')
        expect(full.content).toBe('b')
    })

    test('save -> list -> search -> get round trip', async () => {
        const resource = {
            id: 'note-42-ping-test',
            title: 'ping test',
            type: 'note',
            content: 'hello',
            project: 'demo',
            tags: ['smoke-test'],
            author: 'bharat.dudeja@tapcxm.com',
            created: '2026-07-02T00:00:00.000Z'
        }

        const { id } = await store.saveResource(resource)
        expect(id).toBe('note-42-ping-test')

        const listed = await store.listResources()
        expect(listed.map(r => r.id)).toContain(id)

        const listedByProject = await store.listResources({ project: 'demo' })
        expect(listedByProject.map(r => r.id)).toContain(id)
        expect(await store.listResources({ project: 'other-project' })).toHaveLength(0)

        const foundByTitle = await store.searchResources('ping')
        expect(foundByTitle.map(r => r.id)).toContain(id)

        const foundByTag = await store.searchResources('smoke-test')
        expect(foundByTag.map(r => r.id)).toContain(id)

        const foundByContent = await store.searchResources('hello')
        expect(foundByContent.map(r => r.id)).toContain(id)

        expect(await store.searchResources('no-such-keyword')).toHaveLength(0)

        const full = await store.getResource(id)
        expect(full).toEqual(resource)
    })

    test('getResource returns null for an unknown id', async () => {
        expect(await store.getResource('does-not-exist')).toBeNull()
    })

    test('listResources returns an empty array when the catalog does not exist yet', async () => {
        expect(await store.listResources()).toEqual([])
    })

    test('searchResources returns an empty array for an empty query', async () => {
        expect(await store.searchResources('')).toEqual([])
    })
})

describe('lib/store - OAuth login-bridge ephemeral records (D68)', () => {
    test('saveOAuthTransaction/takeOAuthTransaction round-trips and is single-use', async () => {
        await store.saveOAuthTransaction('txn_1', { mcp: { redirectUri: 'http://localhost:1/x' } })
        const first = await store.takeOAuthTransaction('txn_1')
        expect(first.mcp.redirectUri).toBe('http://localhost:1/x')
        expect(await store.takeOAuthTransaction('txn_1')).toBeNull()
    })

    test('takeOAuthTransaction returns null for an unknown id', async () => {
        expect(await store.takeOAuthTransaction('txn_nope')).toBeNull()
    })

    test('saveOAuthGrant/takeOAuthGrant round-trips and is single-use', async () => {
        await store.saveOAuthGrant('tpc_code_1', { accessToken: 'A' })
        expect((await store.takeOAuthGrant('tpc_code_1')).accessToken).toBe('A')
        expect(await store.takeOAuthGrant('tpc_code_1')).toBeNull()
    })

    test('an expired ephemeral record is treated as absent', async () => {
        await store.saveOAuthTransaction('txn_old', { mcp: {} })
        // Simulate the passage of time past the TTL by rewriting createdAt directly.
        const files = await filesLib.init()
        const raw = JSON.parse((await files.read('oauth-bridge/tx/txn_old.json')).toString('utf8'))
        raw.createdAt = Date.now() - (11 * 60 * 1000)
        await files.write('oauth-bridge/tx/txn_old.json', JSON.stringify(raw))
        expect(await store.takeOAuthTransaction('txn_old')).toBeNull()
    })
})

/**
 * D80: search must find prior work from a NATURAL multi-word query. The old implementation tested
 * the whole query as one literal substring, so the reuse-before-rebuild instruction the server
 * gives every connected AI produced zero hits and the agent rebuilt work that already existed.
 * Found by dogfooding with five personas, not by a unit test - a one-word query passes either way.
 */
describe('lib/store - search finds prior work from a real query (D80)', () => {
    const RECIPE = {
        id: 'recipe-cart-canvas',
        type: 'recipe',
        title: 'Abandoned-cart Canvas — the Tempering Series (3 messages)',
        project: 'Cacao & Co.',
        tags: ['braze', 'cart-recovery'],
        content: 'Personalise on the highest-margin item in the cart, not the most recent one.',
        author: 'jesse.pinkman@tapcxm.example',
        created: '2026-08-13T00:00:00.000Z'
    }
    const ARCH = {
        id: 'recipe-decisioning-arch',
        type: 'recipe',
        title: 'Decisioning architecture — eligibility, ranking, capping and the arbitration contract',
        project: 'Gustavo',
        tags: ['decisioning'],
        content: 'Eligibility is a hard boolean filter. Ranking is a score. Never mix them.',
        author: 'mike.ehrmantraut@tapcxm.example',
        created: '2026-08-12T00:00:00.000Z'
    }

    beforeEach(async () => {
        await store.saveResource({ ...RECIPE })
        await store.saveResource({ ...ARCH })
    })

    test('a multi-word query spanning title AND content finds the recipe', async () => {
        const hits = await store.searchResources('abandoned cart canvas margin')
        expect(hits.map(r => r.id)).toContain('recipe-cart-canvas')
    })

    test('punctuation in the title does not defeat the query', async () => {
        // Title reads "eligibility, ranking, capping" - commas must not break the match.
        const hits = await store.searchResources('decisioning eligibility ranking')
        expect(hits.map(r => r.id)).toContain('recipe-decisioning-arch')
    })

    test('a conversational query still works (stopwords are dropped)', async () => {
        const hits = await store.searchResources('how do we handle the abandoned cart')
        expect(hits.map(r => r.id)).toContain('recipe-cart-canvas')
    })

    test('ALL terms must appear - it is AND, not OR, so results stay trustworthy', async () => {
        // "canvas" hits the cart recipe, "arbitration" hits the other. Neither has both.
        expect(await store.searchResources('canvas arbitration')).toHaveLength(0)
    })

    test('the best match ranks first: title phrase beats a content-only hit', async () => {
        await store.saveResource({
            id: 'recipe-mentions-tempering',
            type: 'recipe',
            title: 'Unrelated playbook',
            project: 'Cacao & Co.',
            content: 'Passing mention of the tempering series in a footnote.',
            author: 'saul.goodman@tapcxm.example',
            created: '2026-08-13T00:00:00.000Z'
        })
        const hits = await store.searchResources('tempering series')
        expect(hits[0].id).toBe('recipe-cart-canvas')
    })

    test('single-word and tag search still behave as before', async () => {
        expect((await store.searchResources('tempering')).map(r => r.id)).toContain('recipe-cart-canvas')
        expect((await store.searchResources('braze')).map(r => r.id)).toContain('recipe-cart-canvas')
    })

    test('a genuine miss is still a miss', async () => {
        expect(await store.searchResources('kubernetes helm chart')).toHaveLength(0)
    })

    test('filters still narrow the search', async () => {
        const hits = await store.searchResources('eligibility ranking', { project: 'Cacao & Co.' })
        expect(hits).toHaveLength(0)
    })
})

describe('lib/store - search relaxation is bounded (D80)', () => {
    test('a single incidental word overlap is NOT treated as a match', async () => {
        await store.saveResource({
            id: 'recipe-unrelated', type: 'recipe', title: 'Dispatcher caching rules',
            project: 'P', content: 'Cache invalidation for the product section.',
            author: 'walter.white@tapcxm.example', created: '2026-08-13T00:00:00.000Z'
        })
        // "cache" matches; "kubernetes" and "helm" do not. One of three is not a result.
        expect(await store.searchResources('kubernetes helm cache')).toHaveLength(0)
    })

    test('an exact-coverage match suppresses the near-misses entirely', async () => {
        await store.saveResource({
            id: 'recipe-both', type: 'recipe', title: 'Braze canvas cart recovery',
            project: 'P', content: 'full', author: 'a@b.c', created: '2026-08-13T00:00:00.000Z'
        })
        await store.saveResource({
            id: 'recipe-partial', type: 'recipe', title: 'Braze canvas basics',
            project: 'P', content: 'Entry events and exit criteria only.', author: 'a@b.c', created: '2026-08-13T00:00:00.000Z'
        })
        const hits = await store.searchResources('braze canvas cart')
        expect(hits.map(r => r.id)).toEqual(['recipe-both'])
    })
})

describe('lib/store - plural/singular tolerance in search (D80)', () => {
    beforeEach(async () => {
        await store.saveResource({
            id: 'recipe-cart', type: 'recipe', title: 'Abandoned-cart Canvas',
            project: 'P', tags: ['braze'], content: 'Recovering an abandoned cart with a template.',
            author: 'jesse.pinkman@tapcxm.example', created: '2026-08-13T00:00:00.000Z'
        })
    })

    test('a plural query term finds singular content ("carts" -> "cart")', async () => {
        const hits = await store.searchResources('abandoned carts')
        expect(hits.map(r => r.id)).toContain('recipe-cart')
    })

    test('plural tolerance works mid-query too ("templates" -> "template")', async () => {
        const hits = await store.searchResources('abandoned cart templates')
        expect(hits.map(r => r.id)).toContain('recipe-cart')
    })

    test('plural stripping never truncates a term down to a single letter', async () => {
        // 'ies' must NOT become 'i' - that would match essentially every recipe ever written.
        // (Substring matching is deliberately loose, so this asserts the guard, not the looseness:
        // 'ies' appears nowhere in the fixture, so any hit here would mean over-eager stripping.)
        expect(await store.searchResources('ies')).toHaveLength(0)
    })
})
