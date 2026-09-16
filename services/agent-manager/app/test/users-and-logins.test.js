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
 * D81: admin-created Cookbook logins (id + password) as the way a consultant identifies
 * themselves, replacing the shared deployment passcode. Driven through the real tool path.
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
const usersLib = require('../lib/auth/users')
const store = require('../lib/store')

const ADMIN_KEY = 'k-admin'
const CHEF_KEY = 'k-chef'
const K_VIEWER = 'k-viewer'
const API_KEY_OWNERS = JSON.stringify({
    [ADMIN_KEY]: { userId: 'walter', email: 'walter.white@tapcxm.example', roles: ['chef', 'head-chef', 'admin'] },
    [CHEF_KEY]: { userId: 'jesse', email: 'jesse.pinkman@tapcxm.example', roles: ['chef'] },
    [K_VIEWER]: { userId: 'guest', email: 'guest@tapcxm.example', roles: ['viewer'] }
})

/** Call a tool with arbitrary auth headers. */
async function callWith (headers, name, args = {}) {
    const res = await main({
        SERVICE_API_KEY: 'svc',
        API_KEY_OWNERS,
        LOG_LEVEL: 'error',
        __ow_method: 'post',
        __ow_headers: { host: 'unit.test', ...headers },
        __ow_body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    })
    return res
}
const asKey = (key, name, args) => callWith({ 'x-api-key': key }, name, args).then(r => JSON.parse(r.body).result)
const okJson = (result) => JSON.parse(result.content[0].text)

describe('lib/auth/users - password handling (D81)', () => {
    test('a password is never stored in retrievable form', () => {
        const { user } = usersLib.buildUser({ id: 'jesse', password: 'test-pw-alpha-0001' })
        const serialized = JSON.stringify(user)
        expect(serialized).not.toContain('test-pw-alpha-0001')
        expect(user.hash).toBeTruthy()
        expect(user.salt).toBeTruthy()
        expect(user).not.toHaveProperty('password')
    })

    test('two users with the SAME password get different hashes (per-user salt)', () => {
        const a = usersLib.buildUser({ id: 'alice', password: 'same-password-1' }).user
        const b = usersLib.buildUser({ id: 'bob', password: 'same-password-1' }).user
        expect(a.hash).not.toBe(b.hash)
        expect(a.salt).not.toBe(b.salt)
    })

    test('verification accepts the right password and rejects near-misses', () => {
        const { user } = usersLib.buildUser({ id: 'jesse', password: 'test-pw-alpha-0001' })
        expect(usersLib.verifyPassword('test-pw-alpha-0001', user)).toBe(true)
        expect(usersLib.verifyPassword('test-pw-alpha-0002', user)).toBe(false) // one character off
        expect(usersLib.verifyPassword('COCOA-EMBER-4471', user)).toBe(false)
        expect(usersLib.verifyPassword('', user)).toBe(false)
    })

    test('a too-short password is refused', () => {
        expect(usersLib.buildUser({ id: 'x', password: 'short' }).ok).toBe(false)
    })

    test('an invalid login id is refused with a usable message', () => {
        const res = usersLib.buildUser({ id: 'has spaces', password: 'long-enough-1' })
        expect(res.ok).toBe(false)
        expect(res.error).toMatch(/Invalid login id/)
    })

    test('publicUser strips every secret, so it is safe to return over the wire', () => {
        const { user } = usersLib.buildUser({ id: 'jesse', password: 'test-pw-alpha-0001', email: 'j@x.com' })
        const pub = usersLib.publicUser(user)
        expect(pub.email).toBe('j@x.com')
        expect(pub).not.toHaveProperty('hash')
        expect(pub).not.toHaveProperty('salt')
    })

    test('an unknown id and a wrong password give the SAME message (no user enumeration)', () => {
        const { user } = usersLib.buildUser({ id: 'jesse', password: 'test-pw-alpha-0001' })
        const wrongPass = usersLib.authenticate([user], 'jesse', 'nope-nope-nope')
        const unknownId = usersLib.authenticate([user], 'nobody', 'nope-nope-nope')
        expect(wrongPass.error).toBe(unknownId.error)
    })

    test('a disabled login cannot authenticate even with the correct password', () => {
        const { user } = usersLib.buildUser({ id: 'jesse', password: 'test-pw-alpha-0001' })
        const res = usersLib.authenticate([{ ...user, disabled: true }], 'jesse', 'test-pw-alpha-0001')
        expect(res.ok).toBe(false)
        expect(res.error).toMatch(/disabled/i)
    })

    test('login ids are case-insensitive - one person, however they type it', () => {
        const { user } = usersLib.buildUser({ id: 'Jesse.Pinkman', password: 'test-pw-alpha-0001' })
        expect(usersLib.authenticate([user], 'JESSE.PINKMAN', 'test-pw-alpha-0001').ok).toBe(true)
    })
})

describe('create_user is admin-only and produces a working login (D81)', () => {
    test('a plain chef cannot create logins', async () => {
        const res = await asKey(CHEF_KEY, 'create_user', { id: 'newbie', password: 'long-enough-1' })
        expect(res.isError).toBe(true)
        expect(res.content[0].text).toMatch(/only an admin/i)
    })

    test('an admin creates a login, and the response carries no password material', async () => {
        const out = okJson(await asKey(ADMIN_KEY, 'create_user', {
            id: 'saul.goodman', password: 'test-pw-bravo-0002', email: 'saul.goodman@tapcxm.example', display_name: 'Saul Goodman', roles: ['chef']
        }))
        expect(out.created.id).toBe('saul.goodman')
        expect(out.created.owner).toBe('saul.goodman@tapcxm.example')
        expect(JSON.stringify(out)).not.toContain('test-pw-bravo-0002')
        expect(out.created).not.toHaveProperty('hash')
        expect(out.connection.mcp_header).toBe('x-cookbook-login: saul.goodman:<password>')
    })

    test('THE POINT: the new login then authenticates and resolves to that person', async () => {
        await asKey(ADMIN_KEY, 'create_user', { id: 'jesse.pinkman', password: 'test-pw-alpha-0001', email: 'jesse.pinkman@tapcxm.example', roles: ['chef'] })

        const viaTwoHeaders = await callWith({ 'x-cookbook-user-id': 'jesse.pinkman', 'x-cookbook-password': 'test-pw-alpha-0001' }, 'get_my_roles')
        expect(viaTwoHeaders.statusCode).toBe(200)
        expect(okJson(JSON.parse(viaTwoHeaders.body).result).owner).toBe('jesse.pinkman@tapcxm.example')

        // Single-header form, which is what an MCP client config can actually express.
        const viaOneHeader = await callWith({ 'x-cookbook-login': 'jesse.pinkman:test-pw-alpha-0001' }, 'get_my_roles')
        expect(okJson(JSON.parse(viaOneHeader.body).result).owner).toBe('jesse.pinkman@tapcxm.example')
    })

    test('a wrong password is rejected with 401, not silently downgraded to another identity', async () => {
        await asKey(ADMIN_KEY, 'create_user', { id: 'jesse.pinkman', password: 'test-pw-alpha-0001', email: 'jesse.pinkman@tapcxm.example' })
        const res = await callWith({ 'x-cookbook-login': 'jesse.pinkman:wrong-password' }, 'get_my_roles')
        expect(res.statusCode).toBe(401)
    })

    test('roles and practices granted at creation take effect immediately', async () => {
        await asKey(ADMIN_KEY, 'set_practices', { practices: [{ id: 'braze', label: 'Braze' }] })
        await asKey(ADMIN_KEY, 'create_user', {
            id: 'mike', password: 'test-pw-charlie-0003', email: 'mike@tapcxm.example', roles: ['chef', 'head-chef'], practices: ['braze']
        })
        const res = await callWith({ 'x-cookbook-login': 'mike:test-pw-charlie-0003' }, 'get_my_roles')
        const me = okJson(JSON.parse(res.body).result)
        expect(me.roles).toEqual(expect.arrayContaining(['chef', 'head-chef']))

        // The practice is live too: a recipe they start inherits it with no extra effort.
        const rec = await callWith({ 'x-cookbook-login': 'mike:test-pw-charlie-0003' }, 'start_recipe', { project: 'P', title: 'T' })
        expect(okJson(JSON.parse(rec.body).result).practice).toBe('braze')
    })

    test('an unknown practice id is refused rather than silently stored', async () => {
        const res = await asKey(ADMIN_KEY, 'create_user', { id: 'x.y', password: 'long-enough-1', practices: ['not-a-practice'] })
        expect(res.isError).toBe(true)
        expect(res.content[0].text).toMatch(/Unknown practice id/)
    })

    test('a duplicate login id is refused, pointing at the password reset instead', async () => {
        await asKey(ADMIN_KEY, 'create_user', { id: 'dupe', password: 'long-enough-1' })
        const res = await asKey(ADMIN_KEY, 'create_user', { id: 'DUPE', password: 'another-long-1' })
        expect(res.isError).toBe(true)
        expect(res.content[0].text).toMatch(/already exists.*set_user_password/is)
    })
})

