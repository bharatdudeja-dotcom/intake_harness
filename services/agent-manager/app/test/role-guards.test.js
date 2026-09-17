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
 * Role-guard enforcement through the real tool path (D66): a NON-privileged per-user caller
 * (resolved via the OIDC userinfo path, so a real email owner - not the admin service account)
 * is refused admin-only and head-chef-only tools; the admin service-account path is allowed.
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

const { main } = require('../actions/mcp-server/index.js')

/** Drive a tool call as a per-user OIDC caller (userinfo path) with the given email identity. */
async function callAsUser (email, name, args) {
    // Route by URL (not call order) - the OIDC discovery doc is cached module-level across tests,
    // so an order-based mock would desync after the first call.
    global.fetch = jest.fn(async (url) => String(url).includes('/userinfo')
        ? ({ ok: true, json: async () => ({ sub: email, email }) })
        : ({ ok: true, json: async () => ({ userinfo_endpoint: 'https://issuer.example.com/userinfo' }) }))
    const res = await main({
        OIDC_ISSUER: 'https://issuer.example.com', // no audience -> userinfo path -> per-user owner
        LOG_LEVEL: 'error',
        __ow_method: 'post',
        __ow_headers: { authorization: 'Bearer user-token', host: 'unit.test' },
        __ow_body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    })
    return JSON.parse(res.body)
}

/** Drive a tool call as the shared service-account (x-api-key path = admin operator). */
async function callAsService (name, args) {
    const res = await main({
        SERVICE_API_KEY: 'k', LOG_LEVEL: 'error',
        __ow_method: 'post', __ow_headers: { 'x-api-key': 'k', host: 'unit.test' },
        __ow_body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    })
    return JSON.parse(res.body)
}

describe('role guards through the tool path (D66)', () => {
    test('a non-admin per-user caller is REFUSED set_user_roles', async () => {
        const res = await callAsUser('alice@example.com', 'set_user_roles', { owner: 'bob@example.com', roles: ['admin'] })
        expect(res.result.isError).toBe(true)
        expect(res.result.content[0].text).toMatch(/only an admin/i)
    })

    test('a non-admin per-user caller is REFUSED list_user_roles', async () => {
        const res = await callAsUser('alice@example.com', 'list_user_roles', {})
        expect(res.result.isError).toBe(true)
        expect(res.result.content[0].text).toMatch(/only an admin/i)
    })

    test('a non-head-chef per-user caller is REFUSED headchef_approve', async () => {
        const res = await callAsUser('alice@example.com', 'headchef_approve', { job_id: 'whatever' })
        expect(res.result.isError).toBe(true)
        expect(res.result.content[0].text).toMatch(/Head Chef/i)
    })

    test('get_my_roles is open to anyone and reports the per-user identity as a plain chef', async () => {
        const res = await callAsUser('alice@example.com', 'get_my_roles', {})
        const out = JSON.parse(res.result.content[0].text)
        expect(out.owner).toBe('alice@example.com')
        expect(out.roles).toEqual(['chef'])
    })

    test('the service-account (x-api-key) path IS admin and may assign roles', async () => {
        const res = await callAsService('set_user_roles', { owner: 'bob@example.com', roles: ['head-chef', 'admin'] })
        const out = JSON.parse(res.result.content[0].text)
        expect(out.owner).toBe('bob@example.com')
        expect(out.roles).toEqual(['chef', 'head-chef', 'admin'])
    })
})
