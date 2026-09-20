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
 * A signed-in user stays signed in.
 *
 * WHY THIS EXISTS
 *
 * Adobe's Workfront token lasts about a day. When ours lapsed, every Workfront
 * call returned 401, the gateway dropped all 97 tools, intake wrote no fields
 * and review could not comment - and it read as a permissions problem rather
 * than an expiry. Recovering it needed a person with a browser on a machine
 * that could serve a loopback redirect, because Adobe's registration refuses
 * every other kind.
 *
 * None of that was necessary: the sign-in had already stored a refresh token,
 * and spending it works with nobody present. So a 401 is a token to exchange.
 *
 * These tests pin the three things that make it safe: it retries once, it keeps
 * the ROTATED refresh token, and it gives up rather than looping when the grant
 * is genuinely gone.
 */

jest.mock('@adobe/aio-lib-files')

const filesLib = require('@adobe/aio-lib-files')

const SERVER = {
    id: 'workfront-adobe',
    endpoint: 'https://mcp.workfront.adobe.com/mcp/v1/workfront',
    active: true,
    gateway: true,
    auth: 'stale-access-token',
    oauth: {
        client_id: 'client-123',
        refresh_token: 'refresh-abc',
        as: { token_endpoint: 'https://mcp.workfront.adobe.com/oauth/token' }
    }
}

let mcpServers

beforeEach(() => {
    jest.resetModules()
    const data = new Map()
    filesLib.init = jest.fn(async () => ({
        list: jest.fn(async (p) => (data.has(p) ? [{ name: p }] : [])),
        read: jest.fn(async (p) => data.get(p)),
        write: jest.fn(async (p, v) => { data.set(p, v) }),
        delete: jest.fn(async (p) => { data.delete(p) })
    }))
    mcpServers = require('../lib/mcp-servers.js')
})

afterEach(() => { delete global.fetch })

/** A fetch that 401s until the token changes, then succeeds. */
function fetchThatNeedsRefresh ({ refreshOk = true, rotated = 'refresh-def' } = {}) {
    const calls = { upstream: 0, refresh: 0, tokensSeen: [] }
    global.fetch = jest.fn(async (url, opts) => {
        if (String(url).includes('/oauth/token')) {
            calls.refresh++
            if (!refreshOk) return { ok: false, status: 400, json: async () => ({}), text: async () => '{}' }
            return {
                ok: true,
                status: 200,
                json: async () => ({ access_token: 'fresh-token', refresh_token: rotated, expires_in: 86399 })
            }
        }
        calls.upstream++
        const auth = String((opts.headers || {}).Authorization || '')
        calls.tokensSeen.push(auth)
        const good = auth.includes('fresh-token')
        return {
            ok: good,
            status: good ? 200 : 401,
            headers: { get: () => 'application/json' },
            text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } })
        }
    })
    return calls
}

describe('an expired Adobe token refreshes itself', () => {

    test('a 401 is exchanged, not escalated', async () => {
        const calls = fetchThatNeedsRefresh()
        const out = await mcpServers.callTool({ ...SERVER, oauth: { ...SERVER.oauth } }, 'insights_search_fields', { query: 'audience' })
        expect(out).toBeTruthy()
        // One failed call, one refresh, one retry.
        expect(calls.refresh).toBe(1)
        expect(calls.upstream).toBe(2)
        expect(calls.tokensSeen[0]).toContain('stale-access-token')
        expect(calls.tokensSeen[1]).toContain('fresh-token')
    })

    test('it gives up instead of looping when the grant is gone', async () => {
        const calls = fetchThatNeedsRefresh({ refreshOk: false })
        await expect(
            mcpServers.callTool({ ...SERVER, oauth: { ...SERVER.oauth } }, 'insights_search_fields', {})
        ).rejects.toThrow(/401/)
        // Tried once to refresh, did not retry the call, did not storm Adobe.
        expect(calls.refresh).toBe(1)
        expect(calls.upstream).toBe(1)
    })

    test('a server with no refresh token fails plainly', async () => {
        const calls = fetchThatNeedsRefresh()
        const noRefresh = { ...SERVER, oauth: { client_id: 'c', as: { token_endpoint: 'https://x/oauth/token' } } }
        await expect(mcpServers.callTool(noRefresh, 'insights_search_fields', {})).rejects.toThrow(/401/)
        expect(calls.refresh).toBe(0)
    })
})

describe('discovery refreshes too, not just calls', () => {
    /*
     * The refresh was written for exactly this symptom and wired into callTool
     * alone. So an expired token stopped being fixed the moment the failure
     * moved one function to the left: tools/list 401s, the server contributes
     * zero tools, and Workfront vanishes from the estate.
     *
     * Observed live on 20 Sep: "workfront-adobe did not answer (HTTP 401) -
     * contributing no tools", with a refresh token sitting in settings unspent.
     * A marketer would have been told Workfront was simply not there.
     */
    test('a 401 on tools/list is exchanged, not reported as an outage', async () => {
        const calls = fetchThatNeedsRefresh()
        const tools = await mcpServers.listTools({ ...SERVER, oauth: { ...SERVER.oauth } })
        expect(calls.refresh).toBe(1)
        expect(Array.isArray(tools)).toBe(true)
    })

    test('a refusal that survives the refresh is not retried for ever', async () => {
        // A revoked grant needs a person. Looping would be a storm.
        const calls = fetchThatNeedsRefresh({ refreshOk: false })
        await expect(
            mcpServers.listTools({ ...SERVER, oauth: { ...SERVER.oauth } })
        ).rejects.toThrow(/401/)
        expect(calls.refresh).toBe(1)
    })
})