describe('login lifecycle: list, reset, disable (D81)', () => {
    beforeEach(async () => {
        await asKey(ADMIN_KEY, 'create_user', { id: 'hank', password: 'test-pw-delta-0004', email: 'hank@tapcxm.example', roles: ['chef'] })
    })

    test('list_users is admin-only and never returns hashes or salts', async () => {
        const refused = await asKey(CHEF_KEY, 'list_users')
        expect(refused.isError).toBe(true)

        const list = okJson(await asKey(ADMIN_KEY, 'list_users'))
        expect(list.map(u => u.id)).toContain('hank')
        const serialized = JSON.stringify(list)
        expect(serialized).not.toMatch(/"hash"|"salt"/)
    })

    test('a password reset invalidates the old password and enables the new one', async () => {
        await asKey(ADMIN_KEY, 'set_user_password', { id: 'hank', password: 'test-pw-foxtrot-0006' })
        expect((await callWith({ 'x-cookbook-login': 'hank:test-pw-delta-0004' }, 'get_my_roles')).statusCode).toBe(401)
        expect((await callWith({ 'x-cookbook-login': 'hank:test-pw-foxtrot-0006' }, 'get_my_roles')).statusCode).toBe(200)
    })

    test('disabling blocks sign-in but keeps the account and its authored work', async () => {
        await asKey(ADMIN_KEY, 'set_user_enabled', { id: 'hank', enabled: false })
        expect((await callWith({ 'x-cookbook-login': 'hank:test-pw-delta-0004' }, 'get_my_roles')).statusCode).toBe(401)

        const list = okJson(await asKey(ADMIN_KEY, 'list_users'))
        expect(list.find(u => u.id === 'hank').disabled).toBe(true)

        await asKey(ADMIN_KEY, 'set_user_enabled', { id: 'hank', enabled: true })
        expect((await callWith({ 'x-cookbook-login': 'hank:test-pw-delta-0004' }, 'get_my_roles')).statusCode).toBe(200)
    })

    test('the last enabled admin login cannot be disabled - that would lock everyone out', async () => {
        await asKey(ADMIN_KEY, 'create_user', { id: 'only.admin', password: 'zephyr-saffron-1064', email: 'admin@tapcxm.example', roles: ['admin'] })
        const res = await asKey(ADMIN_KEY, 'set_user_enabled', { id: 'only.admin', enabled: false })
        expect(res.isError).toBe(true)
        expect(res.content[0].text).toMatch(/last enabled admin/i)
    })

    test('resetting a password for an unknown id says so plainly', async () => {
        const res = await asKey(ADMIN_KEY, 'set_user_password', { id: 'ghost', password: 'long-enough-1' })
        expect(res.isError).toBe(true)
        expect(res.content[0].text).toMatch(/No login found/)
    })
})

describe('logins survive a content reset (D81)', () => {
    test('admin_reset_data wipes recipes but NOT logins - a demo reset must not lock the team out', async () => {
        await asKey(ADMIN_KEY, 'create_user', { id: 'walter.white', password: 'zephyr-saffron-1064', email: 'walter.white@tapcxm.example', roles: ['admin'] })
        await asKey(ADMIN_KEY, 'start_recipe', { project: 'P', title: 'Doomed recipe' })

        await asKey(ADMIN_KEY, 'admin_reset_data', { confirm: true })

        expect((await store.listUsers()).map(u => u.id)).toContain('walter.white')
        expect((await callWith({ 'x-cookbook-login': 'walter.white:zephyr-saffron-1064' }, 'get_my_roles')).statusCode).toBe(200)
        expect(okJson(await asKey(ADMIN_KEY, 'list_recipes'))).toHaveLength(0)
    })
})

/**
 * D82: people - not just demo personas - use these accounts, so each person must be able to change
 * their own password without an admin, and there must be no second, weaker credential that
 * bypasses the password and that the user cannot rotate.
 */
describe('self-service password change (D82)', () => {
    beforeEach(async () => {
        await asKey(ADMIN_KEY, 'create_user', { id: 'jesse.pinkman', password: 'test-pw-alpha-0001', email: 'jesse.pinkman@tapcxm.example', roles: ['chef'] })
    })
    const asJesse = (pw, name, args) => callWith({ 'x-cookbook-login': `jesse.pinkman:${pw}` }, name, args)

    test('a normal user changes their OWN password with no admin involved', async () => {
        const res = await asJesse('test-pw-alpha-0001', 'change_my_password', { current_password: 'test-pw-alpha-0001', new_password: 'test-pw-golf-0007' })
        expect(JSON.parse(res.body).result.isError).toBeFalsy()

        expect((await asJesse('test-pw-golf-0007', 'get_my_roles')).statusCode).toBe(200)
        expect((await asJesse('test-pw-alpha-0001', 'get_my_roles')).statusCode).toBe(401)
    })

    test('the CURRENT password is required even though the caller is already signed in', async () => {
        const res = await asJesse('test-pw-alpha-0001', 'change_my_password', { current_password: 'wrong-current-pw', new_password: 'test-pw-golf-0007' })
        expect(JSON.parse(res.body).result.isError).toBe(true)
        expect(JSON.parse(res.body).result.content[0].text).toMatch(/current password is incorrect/i)
        // ...and nothing changed.
        expect((await asJesse('test-pw-alpha-0001', 'get_my_roles')).statusCode).toBe(200)
    })

    test('it only ever changes the CALLER\'s own account', async () => {
        await asKey(ADMIN_KEY, 'create_user', { id: 'saul.goodman', password: 'test-pw-bravo-0002', email: 'saul.goodman@tapcxm.example', roles: ['chef'] })
        await asJesse('test-pw-alpha-0001', 'change_my_password', { current_password: 'test-pw-alpha-0001', new_password: 'test-pw-golf-0007' })
        // Saul is untouched by Jesse changing his own.
        expect((await callWith({ 'x-cookbook-login': 'saul.goodman:test-pw-bravo-0002' }, 'get_my_roles')).statusCode).toBe(200)
    })

    test('a too-short new password is refused, and re-using the current one is refused', async () => {
        const short = await asJesse('test-pw-alpha-0001', 'change_my_password', { current_password: 'test-pw-alpha-0001', new_password: 'short' })
        expect(JSON.parse(short.body).result.isError).toBe(true)

        const same = await asJesse('test-pw-alpha-0001', 'change_my_password', { current_password: 'test-pw-alpha-0001', new_password: 'test-pw-alpha-0001' })
        expect(JSON.parse(same.body).result.isError).toBe(true)
        expect(JSON.parse(same.body).result.content[0].text).toMatch(/already your current password/i)
    })

    test('a caller with no login (api key only) gets a useful message, not a crash', async () => {
        const res = await asKey(ADMIN_KEY, 'change_my_password', { current_password: 'x', new_password: 'long-enough-1' })
        expect(res.isError).toBe(true)
        expect(res.content[0].text).toMatch(/no Cookbook login|ask an admin/i)
    })

    test('an admin reset and a self-service change reach the same place', async () => {
        await asKey(ADMIN_KEY, 'set_user_password', { id: 'jesse.pinkman', password: 'admin-set-pw-1' })
        expect((await asJesse('admin-set-pw-1', 'get_my_roles')).statusCode).toBe(200)
        await asJesse('admin-set-pw-1', 'change_my_password', { current_password: 'admin-set-pw-1', new_password: 'self-set-pw-22' })
        expect((await asJesse('self-set-pw-22', 'get_my_roles')).statusCode).toBe(200)
        expect((await asJesse('admin-set-pw-1', 'get_my_roles')).statusCode).toBe(401)
    })
})

/**
 * D84: an admin needs to remove ONE bad recipe. Until this existed the only delete was
 * admin_reset_data, so cleaning up a single piece of test junk meant destroying everyone's work -
 * which in practice means the junk stays forever.
 */
describe('delete_recipe (D84)', () => {
    let recipeId
    beforeEach(async () => {
        const rec = okJson(await asKey(CHEF_KEY, 'start_recipe', { project: 'P', title: 'Junk probe recipe' }))
        recipeId = rec.id
    })

    test('a plain chef cannot delete, even their own recipe', async () => {
        const res = await asKey(CHEF_KEY, 'delete_recipe', { id: recipeId })
        expect(res.isError).toBe(true)
        expect(res.content[0].text).toMatch(/only an admin/i)
    })

    test('an admin deletes it, and it is gone from the catalog', async () => {
        const out = okJson(await asKey(ADMIN_KEY, 'delete_recipe', { id: recipeId }))
        expect(out.deleted.id).toBe(recipeId)
        expect(out.deleted.title).toBe('Junk probe recipe')
        expect(out.deleted_by).toBeTruthy()

        const listed = okJson(await asKey(ADMIN_KEY, 'list_recipes'))
        expect(listed.map(r => r.id)).not.toContain(recipeId)
        expect((await asKey(ADMIN_KEY, 'get_resource', { id: recipeId })).isError).toBe(true)
    })

    test('deleting an unknown id says so rather than pretending it worked', async () => {
        const res = await asKey(ADMIN_KEY, 'delete_recipe', { id: 'no-such-recipe' })
        expect(res.isError).toBe(true)
        expect(res.content[0].text).toMatch(/nothing to delete/i)
    })

    test('a recipe IN the CX graph is protected - other people rely on it', async () => {
        const step = okJson(await asKey(CHEF_KEY, 'append_step', { recipe_id: recipeId, kind: 'decision', content: 'd', source: 's' }))
        await asKey(CHEF_KEY, 'approve_step', { step_id: step.id })
        await asKey(CHEF_KEY, 'bake_recipe', { id: recipeId })
        await asKey(ADMIN_KEY, 'headchef_approve', { recipe_id: recipeId })

        const refused = await asKey(ADMIN_KEY, 'delete_recipe', { id: recipeId })
        expect(refused.isError).toBe(true)
        expect(refused.content[0].text).toMatch(/Company CX Graph/i)

        // force is the deliberate override, and it reports what it removed.
        const forced = okJson(await asKey(ADMIN_KEY, 'delete_recipe', { id: recipeId, force: true }))
        expect(forced.deleted.was_in_cx_graph).toBe(true)
    })

    test('a viewer is refused by the read-only gate before the admin check', async () => {
        const res = await asKey(K_VIEWER, 'delete_recipe', { id: recipeId })
        expect(res.isError).toBe(true)
        expect(res.content[0].text).toMatch(/read-only \(viewer\)/i)
    })
})

/**
 * D86: who can see whose work. The old rule shared anything whose status canonicalised to
 * "approved", and approving a single ingredient auto-promotes its recipe, so a consultant's working
 * draft became company-visible the moment they approved one ingredient of it. Nobody pressing
 * "approve" on an ingredient believes they are publishing the recipe.
 */
describe('work log visibility (D86)', () => {
    const HEAD_KEY = 'k-head'
    const SAUL_KEY = 'k-saul'
    const OWNERS = JSON.stringify({
        [ADMIN_KEY]: { userId: 'walter', email: 'walter.white@tapcxm.example', roles: ['chef', 'head-chef', 'admin'] },
        [CHEF_KEY]: { userId: 'jesse', email: 'jesse.pinkman@tapcxm.example', roles: ['chef'] },
        [SAUL_KEY]: { userId: 'saul', email: 'saul.goodman@tapcxm.example', roles: ['chef'] },
        [HEAD_KEY]: { userId: 'mike', email: 'mike.ehrmantraut@tapcxm.example', roles: ['chef', 'head-chef'] },
        [K_VIEWER]: { userId: 'guest', email: 'guest@tapcxm.example', roles: ['viewer'] }
    })

    /** Call as a key, using the wider key map this suite needs. */
    async function as (key, name, args = {}) {
        const res = await main({
            SERVICE_API_KEY: 'svc',
            API_KEY_OWNERS: OWNERS,
            LOG_LEVEL: 'error',
            __ow_method: 'post',
            __ow_headers: { host: 'unit.test', 'x-api-key': key },
            __ow_body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
        })
        return JSON.parse(res.body).result
    }
    const titles = (result) => okJson(result).map(r => r.title)
    const DRAFT = 'Jesse private draft'

    /** Jesse's recipe with one APPROVED ingredient, deliberately not baked. */
    async function jesseApprovedDraft () {
        const rec = okJson(await as(CHEF_KEY, 'start_recipe', { project: 'P', title: DRAFT }))
        const step = okJson(await as(CHEF_KEY, 'append_step', { recipe_id: rec.id, kind: 'decision', content: 'd', source: 's' }))
        await as(CHEF_KEY, 'approve_step', { step_id: step.id })
        return { rec, step }
    }

    test('THE FIX: approving an ingredient no longer publishes the recipe to everyone', async () => {
        await jesseApprovedDraft()
        expect(titles(await as(CHEF_KEY, 'list_recipes'))).toContain(DRAFT)        // his own
        expect(titles(await as(SAUL_KEY, 'list_recipes'))).not.toContain(DRAFT)    // a peer
        expect(titles(await as(K_VIEWER, 'list_recipes'))).not.toContain(DRAFT)    // a viewer
    })

    test('a HEAD CHEF sees work once it is submitted for review, and not before', async () => {
        const { rec } = await jesseApprovedDraft()
        expect(titles(await as(HEAD_KEY, 'list_recipes'))).not.toContain(DRAFT)

        await as(CHEF_KEY, 'bake_recipe', { id: rec.id })
        expect(titles(await as(HEAD_KEY, 'list_recipes'))).toContain(DRAFT)
    })

    test('an ADMIN also sees submitted work', async () => {
        const { rec } = await jesseApprovedDraft()
        await as(CHEF_KEY, 'bake_recipe', { id: rec.id })
        expect(titles(await as(ADMIN_KEY, 'list_recipes'))).toContain(DRAFT)
    })

    test('a PEER still cannot see it once baked, because it is under review rather than published', async () => {
        const { rec } = await jesseApprovedDraft()
        await as(CHEF_KEY, 'bake_recipe', { id: rec.id })
        expect(titles(await as(SAUL_KEY, 'list_recipes'))).not.toContain(DRAFT)
    })

    test('everyone sees it once a Head Chef ADMITS it to the CX graph', async () => {
        const { rec } = await jesseApprovedDraft()
        await as(CHEF_KEY, 'bake_recipe', { id: rec.id })
        await as(ADMIN_KEY, 'headchef_approve', { recipe_id: rec.id })
        expect(titles(await as(SAUL_KEY, 'list_recipes'))).toContain(DRAFT)
        expect(titles(await as(K_VIEWER, 'list_recipes'))).toContain(DRAFT)
    })

    test('ASSIGNMENT is the one way unfinished work crosses between peers', async () => {
        const { rec, step } = await jesseApprovedDraft()
        expect(titles(await as(SAUL_KEY, 'list_recipes'))).not.toContain(DRAFT)

        const out = okJson(await as(CHEF_KEY, 'assign_step', {
            step_id: step.id, assignee: 'saul.goodman@tapcxm.example', note: 'needs a legal read'
        }))
        expect(out.assigned_to).toContain('saul.goodman@tapcxm.example')

        // Saul can now see the whole recipe, unfinished parts included.
        expect(titles(await as(SAUL_KEY, 'list_recipes'))).toContain(DRAFT)
        expect(okJson(await as(SAUL_KEY, 'get_recipe', { id: rec.id })).title).toBe(DRAFT)
        // A third party still cannot.
        expect(titles(await as(K_VIEWER, 'list_recipes'))).not.toContain(DRAFT)
    })

    test('unassigning takes the access away again', async () => {
        const { step } = await jesseApprovedDraft()
        await as(CHEF_KEY, 'assign_step', { step_id: step.id, assignee: 'saul.goodman@tapcxm.example' })
        expect(titles(await as(SAUL_KEY, 'list_recipes'))).toContain(DRAFT)

        await as(CHEF_KEY, 'unassign_step', { step_id: step.id, assignee: 'saul.goodman@tapcxm.example' })
        expect(titles(await as(SAUL_KEY, 'list_recipes'))).not.toContain(DRAFT)
    })

    test('a DISCARDED ingredient stops granting access, since nobody is working on it', async () => {
        const rec = okJson(await as(CHEF_KEY, 'start_recipe', { project: 'P', title: 'Jesse discard case' }))
        await as(CHEF_KEY, 'append_step', { recipe_id: rec.id, kind: 'decision', content: 'keep', source: 's' })
        const drop = okJson(await as(CHEF_KEY, 'append_step', { recipe_id: rec.id, kind: 'message', content: 'drop', source: 's' }))
        await as(CHEF_KEY, 'assign_step', { step_id: drop.id, assignee: 'saul.goodman@tapcxm.example' })
        expect(titles(await as(SAUL_KEY, 'list_recipes'))).toContain('Jesse discard case')

        await as(CHEF_KEY, 'discard_step', { step_id: drop.id })
        expect(titles(await as(SAUL_KEY, 'list_recipes'))).not.toContain('Jesse discard case')
    })

    test('a peer cannot assign someone to a recipe that is not theirs', async () => {
        const { step } = await jesseApprovedDraft()
        const res = await as(SAUL_KEY, 'assign_step', { step_id: step.id, assignee: 'guest@tapcxm.example' })
        expect(res.isError).toBe(true)
        expect(res.content[0].text).toMatch(/only the recipe/i)
    })

    test('a head chef CAN assign on another owner recipe, to pull a reviewer in', async () => {
        const { step } = await jesseApprovedDraft()
        const res = await as(ADMIN_KEY, 'assign_step', { step_id: step.id, assignee: 'saul.goodman@tapcxm.example' })
        expect(res.isError).toBeFalsy()
    })

    test('assigning to a typo is refused, since it would silently grant nobody access', async () => {
        await as(ADMIN_KEY, 'create_user', { id: 'saul.goodman', password: 'test-pw-juliet-0010', email: 'saul.goodman@tapcxm.example' })
        const { step } = await jesseApprovedDraft()
        const res = await as(CHEF_KEY, 'assign_step', { step_id: step.id, assignee: 'saul.goodmn' })
        expect(res.isError).toBe(true)
        expect(res.content[0].text).toMatch(/No Cookbook login matches/i)
    })

    test('list_my_assignments is the assignee inbox, with who handed it over and why', async () => {
        const { step } = await jesseApprovedDraft()
        await as(CHEF_KEY, 'assign_step', { step_id: step.id, assignee: 'saul.goodman@tapcxm.example', note: 'needs a legal read' })

        const inbox = okJson(await as(SAUL_KEY, 'list_my_assignments'))
        expect(inbox).toHaveLength(1)
        expect(inbox[0].recipe_title).toBe(DRAFT)
        expect(inbox[0].assigned_by).toBe('jesse.pinkman@tapcxm.example')
        expect(inbox[0].note).toBe('needs a legal read')

        // Jesse assigned it, so it is not in HIS inbox.
        expect(okJson(await as(CHEF_KEY, 'list_my_assignments'))).toHaveLength(0)
    })

    test('search respects the same rules, so nothing leaks through the back door', async () => {
        const { rec } = await jesseApprovedDraft()
        expect(okJson(await as(SAUL_KEY, 'search_resources', { query: DRAFT }))).toHaveLength(0)

        await as(CHEF_KEY, 'bake_recipe', { id: rec.id })
        await as(ADMIN_KEY, 'headchef_approve', { recipe_id: rec.id })
        expect(okJson(await as(SAUL_KEY, 'search_resources', { query: DRAFT })).length).toBeGreaterThan(0)
    })
})

/**
 * D88: filtering the LIST was not enough. Every read-by-id path went straight to storage, so a
 * colleague's private draft was one guessable id away: ids are `recipe-<timestamp>-<slug-of-title>`
 * and get_resource / get_recipe / list_steps / export_as_skill returned the whole thing. Privacy
 * enforced only on enumeration is decorative.
 */
describe('reads by id obey the same visibility rules as lists (D88)', () => {
    const SAUL_KEY = 'k-saul'
    const HEAD_KEY = 'k-head'
    const OWNERS = JSON.stringify({
        [ADMIN_KEY]: { userId: 'walter', email: 'walter.white@tapcxm.example', roles: ['chef', 'head-chef', 'admin'] },
        [CHEF_KEY]: { userId: 'jesse', email: 'jesse.pinkman@tapcxm.example', roles: ['chef'] },
        [SAUL_KEY]: { userId: 'saul', email: 'saul.goodman@tapcxm.example', roles: ['chef'] },
        [HEAD_KEY]: { userId: 'mike', email: 'mike.ehrmantraut@tapcxm.example', roles: ['chef', 'head-chef'] },
        [K_VIEWER]: { userId: 'guest', email: 'guest@tapcxm.example', roles: ['viewer'] }
    })
    async function as (key, name, args = {}) {
        const res = await main({
            SERVICE_API_KEY: 'svc',
            API_KEY_OWNERS: OWNERS,
            LOG_LEVEL: 'error',
            __ow_method: 'post',
            __ow_headers: { host: 'unit.test', 'x-api-key': key },
            __ow_body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
        })
        return JSON.parse(res.body).result
    }

    /** Jesse's private draft: one approved ingredient, never baked, never assigned. */
    async function privateDraft () {
        const rec = okJson(await as(CHEF_KEY, 'start_recipe', { project: 'P', title: 'Private draft' }))
        const step = okJson(await as(CHEF_KEY, 'append_step', { recipe_id: rec.id, kind: 'decision', content: 'the secret plan', source: 's' }))
        await as(CHEF_KEY, 'approve_step', { step_id: step.id })
        return rec.id
    }

    test.each(['get_resource', 'get_recipe'])('%s by id is refused to a peer who guessed the id', async (tool) => {
        const id = await privateDraft()
        const res = await as(SAUL_KEY, tool, { id })
        expect(res.isError).toBe(true)
        expect(res.content[0].text).toMatch(/No resource visible to you/i)
        expect(res.content[0].text).not.toContain('the secret plan')
    })

    test('list_steps by id is refused too, so the ingredients cannot be read around it', async () => {
        const id = await privateDraft()
        const res = await as(SAUL_KEY, 'list_steps', { recipe_id: id })
        expect(res.isError).toBe(true)
        expect(JSON.stringify(res)).not.toContain('the secret plan')
    })

    test('export_as_skill cannot be used to launder private content into a playbook', async () => {
        const id = await privateDraft()
        const res = await as(SAUL_KEY, 'export_as_skill', { recipe_id: id })
        expect(res.isError).toBe(true)
        expect(JSON.stringify(res)).not.toContain('the secret plan')
    })

    test('the OWNER still reads their own work by id', async () => {
        const id = await privateDraft()
        expect(okJson(await as(CHEF_KEY, 'get_recipe', { id })).title).toBe('Private draft')
        expect(okJson(await as(CHEF_KEY, 'get_resource', { id })).title).toBe('Private draft')
    })

    test('a head chef reads it once it is SUBMITTED, and not before', async () => {
        const id = await privateDraft()
        expect((await as(HEAD_KEY, 'get_recipe', { id })).isError).toBe(true)

        await as(CHEF_KEY, 'bake_recipe', { id })
        expect(okJson(await as(HEAD_KEY, 'get_recipe', { id })).title).toBe('Private draft')
        // A peer still cannot: baked means under review, not published.
        expect((await as(SAUL_KEY, 'get_recipe', { id })).isError).toBe(true)
    })

    test('an ASSIGNEE reads it by id, which is the point of assigning', async () => {
        const id = await privateDraft()
        const steps = okJson(await as(CHEF_KEY, 'list_steps', { recipe_id: id }))
        await as(CHEF_KEY, 'assign_step', { step_id: steps[0].id, assignee: 'saul.goodman@tapcxm.example' })
        expect(okJson(await as(SAUL_KEY, 'get_recipe', { id })).title).toBe('Private draft')
    })

    test('everyone reads it once it is ADMITTED to the CX graph', async () => {
        const id = await privateDraft()
        await as(CHEF_KEY, 'bake_recipe', { id })
        await as(ADMIN_KEY, 'headchef_approve', { recipe_id: id })
        expect(okJson(await as(SAUL_KEY, 'get_recipe', { id })).title).toBe('Private draft')
        expect(okJson(await as(K_VIEWER, 'get_resource', { id })).title).toBe('Private draft')
    })

    test('the refusal does not reveal whether the id exists', async () => {
        const id = await privateDraft()
        const hidden = await as(SAUL_KEY, 'get_resource', { id })
        const absent = await as(SAUL_KEY, 'get_resource', { id: 'recipe-0000000000000-does-not-exist' })
        // Both are refusals. The hidden one must not be distinguishable as "exists but private".
        expect(hidden.isError).toBe(true)
        expect(absent.isError).toBe(true)
    })

    test('a handoff-prompt stays readable, since a brief is addressed to someone else by design', async () => {
        const h = okJson(await as(CHEF_KEY, 'save_resource', {
            type: 'handoff-prompt', title: 'Brief for Saul', content: 'Please build X', project: 'P'
        }))
        expect(okJson(await as(SAUL_KEY, 'get_resource', { id: h.id })).title).toBe('Brief for Saul')
    })
})

/**
 * D96: the name directory. Guessing a display name from an email address only looks right until it
 * does not: "dirk-test@..." rendered as "Dirk Test", which is an account suffix wearing a surname,
 * and the guess then followed him across every recipe he authored.
 */
describe('the name directory (D96)', () => {
    beforeEach(async () => {
        await asKey(ADMIN_KEY, 'create_user', { id: 'dirk-test', password: 'test-pw-kilo-0011', email: 'dirk-test@tapcxm.com', display_name: 'Dirk' })
        await asKey(ADMIN_KEY, 'create_user', { id: 'jesse.pinkman', password: 'test-pw-alpha-0001', email: 'jesse.pinkman@tapcxm.example', display_name: 'Jesse Pinkman' })
    })

    test('anyone signed in can read it, so names do not have to be guessed', async () => {
        const people = okJson(await asKey(CHEF_KEY, 'list_people'))
        const dirk = people.find(p => p.id === 'dirk-test')
        expect(dirk.display_name).toBe('Dirk')
        expect(dirk.owner).toBe('dirk-test@tapcxm.com')
    })

    test('it carries no password material and no account state', async () => {
        const serialized = JSON.stringify(okJson(await asKey(CHEF_KEY, 'list_people')))
        expect(serialized).not.toMatch(/hash|salt|password|roles|disabled/)
    })

    test('a disabled login is left out of the directory', async () => {
        await asKey(ADMIN_KEY, 'set_user_enabled', { id: 'dirk-test', enabled: false })
        const people = okJson(await asKey(CHEF_KEY, 'list_people'))
        expect(people.map(p => p.id)).not.toContain('dirk-test')
    })

    test('a login with no display name falls back to its id rather than inventing one', async () => {
        await asKey(ADMIN_KEY, 'create_user', { id: 'no.name', password: 'test-pw-lima-0012', email: 'no.name@tapcxm.com' })
        const people = okJson(await asKey(CHEF_KEY, 'list_people'))
        expect(people.find(p => p.id === 'no.name').display_name).toBe('no.name')
    })

    test('an admin can correct a name without recreating the account', async () => {
        const out = okJson(await asKey(ADMIN_KEY, 'set_user_display_name', { id: 'dirk-test', display_name: 'Dirk Kruger' }))
        expect(out.display_name).toBe('Dirk Kruger')
        expect(out.was).toBe('Dirk')

        const people = okJson(await asKey(CHEF_KEY, 'list_people'))
        expect(people.find(p => p.id === 'dirk-test').display_name).toBe('Dirk Kruger')
    })

    test('correcting a name does not disturb the login', async () => {
        await asKey(ADMIN_KEY, 'set_user_display_name', { id: 'dirk-test', display_name: 'Dirk' })
        const res = await callWith({ 'x-cookbook-login': 'dirk-test:test-pw-kilo-0011' }, 'get_my_roles')
        expect(res.statusCode).toBe(200)
    })

    test('only an admin may change how someone is shown', async () => {
        const res = await asKey(CHEF_KEY, 'set_user_display_name', { id: 'dirk-test', display_name: 'Not Allowed' })
        expect(res.isError).toBe(true)
        expect(res.content[0].text).toMatch(/only an admin/i)
    })

    test('a blank name is refused, and an unknown login says so', async () => {
        expect((await asKey(ADMIN_KEY, 'set_user_display_name', { id: 'dirk-test', display_name: '   ' })).isError).toBe(true)
        const unknown = await asKey(ADMIN_KEY, 'set_user_display_name', { id: 'ghost', display_name: 'Ghost' })
        expect(unknown.isError).toBe(true)
        expect(unknown.content[0].text).toMatch(/No login found/)
    })
})

/**
 * D98: administering a system is not the same as being entitled to read unfinished work.
 *
 * admin_list_recipes used to pass no visibility filter at all, so an admin read every private draft
 * in the company. A consultant who has not submitted something has not offered it to anyone, and
 * the reviewer allowance exists so a head chef can open a SUBMITTED candidate, not so an admin can
 * browse drafts.
 */
describe('the admin cross-owner view still respects privacy (D98)', () => {
    const SAUL_KEY = 'k-saul'
    const OWNERS = JSON.stringify({
        [ADMIN_KEY]: { userId: 'walter', email: 'walter.white@tapcxm.example', roles: ['chef', 'head-chef', 'admin'] },
        [CHEF_KEY]: { userId: 'jesse', email: 'jesse.pinkman@tapcxm.example', roles: ['chef'] },
        [SAUL_KEY]: { userId: 'saul', email: 'saul.goodman@tapcxm.example', roles: ['chef'] }
    })
    async function as (key, name, args = {}) {
        const res = await main({
            SERVICE_API_KEY: 'svc',
            API_KEY_OWNERS: OWNERS,
            LOG_LEVEL: 'error',
            __ow_method: 'post',
            __ow_headers: { host: 'unit.test', 'x-api-key': key },
            __ow_body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
        })
        return JSON.parse(res.body).result
    }
    const titles = (r) => okJson(r).map(x => x.title)

    /** A private draft of Jesse's: one approved ingredient, never baked, never assigned. */
    async function jesseDraft (title = 'Jesse private draft') {
        const rec = okJson(await as(CHEF_KEY, 'start_recipe', { project: 'P', title }))
        const step = okJson(await as(CHEF_KEY, 'append_step', { recipe_id: rec.id, kind: 'decision', content: 'secret', source: 's' }))
        await as(CHEF_KEY, 'approve_step', { step_id: step.id })
        return rec.id
    }

    test('THE FIX: an admin does NOT see another person\'s private draft', async () => {
        await jesseDraft()
        expect(titles(await as(ADMIN_KEY, 'admin_list_recipes'))).not.toContain('Jesse private draft')
    })

    test('an admin DOES see it once it is submitted for review', async () => {
        const id = await jesseDraft()
        expect(titles(await as(ADMIN_KEY, 'admin_list_recipes'))).not.toContain('Jesse private draft')

        await as(CHEF_KEY, 'bake_recipe', { id })
        expect(titles(await as(ADMIN_KEY, 'admin_list_recipes'))).toContain('Jesse private draft')
    })

    test('an admin sees admitted work, and their own work at any stage', async () => {
        const own = okJson(await as(ADMIN_KEY, 'start_recipe', { project: 'P', title: 'Walter own draft' }))
        expect(own.id).toBeTruthy()
        const id = await jesseDraft('Jesse admitted')
        await as(CHEF_KEY, 'bake_recipe', { id })
        await as(ADMIN_KEY, 'headchef_approve', { recipe_id: id })

        const seen = titles(await as(ADMIN_KEY, 'admin_list_recipes'))
        expect(seen).toContain('Jesse admitted')
        expect(seen).toContain('Walter own draft')
    })

    test('a non-admin cannot reach the cross-owner view at all', async () => {
        const res = await as(SAUL_KEY, 'admin_list_recipes')
        expect(res.isError).toBe(true)
        expect(res.content[0].text).toMatch(/requires the admin role/i)
    })

    test('the owner filter cannot be used to pull up someone else\'s drafts', async () => {
        await jesseDraft()
        const targeted = await as(ADMIN_KEY, 'admin_list_recipes', { owner: 'jesse.pinkman@tapcxm.example' })
        expect(titles(targeted)).not.toContain('Jesse private draft')
    })

    test('nor can the status filter: asking for experimental returns only your own', async () => {
        await jesseDraft()
        const drafts = okJson(await as(ADMIN_KEY, 'admin_list_recipes', { status: 'experimental' }))
        expect(drafts.every(r => r.owner === 'walter.white@tapcxm.example')).toBe(true)
    })

    test('assignment is still honoured in the admin view', async () => {
        const id = await jesseDraft('Jesse assigned draft')
        const steps = okJson(await as(CHEF_KEY, 'list_steps', { recipe_id: id }))
        await as(CHEF_KEY, 'assign_step', { step_id: steps[0].id, assignee: 'walter.white@tapcxm.example' })
        expect(titles(await as(ADMIN_KEY, 'admin_list_recipes'))).toContain('Jesse assigned draft')
    })
})

/**
 * D99: an audit of every read path, after the same class of bug turned up three times. Filtering
 * the obvious list is not the same as filtering every way in, and each of these was a different
 * doorway to the same private content.
 */
describe('every read path is scoped, not just the obvious ones (D99)', () => {
    const SAUL_KEY = 'k-saul'
    const HEAD_KEY = 'k-head'
    const OWNERS = JSON.stringify({
        [ADMIN_KEY]: { userId: 'walter', email: 'walter.white@tapcxm.example', roles: ['chef', 'head-chef', 'admin'] },
        [CHEF_KEY]: { userId: 'jesse', email: 'jesse.pinkman@tapcxm.example', roles: ['chef'] },
        [SAUL_KEY]: { userId: 'saul', email: 'saul.goodman@tapcxm.example', roles: ['chef'] },
        [HEAD_KEY]: { userId: 'mike', email: 'mike.ehrmantraut@tapcxm.example', roles: ['chef', 'head-chef'] }
    })
    async function as (key, name, args = {}) {
        const res = await main({
            SERVICE_API_KEY: 'svc',
            API_KEY_OWNERS: OWNERS,
            LOG_LEVEL: 'error',
            __ow_method: 'post',
            __ow_headers: { host: 'unit.test', 'x-api-key': key },
            __ow_body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
        })
        return JSON.parse(res.body).result
    }
    async function rpc (key, method, params = {}) {
        const res = await main({
            SERVICE_API_KEY: 'svc',
            API_KEY_OWNERS: OWNERS,
            LOG_LEVEL: 'error',
            __ow_method: 'post',
            __ow_headers: { host: 'unit.test', 'x-api-key': key },
            __ow_body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
        })
        return JSON.parse(res.body)
    }

    const SECRET = 'Renegotiation position for a named client'
    /** Jesse's private draft, with a title that is itself sensitive. */
    async function secretDraft () {
        const rec = okJson(await as(CHEF_KEY, 'start_recipe', { project: 'Confidential', title: SECRET }))
        const step = okJson(await as(CHEF_KEY, 'append_step', { recipe_id: rec.id, kind: 'decision', content: 'Walk away below 12 percent.', source: 's' }))
        await as(CHEF_KEY, 'approve_step', { step_id: step.id })
        return rec.id
    }

    test('find_similar no longer surfaces a colleague\'s private recipe', async () => {
        await secretDraft()
        // find_similar is what an AI calls BEFORE saving, so it was a wide-open discovery channel.
        const hits = okJson(await as(SAUL_KEY, 'find_similar', { query: 'renegotiation position' }))
        expect(hits.map(h => h.title)).not.toContain(SECRET)
        // The owner still gets the duplicate warning it exists for.
        expect(okJson(await as(CHEF_KEY, 'find_similar', { query: 'renegotiation position' })).map(h => h.title)).toContain(SECRET)
    })

    test('a title is treated as content, because it often is', async () => {
        await secretDraft()
        const serialized = JSON.stringify(okJson(await as(SAUL_KEY, 'find_similar', { query: 'named client' })))
        expect(serialized).not.toContain('Renegotiation')
    })

    test('get_active_recipe resolves YOUR active recipe, never someone else\'s', async () => {
        await secretDraft()
        const mine = await as(SAUL_KEY, 'get_active_recipe', { project: 'Confidential' })
        const text = JSON.stringify(mine)
        expect(text).not.toContain(SECRET)
    })

    test('the Head Chef queue is for reviewers only', async () => {
        const id = await secretDraft()
        await as(CHEF_KEY, 'bake_recipe', { id })

        const refused = await as(SAUL_KEY, 'list_cx_pending')
        expect(refused.isError).toBe(true)
        expect(refused.content[0].text).toMatch(/head chefs and admins/i)

        // Reviewers get it, which is the point of the queue.
        expect(okJson(await as(HEAD_KEY, 'list_cx_pending')).map(r => r.title)).toContain(SECRET)
        expect(okJson(await as(ADMIN_KEY, 'list_cx_pending')).map(r => r.title)).toContain(SECRET)
    })

    test('an author can still see their own submission without being a reviewer', async () => {
        const id = await secretDraft()
        await as(CHEF_KEY, 'bake_recipe', { id })
        expect(okJson(await as(CHEF_KEY, 'list_recipes')).map(r => r.title)).toContain(SECRET)
    })

    test('the MCP resources/list surface is scoped too', async () => {
        await secretDraft()
        // "approved" alone is not a sharing decision: approving one ingredient promotes the recipe.
        const body = await rpc(SAUL_KEY, 'resources/list')
        const names = (body.result.resources || []).map(r => r.name)
        expect(names).not.toContain(SECRET)
    })

    test('resources/list DOES carry admitted work, so the shared surface still works', async () => {
        const id = await secretDraft()
        await as(CHEF_KEY, 'bake_recipe', { id })
        await as(ADMIN_KEY, 'headchef_approve', { recipe_id: id })

        const body = await rpc(SAUL_KEY, 'resources/list')
        expect((body.result.resources || []).map(r => r.name)).toContain(SECRET)
    })

    test('the duplicate-sibling warning only ever compares your OWN recent work', async () => {
        // Jesse saves something; Saul saving a similar title must not be told about Jesse's recipe.
        await as(CHEF_KEY, 'save_resource', { type: 'decision', title: 'Pricing ladder for a named client', content: 'x', project: 'Confidential' })
        const saul = okJson(await as(SAUL_KEY, 'save_resource', { type: 'decision', title: 'Pricing ladder for a named client', content: 'y', project: 'Confidential' }))
        expect(JSON.stringify(saul)).not.toMatch(/second artifact from the same work/)
    })
})

/**
 * D102: the read paths were closed in D88 and D99, and then every mutation turned out to be gated
 * on callerCanRead - which is the wrong permission. callerCanRead says yes to anything admitted to
 * the CX graph, and save_resource had no gate at all, so a peer who knew an id could overwrite a
 * colleague's private draft, take its authorship, and leave the real author locked out of their
 * own work. Sharing something to be read is not consent to have it rewritten.
 */
describe('writing is a narrower permission than reading (D102)', () => {
    const SAUL_KEY = 'k-saul'
    const HEAD_KEY = 'k-head'
    const OWNERS = JSON.stringify({
        [ADMIN_KEY]: { userId: 'walter', email: 'walter.white@tapcxm.example', roles: ['chef', 'head-chef', 'admin'] },
        [CHEF_KEY]: { userId: 'jesse', email: 'jesse.pinkman@tapcxm.example', roles: ['chef'] },
        [SAUL_KEY]: { userId: 'saul', email: 'saul.goodman@tapcxm.example', roles: ['chef'] },
        [HEAD_KEY]: { userId: 'mike', email: 'mike.ehrmantraut@tapcxm.example', roles: ['chef', 'head-chef'] }
    })
    async function as (key, name, args = {}) {
        const res = await main({
            SERVICE_API_KEY: 'svc',
            API_KEY_OWNERS: OWNERS,
            LOG_LEVEL: 'error',
            __ow_method: 'post',
            __ow_headers: { host: 'unit.test', 'x-api-key': key },
            __ow_body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
        })
        return JSON.parse(res.body).result
    }

    const TITLE = 'Jesse original work'
    /** Jesse's own recipe, with one ingredient on it. */
    async function jesseRecipe () {
        const rec = okJson(await as(CHEF_KEY, 'start_recipe', { project: 'Confidential', title: TITLE }))
        const step = okJson(await as(CHEF_KEY, 'append_step', { recipe_id: rec.id, kind: 'decision', content: 'Jesse wrote this.', source: 's' }))
        return { id: rec.id, stepId: step.id }
    }

    test('a peer cannot overwrite a recipe by passing its id to save_resource', async () => {
        const { id } = await jesseRecipe()
        const stolen = await as(SAUL_KEY, 'save_resource', { id, type: 'decision', title: 'Saul took this over', content: 'overwritten', project: 'Confidential' })
        expect(stolen.isError).toBe(true)
        expect(stolen.content[0].text).toMatch(/not yours to change/i)

        // And the original is untouched, including its author still being able to read it.
        expect(okJson(await as(CHEF_KEY, 'get_recipe', { id })).title).toBe(TITLE)
    })

    test('an update never moves authorship to whoever touched it last', async () => {
        const { id, stepId } = await jesseRecipe()
        // Assignment is the sanctioned way in, so Saul may legitimately write here...
        await as(CHEF_KEY, 'assign_step', { step_id: stepId, assignee: 'saul.goodman@tapcxm.example' })
        const updated = await as(SAUL_KEY, 'save_resource', { id, type: 'decision', title: TITLE, content: 'Saul added a section.', project: 'Confidential' })
        expect(updated.isError).toBeFalsy()

        // ...without becoming its author. Jesse did the work.
        expect(okJson(await as(CHEF_KEY, 'get_recipe', { id })).owner).toBe('jesse.pinkman@tapcxm.example')
        expect(okJson(await as(CHEF_KEY, 'list_recipes')).map(r => r.title)).toContain(TITLE)
    })

    test('a peer cannot append an ingredient to a recipe that is not theirs', async () => {
        const { id } = await jesseRecipe()
        const res = await as(SAUL_KEY, 'append_step', { recipe_id: id, kind: 'decision', content: 'not mine to add', source: 's' })
        expect(res.isError).toBe(true)
        expect(res.content[0].text).toMatch(/not yours to change/i)
    })

    test('a peer cannot approve or discard ingredients that are not theirs', async () => {
        const { id, stepId } = await jesseRecipe()
        expect((await as(SAUL_KEY, 'approve_step', { step_id: stepId })).isError).toBe(true)
        const discarded = await as(SAUL_KEY, 'discard_step', { step_id: stepId })
        expect(discarded.isError).toBe(true)
        expect(discarded.content[0].text).toMatch(/not yours to change/i)
        // The ingredient survived both attempts.
        expect(okJson(await as(CHEF_KEY, 'list_steps', { recipe_id: id }))[0].status).not.toBe('discarded')
    })

    test('a peer cannot bake a recipe that is not theirs, because baking publishes it to reviewers', async () => {
        const { id, stepId } = await jesseRecipe()
        await as(CHEF_KEY, 'approve_step', { step_id: stepId })
        const res = await as(SAUL_KEY, 'bake_recipe', { id })
        expect(res.isError).toBe(true)
        expect(res.content[0].text).toMatch(/not yours to change/i)
        // It never reached the review queue.
        expect(okJson(await as(HEAD_KEY, 'list_cx_pending')).map(r => r.title)).not.toContain(TITLE)
    })

    test('a peer cannot certify a recipe that is not theirs into the shared cookbook', async () => {
        const { id } = await jesseRecipe()
        for (const tool of ['approve_resource', 'certify']) {
            const res = await as(SAUL_KEY, tool, { id })
            expect(res.isError).toBe(true)
            expect(res.content[0].text).toMatch(/not yours to change/i)
        }
    })

    test('being ADMITTED to the CX graph makes a recipe readable, not editable', async () => {
        const { id, stepId } = await jesseRecipe()
        await as(CHEF_KEY, 'approve_step', { step_id: stepId })
        await as(CHEF_KEY, 'bake_recipe', { id })
        await as(ADMIN_KEY, 'headchef_approve', { recipe_id: id })

        // Everyone can read it now, which is the entire point of the shared graph.
        expect(await as(SAUL_KEY, 'get_recipe', { id })).not.toHaveProperty('isError', true)
        // Nobody but its author can change it.
        expect((await as(SAUL_KEY, 'append_step', { recipe_id: id, kind: 'decision', content: 'edit', source: 's' })).isError).toBe(true)
    })

    test('a reviewer judges work without being able to rewrite it', async () => {
        const { id, stepId } = await jesseRecipe()
        await as(CHEF_KEY, 'approve_step', { step_id: stepId })
        await as(CHEF_KEY, 'bake_recipe', { id })

        // Mike can see the submission and rule on it...
        expect(okJson(await as(HEAD_KEY, 'list_cx_pending')).map(r => r.title)).toContain(TITLE)
        // ...but editing the thing you are judging is not a reviewer's power.
        expect((await as(HEAD_KEY, 'append_step', { recipe_id: id, kind: 'decision', content: 'reworded', source: 's' })).isError).toBe(true)
        expect((await as(HEAD_KEY, 'save_resource', { id, type: 'decision', title: 'Reworded by the reviewer', content: 'x', project: 'Confidential' })).isError).toBe(true)
        // The ruling itself still works.
        expect(await as(HEAD_KEY, 'headchef_approve', { recipe_id: id })).not.toHaveProperty('isError', true)
    })

    test('the owner is never locked out of their own work by someone else attempting a write', async () => {
        const { id } = await jesseRecipe()
        await as(SAUL_KEY, 'save_resource', { id, type: 'decision', title: 'hostile', content: 'hostile', project: 'Confidential' })
        // The exact regression: the overwrite reassigned owner, so the author lost their recipe.
        const after = await as(CHEF_KEY, 'get_recipe', { id })
        expect(after).not.toHaveProperty('isError', true)
        expect(okJson(after).title).toBe(TITLE)
    })
})

/**
 * D106: the Cook-off board is the one deliberate cross-owner disclosure in the system, and it
 * exists because a leaderboard that ranks and colours people differently depending on who is
 * looking at it is not a leaderboard. It publishes COUNTS and nothing else.
 */
describe('the Cook-off board is identical for every viewer (D106)', () => {
    const SAUL_KEY = 'k-saul'
    const HEAD_KEY = 'k-head'
    const VIEW_KEY = 'k-view'
    const OWNERS = JSON.stringify({
        [ADMIN_KEY]: { userId: 'walter', email: 'walter.white@tapcxm.example', roles: ['chef', 'head-chef', 'admin'] },
        [CHEF_KEY]: { userId: 'jesse', email: 'jesse.pinkman@tapcxm.example', roles: ['chef'] },
        [SAUL_KEY]: { userId: 'saul', email: 'saul.goodman@tapcxm.example', roles: ['chef'] },
        [HEAD_KEY]: { userId: 'mike', email: 'mike.ehrmantraut@tapcxm.example', roles: ['chef', 'head-chef'] },
        [VIEW_KEY]: { userId: 'guest', email: 'guest@tapcxm.example', roles: ['viewer'] }
    })
    async function as (key, name, args = {}) {
        const res = await main({
            SERVICE_API_KEY: 'svc',
            API_KEY_OWNERS: OWNERS,
            LOG_LEVEL: 'error',
            __ow_method: 'post',
            __ow_headers: { host: 'unit.test', 'x-api-key': key },
            __ow_body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
        })
        return JSON.parse(res.body).result
    }

    const SECRET_TITLE = 'Renegotiation position for a named client'

    /** Jesse submits two recipes and gets one of them admitted: a 50% record. */
    async function jesseSubmitsTwoGetsOneIn () {
        const ids = []
        for (const title of [SECRET_TITLE, 'A second thing Jesse submitted']) {
            const rec = okJson(await as(CHEF_KEY, 'start_recipe', { project: 'Confidential', title }))
            const step = okJson(await as(CHEF_KEY, 'append_step', { recipe_id: rec.id, kind: 'decision', content: 'x', source: 's' }))
            await as(CHEF_KEY, 'approve_step', { step_id: step.id })
            await as(CHEF_KEY, 'bake_recipe', { id: rec.id })
            ids.push(rec.id)
        }
        await as(ADMIN_KEY, 'headchef_approve', { recipe_id: ids[0] })
        return ids
    }

    test('a plain chef and a Head Chef receive byte-identical boards', async () => {
        await jesseSubmitsTwoGetsOneIn()
        const asSaul = await as(SAUL_KEY, 'get_cookoff')
        const asMike = await as(HEAD_KEY, 'get_cookoff')
        // This is the whole bug: the reviewer used to see 50% yellow where everyone else saw blue.
        expect(asSaul.content[0].text).toBe(asMike.content[0].text)
    })

    test('the purity everyone sees is the real one, not a spotless default', async () => {
        await jesseSubmitsTwoGetsOneIn()
        const row = okJson(await as(SAUL_KEY, 'get_cookoff')).find(r => r.owner === 'jesse.pinkman@tapcxm.example')
        expect(row).toBeDefined()
        expect(row.submitted).toBe(2)
        expect(row.admitted).toBe(1)
        expect(row.purity).toBe(50)
    })

    test('a read-only viewer gets the same board as everyone else', async () => {
        await jesseSubmitsTwoGetsOneIn()
        expect((await as(VIEW_KEY, 'get_cookoff')).content[0].text)
            .toBe((await as(ADMIN_KEY, 'get_cookoff')).content[0].text)
    })

    test('it publishes counts and nothing that identifies a recipe', async () => {
        await jesseSubmitsTwoGetsOneIn()
        const board = okJson(await as(SAUL_KEY, 'get_cookoff'))
        const serialized = JSON.stringify(board)
        // The point of the disclosure is the denominator, not the content behind it.
        expect(serialized).not.toContain(SECRET_TITLE)
        expect(serialized).not.toContain('Confidential')
        expect(serialized).not.toMatch(/recipe-\d/)
        for (const row of board) {
            expect(Object.keys(row).sort()).toEqual(['admitted', 'owner', 'purity', 'submitted'])
        }
    })

    test('unsubmitted work is not counted at all, so a private draft stays invisible', async () => {
        await jesseSubmitsTwoGetsOneIn()
        const before = okJson(await as(SAUL_KEY, 'get_cookoff')).find(r => r.owner === 'jesse.pinkman@tapcxm.example')

        // A draft Jesse never bakes must not move any number on the board.
        const draft = okJson(await as(CHEF_KEY, 'start_recipe', { project: 'Confidential', title: 'Never submitted' }))
        await as(CHEF_KEY, 'append_step', { recipe_id: draft.id, kind: 'decision', content: 'y', source: 's' })

        const after = okJson(await as(SAUL_KEY, 'get_cookoff')).find(r => r.owner === 'jesse.pinkman@tapcxm.example')
        expect(after).toEqual(before)
    })

    test('somebody with nothing submitted is not on the board', async () => {
        await jesseSubmitsTwoGetsOneIn()
        const board = okJson(await as(SAUL_KEY, 'get_cookoff'))
        expect(board.map(r => r.owner)).not.toContain('saul.goodman@tapcxm.example')
    })

    test('a spotless record reads 100, which is the only way to cook blue', async () => {
        const rec = okJson(await as(SAUL_KEY, 'start_recipe', { project: 'Open', title: 'Saul got it in first time' }))
        const step = okJson(await as(SAUL_KEY, 'append_step', { recipe_id: rec.id, kind: 'decision', content: 'z', source: 's' }))
        await as(SAUL_KEY, 'approve_step', { step_id: step.id })
        await as(SAUL_KEY, 'bake_recipe', { id: rec.id })
        await as(ADMIN_KEY, 'headchef_approve', { recipe_id: rec.id })

        const row = okJson(await as(CHEF_KEY, 'get_cookoff')).find(r => r.owner === 'saul.goodman@tapcxm.example')
        expect(row.purity).toBe(100)
        expect(row.admitted).toBe(1)
        expect(row.submitted).toBe(1)
    })
})
