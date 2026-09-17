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
 * Tests for the dashboard-api proxy action (Increment 6, D29): the no-secret
 * bridge between the control-plane dashboard SPA and the mcp-server action.
 * The upstream mcp-server is stubbed via a mocked global.fetch, so these tests
 * exercise only the proxy's own behavior - auth injection, method/tool
 * allowlisting, passthrough, and error mapping.
 */

const { main } = require('../actions/dashboard-api/index.js')

const TEST_KEY = 'test-service-key'

function baseParams (overrides = {}) {
    return {
        SERVICE_API_KEY: TEST_KEY,
        MCP_RESOURCE_URL: 'https://example.adobeioruntime.net/api/v1/web/tap-mcp-connector/mcp-server',
        MCP_PRM_URL: 'https://example.adobeioruntime.net/api/v1/web/tap-mcp-connector/well-known',
        OIDC_ISSUER: 'https://dev-example.us.auth0.com/',
        OIDC_AUDIENCE: 'https://tap-mcp-connector',
        OIDC_REQUIRED_SCOPE: 'resource.rw',
        LOG_LEVEL: 'error',
        // Most cases below exercise the legacy single-tenant shared-key mode explicitly. The
        // PRODUCT default is the opposite (identity required, D79) - covered in its own block.
        DASHBOARD_REQUIRE_IDENTITY: 'false',
        ...overrides
    }
}

function rpcBody (method, params = {}, id = 1) {
    return JSON.stringify({ jsonrpc: '2.0', id, method, params })
}

beforeEach(() => {
    global.fetch = jest.fn()
})

describe('dashboard-api - GET (connections/seams info)', () => {
    test('returns connector info without ever reading the service key or client secret into the response', async () => {
        const result = await main(baseParams({ OAUTH_CLIENT_SECRET: 'super-secret', OAUTH_CLIENT_ID: 'client-abc' }))

        expect(result.statusCode).toBe(200)
        const body = JSON.parse(result.body)
        expect(body.seams.oidc.issuer).toBe('https://dev-example.us.auth0.com/')
        expect(body.seams.oidc.audience).toBe('https://tap-mcp-connector')
        // the whole response, serialized, must never contain the secret or the api key
        expect(result.body).not.toContain('super-secret')
        expect(result.body).not.toContain(TEST_KEY)
        expect(result.body).not.toContain('client-abc')
    })

    test('OPTIONS with no Origin header falls back to the stage static origin', async () => {
        const result = await main({ __ow_method: 'options' })
        expect(result.statusCode).toBe(200)
        expect(result.headers['Access-Control-Allow-Origin']).toBe('https://110557-tapmcpconnector-stage.adobeio-static.net')
    })
})

describe('dashboard-api - CORS (D29 fix: SPA on adobeio-static.net calling this action on adobeioruntime.net)', () => {
    test('OPTIONS preflight reflects a *.adobeio-static.net Origin and bypasses auth entirely', async () => {
        const result = await main({
            __ow_method: 'options',
            __ow_headers: { origin: 'https://110557-tapmcpconnector-stage.adobeio-static.net', 'access-control-request-method': 'POST' }
            // deliberately no SERVICE_API_KEY / MCP_RESOURCE_URL - preflight must not need them
        })
        expect(result.statusCode).toBe(200)
        expect(result.headers['Access-Control-Allow-Origin']).toBe('https://110557-tapmcpconnector-stage.adobeio-static.net')
        expect(result.headers['Access-Control-Allow-Methods']).toContain('POST')
        expect(global.fetch).not.toHaveBeenCalled()
    })

    test('does not reflect an arbitrary third-party origin - falls back to the stage static origin instead', async () => {
        const result = await main({ __ow_method: 'options', __ow_headers: { origin: 'https://evil.example.com' } })
        expect(result.headers['Access-Control-Allow-Origin']).toBe('https://110557-tapmcpconnector-stage.adobeio-static.net')
    })

    test('a normal POST response also carries Access-Control-Allow-Origin reflecting the caller', async () => {
        global.fetch.mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })

        const result = await main(baseParams({
            __ow_method: 'post',
            __ow_headers: { origin: 'https://110557-tapmcpconnector-stage.adobeio-static.net' },
            __ow_body: rpcBody('tools/list')
        }))

        expect(result.statusCode).toBe(200)
        expect(result.headers['Access-Control-Allow-Origin']).toBe('https://110557-tapmcpconnector-stage.adobeio-static.net')
    })

    test('error responses (allowlist rejection, misconfiguration) also carry Access-Control-Allow-Origin', async () => {
        const result = await main(baseParams({
            SERVICE_API_KEY: '',
            __ow_method: 'post',
            __ow_headers: { origin: 'https://110557-tapmcpconnector-stage.adobeio-static.net' },
            __ow_body: rpcBody('tools/list')
        }))
        expect(result.statusCode).toBe(500)
        expect(result.headers['Access-Control-Allow-Origin']).toBe('https://110557-tapmcpconnector-stage.adobeio-static.net')
    })
})

describe('dashboard-api - auth injection', () => {
    test('forwards an allowlisted method to the upstream MCP server with x-api-key attached, never exposing it to the caller', async () => {
        global.fetch.mockResolvedValueOnce({
            status: 200,
            text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
        })

        const result = await main(baseParams({ __ow_method: 'post', __ow_body: rpcBody('tools/list') }))

        expect(result.statusCode).toBe(200)
        expect(global.fetch).toHaveBeenCalledTimes(1)
        const [url, init] = global.fetch.mock.calls[0]
        expect(url).toBe('https://example.adobeioruntime.net/api/v1/web/tap-mcp-connector/mcp-server')
        expect(init.headers['x-api-key']).toBe(TEST_KEY)
        // the key must never appear in what's sent back to the browser
        expect(result.body).not.toContain(TEST_KEY)
        expect(JSON.stringify(result.headers)).not.toContain(TEST_KEY)
    })

    test('errors clearly if SERVICE_API_KEY is not configured, without calling upstream', async () => {
        const result = await main(baseParams({ SERVICE_API_KEY: '', __ow_method: 'post', __ow_body: rpcBody('tools/list') }))

        expect(result.statusCode).toBe(500)
        expect(global.fetch).not.toHaveBeenCalled()
        const body = JSON.parse(result.body)
        expect(body.error.message).toMatch(/SERVICE_API_KEY/)
    })

    test('errors clearly if MCP_RESOURCE_URL is not configured, without calling upstream', async () => {
        const result = await main(baseParams({ MCP_RESOURCE_URL: '', __ow_method: 'post', __ow_body: rpcBody('tools/list') }))

        expect(result.statusCode).toBe(500)
        expect(global.fetch).not.toHaveBeenCalled()
        const body = JSON.parse(result.body)
        expect(body.error.message).toMatch(/MCP_RESOURCE_URL/)
    })
})

describe('dashboard-api - per-user IMS login (D65)', () => {
    test('GET info advertises login disabled when no DASHBOARD_OAUTH_CLIENT_ID', async () => {
        const result = await main(baseParams())
        const body = JSON.parse(result.body)
        expect(body.login.enabled).toBe(false)
    })

    test('GET info advertises login enabled + PUBLIC config (client id, issuer) when configured', async () => {
        const result = await main(baseParams({ DASHBOARD_OAUTH_CLIENT_ID: 'spa-public-123' }))
        const body = JSON.parse(result.body)
        expect(body.login.enabled).toBe(true)
        expect(body.login.clientId).toBe('spa-public-123')
        expect(body.login.issuer).toBe('https://dev-example.us.auth0.com/')
        // never leak the confidential service key or client secret into the public info doc
        expect(result.body).not.toContain(TEST_KEY)
    })

    test('when login is configured, a signed-in Bearer is forwarded to upstream (NOT the shared key)', async () => {
        global.fetch.mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })
        const result = await main(baseParams({
            DASHBOARD_OAUTH_CLIENT_ID: 'spa-public-123',
            __ow_method: 'post',
            __ow_headers: { authorization: 'Bearer USER-IMS-TOKEN' },
            __ow_body: rpcBody('tools/call', { name: 'list_jobs', arguments: {} })
        }))
        expect(result.statusCode).toBe(200)
        const [, init] = global.fetch.mock.calls[0]
        expect(init.headers.Authorization).toBe('Bearer USER-IMS-TOKEN')
        expect(init.headers['x-api-key']).toBeUndefined() // shared key never used in per-user mode
    })

    test('when login is configured, a request with NO Bearer is rejected 401 (no anonymous fallback)', async () => {
        const result = await main(baseParams({
            DASHBOARD_OAUTH_CLIENT_ID: 'spa-public-123',
            __ow_method: 'post',
            __ow_body: rpcBody('tools/call', { name: 'list_jobs', arguments: {} })
        }))
        expect(result.statusCode).toBe(401)
        expect(global.fetch).not.toHaveBeenCalled()
        expect(JSON.parse(result.body).error.message).toMatch(/[Ss]ign-in required/)
    })

    test('when login is NOT configured, anonymous shared-key mode still works (back-compat)', async () => {
        global.fetch.mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })
        const result = await main(baseParams({ __ow_method: 'post', __ow_body: rpcBody('tools/call', { name: 'list_jobs', arguments: {} }) }))
        expect(result.statusCode).toBe(200)
        const [, init] = global.fetch.mock.calls[0]
        expect(init.headers['x-api-key']).toBe(TEST_KEY)
        expect(init.headers.Authorization).toBeUndefined()
    })

    test('a signed-in Bearer is forwarded even in anonymous-capable deployments (per-user takes precedence)', async () => {
        global.fetch.mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })
        const result = await main(baseParams({
            __ow_method: 'post',
            __ow_headers: { authorization: 'Bearer USER-TOKEN' },
            __ow_body: rpcBody('tools/call', { name: 'list_jobs', arguments: {} })
        }))
        expect(result.statusCode).toBe(200)
        const [, init] = global.fetch.mock.calls[0]
        expect(init.headers.Authorization).toBe('Bearer USER-TOKEN')
        expect(init.headers['x-api-key']).toBeUndefined()
    })

    test('CORS allows the Authorization header so the browser can send the Bearer', async () => {
        const result = await main({ __ow_method: 'options', __ow_headers: { origin: 'https://110557-tapmcpconnector-stage.adobeio-static.net' } })
        expect(result.headers['Access-Control-Allow-Headers']).toMatch(/Authorization/)
    })
})

describe('dashboard-api - interim static-passcode lock (D65 stopgap)', () => {
    const rpcCall = () => rpcBody('tools/call', { name: 'list_jobs', arguments: {} })

    test('GET info advertises whether a passcode is required, never the passcode itself', async () => {
        const off = JSON.parse((await main(baseParams())).body)
        expect(off.passcodeRequired).toBe(false)
        const on = JSON.parse((await main(baseParams({ DASHBOARD_PASSCODE: 'test-passcode' }))).body)
        expect(on.passcodeRequired).toBe(true)
        expect(JSON.stringify(on)).not.toContain('test-passcode')
    })

    test('a data call with NO passcode is rejected 401 without hitting upstream', async () => {
        const result = await main(baseParams({ DASHBOARD_PASSCODE: 'test-passcode', __ow_method: 'post', __ow_body: rpcCall() }))
        expect(result.statusCode).toBe(401)
        expect(global.fetch).not.toHaveBeenCalled()
        expect(JSON.parse(result.body).error.message).toMatch(/locked|access code/i)
    })

    test('a data call with the WRONG passcode is rejected 401', async () => {
        const result = await main(baseParams({
            DASHBOARD_PASSCODE: 'test-passcode', __ow_method: 'post',
            __ow_headers: { 'x-cookbook-passcode': '0000' }, __ow_body: rpcCall()
        }))
        expect(result.statusCode).toBe(401)
        expect(global.fetch).not.toHaveBeenCalled()
    })

    test('a data call with the CORRECT passcode is proxied through', async () => {
        global.fetch.mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })
        const result = await main(baseParams({
            DASHBOARD_PASSCODE: 'test-passcode', __ow_method: 'post',
            __ow_headers: { 'x-cookbook-passcode': 'test-passcode' }, __ow_body: rpcCall()
        }))
        expect(result.statusCode).toBe(200)
        expect(global.fetch).toHaveBeenCalledTimes(1)
    })

    test('a near-miss (correct prefix, wrong length) is rejected - no length/prefix leak', async () => {
        const result = await main(baseParams({
            DASHBOARD_PASSCODE: 'test-passcode', __ow_method: 'post',
            __ow_headers: { 'x-cookbook-passcode': 'test-pass' }, __ow_body: rpcCall()
        }))
        expect(result.statusCode).toBe(401)
    })

    test('when no passcode is configured, calls pass through without one (back-compat)', async () => {
        global.fetch.mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })
        const result = await main(baseParams({ __ow_method: 'post', __ow_body: rpcCall() }))
        expect(result.statusCode).toBe(200)
    })

    test('CORS allows the x-cookbook-passcode header', async () => {
        const result = await main({ __ow_method: 'options', __ow_headers: { origin: 'https://110557-tapmcpconnector-stage.adobeio-static.net' } })
        expect(result.headers['Access-Control-Allow-Headers']).toMatch(/x-cookbook-passcode/)
    })
})

describe('dashboard-api - method allowlist', () => {
    test('passes through resources/list, resources/read, prompts/list, prompts/get, initialize', async () => {
        const allowed = ['initialize', 'tools/list', 'resources/list', 'resources/read', 'prompts/list', 'prompts/get']
        for (const method of allowed) {
            global.fetch.mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })
            const result = await main(baseParams({ __ow_method: 'post', __ow_body: rpcBody(method) }))
            expect(result.statusCode).toBe(200)
        }
        expect(global.fetch).toHaveBeenCalledTimes(allowed.length)
    })

    test('rejects a non-allowlisted JSON-RPC method without calling upstream', async () => {
        const result = await main(baseParams({ __ow_method: 'post', __ow_body: rpcBody('notifications/cancelled') }))

        expect(result.statusCode).toBe(403)
        expect(global.fetch).not.toHaveBeenCalled()
        const body = JSON.parse(result.body)
        expect(body.error.message).toMatch(/not available through the dashboard proxy/)
    })

    test('rejects a malformed body (no method)', async () => {
        const result = await main(baseParams({ __ow_method: 'post', __ow_body: JSON.stringify({ jsonrpc: '2.0', id: 1 }) }))
        expect(result.statusCode).toBe(400)
        expect(global.fetch).not.toHaveBeenCalled()
    })

    test('rejects unsupported HTTP methods', async () => {
        const result = await main(baseParams({ __ow_method: 'put' }))
        expect(result.statusCode).toBe(405)
    })
})

describe('dashboard-api - tool allowlist (observe + approve, not author)', () => {
    test('allows read/consent/skill/task tools incl. certify + get_segmentation_config (D43)', async () => {
        const tools = [
            'get_resource_policy', 'list_resource_types', 'get_segmentation_config',
            'list_resources', 'search_resources', 'get_resource',
            'approve_resource', 'certify', 'export_as_skill', 'list_active_tasks', 'set_task_status'
        ]
        for (const name of tools) {
            global.fetch.mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })
            const result = await main(baseParams({ __ow_method: 'post', __ow_body: rpcBody('tools/call', { name, arguments: {} }) }))
            expect(result.statusCode).toBe(200)
        }
        expect(global.fetch).toHaveBeenCalledTimes(tools.length)
    })

    test('allows the Increment 12 daily-driver reads + lifecycle writes + guarded update_settings (D48)', async () => {
        const tools = [
            // reads
            'get_job', 'list_jobs', 'list_steps', 'list_projects', 'get_settings',
            // consent / lifecycle writes
            'approve_step', 'approve_steps', 'discard_step', 'bake_job', 'bake_project', 'set_project_status',
            // guarded settings write
            'update_settings',
            // CX graph: read + guarded rebuild (D53)
            'get_cx_graph', 'rebuild_cx_graph',
            // Head Chef CX-graph gate (D64): role/queue reads + guarded admit/reject writes
            'get_role', 'list_cx_pending', 'headchef_approve', 'headchef_reject',
            // Multi-role RBAC (D66): role reads + self-guarded set_user_roles
            'get_my_roles', 'list_user_roles', 'set_user_roles'
        ]
        for (const name of tools) {
            global.fetch.mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })
            const result = await main(baseParams({ __ow_method: 'post', __ow_body: rpcBody('tools/call', { name, arguments: {} }) }))
            expect(result.statusCode).toBe(200)
        }
        expect(global.fetch).toHaveBeenCalledTimes(tools.length)
    })

    test('rejects set_head_chefs through the proxy - roster changes are admin/x-api-key only (D64)', async () => {
        const result = await main(baseParams({
            __ow_method: 'post',
            __ow_body: rpcBody('tools/call', { name: 'set_head_chefs', arguments: { head_chefs: ['x'] } })
        }))
        expect(result.statusCode).toBe(403)
        expect(global.fetch).not.toHaveBeenCalled()
    })

test('rejects the admin list tools - the dashboard has one view and does not call them (D103)', async () => {
        // These were proxied for a "My view / All owners" toggle. D98 scoped them to the same
        // visibility rules as every other read, so the toggle promised a cross-owner view it could
        // not deliver; D103 removed the toggle, and the proxy surface goes with it.
        for (const name of ['admin_list_jobs', 'admin_list_projects']) {
            const result = await main(baseParams({
                __ow_method: 'post',
                __ow_body: rpcBody('tools/call', { name, arguments: {} })
            }))
            expect(result.statusCode).toBe(403)
        }
        expect(global.fetch).not.toHaveBeenCalled()
    })

    test('rejects the destructive admin_reset_data tool - never reachable through the dashboard proxy (D52)', async () => {
        const result = await main(baseParams({
            __ow_method: 'post',
            __ow_body: rpcBody('tools/call', { name: 'admin_reset_data', arguments: { confirm: true } })
        }))
        expect(result.statusCode).toBe(403)
        expect(global.fetch).not.toHaveBeenCalled()
    })

    test('still rejects the capture/authoring writes: start_job, append_step, start_project, general save_resource (D48)', async () => {
        for (const name of ['start_job', 'append_step', 'start_project', 'set_work_context']) {
            const result = await main(baseParams({
                __ow_method: 'post',
                __ow_body: rpcBody('tools/call', { name, arguments: {} })
            }))
            expect(result.statusCode).toBe(403)
        }
        // general save_resource (non-handoff) is still blocked - the dashboard does not author jobs
        const save = await main(baseParams({
            __ow_method: 'post',
            __ow_body: rpcBody('tools/call', { name: 'save_resource', arguments: { type: 'decision', title: 't', content: 'c' } })
        }))
        expect(save.statusCode).toBe(403)
        expect(global.fetch).not.toHaveBeenCalled()
    })

    test('blocks save_resource for any type other than handoff-prompt - the dashboard observes and approves, it does not author', async () => {
        const result = await main(baseParams({
            __ow_method: 'post',
            __ow_body: rpcBody('tools/call', { name: 'save_resource', arguments: { type: 'decision', title: 't', content: 'c' } })
        }))

        expect(result.statusCode).toBe(403)
        expect(global.fetch).not.toHaveBeenCalled()
        const body = JSON.parse(result.body)
        expect(body.error.message).toMatch(/save_resource/)
        expect(body.error.message).toMatch(/handoff-prompt/)
    })

    test('allows save_resource scoped to type=handoff-prompt (the "Log a prompt" action, D37)', async () => {
        global.fetch.mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })

        const result = await main(baseParams({
            __ow_method: 'post',
            __ow_body: rpcBody('tools/call', {
                name: 'save_resource',
                arguments: { type: 'handoff-prompt', title: 'Fix the build', content: 'do the thing', target_agent: 'claude-code' }
            })
        }))

        expect(result.statusCode).toBe(200)
        expect(global.fetch).toHaveBeenCalledTimes(1)
    })

    test('blocks append_step for any kind other than image/diagram - the dashboard does not author job content (D58)', async () => {
        const result = await main(baseParams({
            __ow_method: 'post',
            __ow_body: rpcBody('tools/call', { name: 'append_step', arguments: { job_id: 'r1', kind: 'message', content: 'hi' } })
        }))

        expect(result.statusCode).toBe(403)
        expect(global.fetch).not.toHaveBeenCalled()
        const body = JSON.parse(result.body)
        expect(body.error.message).toMatch(/append_step/)
        expect(body.error.message).toMatch(/image.*diagram|diagram.*image/)
    })

    test('allows append_step scoped to kind=image or kind=diagram (the "Attach diagram/image" fallback, D58)', async () => {
        global.fetch.mockResolvedValue({ status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })

        const image = await main(baseParams({
            __ow_method: 'post',
            __ow_body: rpcBody('tools/call', { name: 'append_step', arguments: { job_id: 'r1', kind: 'image', asset: { data: 'AAAA', mime_type: 'image/png' } } })
        }))
        expect(image.statusCode).toBe(200)

        const diagram = await main(baseParams({
            __ow_method: 'post',
            __ow_body: rpcBody('tools/call', { name: 'append_step', arguments: { job_id: 'r1', kind: 'diagram', format: 'mermaid', content: 'graph TD; A-->B' } })
        }))
        expect(diagram.statusCode).toBe(200)
        expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    test('rejects link_jobs - not part of the dashboard allowlist (out of scope this increment)', async () => {
        const result = await main(baseParams({
            __ow_method: 'post',
            __ow_body: rpcBody('tools/call', { name: 'link_jobs', arguments: { handoff_id: 'x', job_ids: ['y'] } })
        }))
        expect(result.statusCode).toBe(403)
        expect(global.fetch).not.toHaveBeenCalled()
    })

    test('still rejects other writes: start_project and set_work_context are not proxied (D43 - read/consent only)', async () => {
        for (const name of ['start_project', 'set_work_context']) {
            const result = await main(baseParams({
                __ow_method: 'post',
                __ow_body: rpcBody('tools/call', { name, arguments: { name: 'X' } })
            }))
            expect(result.statusCode).toBe(403)
        }
        expect(global.fetch).not.toHaveBeenCalled()
    })

    test('certify with a consent note passes through with the key attached', async () => {
        global.fetch.mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })
        const result = await main(baseParams({
            __ow_method: 'post',
            __ow_body: rpcBody('tools/call', { name: 'certify', arguments: { id: 'r1', note: 'looks right' } })
        }))
        expect(result.statusCode).toBe(200)
        const [, init] = global.fetch.mock.calls[0]
        expect(init.headers['x-api-key']).toBe(TEST_KEY)
        expect(result.body).not.toContain(TEST_KEY)
    })

    test('blocks an unknown tool name', async () => {
        const result = await main(baseParams({
            __ow_method: 'post',
            __ow_body: rpcBody('tools/call', { name: 'delete_everything', arguments: {} })
        }))
        expect(result.statusCode).toBe(403)
        expect(global.fetch).not.toHaveBeenCalled()
    })
})

describe('dashboard-api - error mapping', () => {
    test('maps an upstream network failure to a 502 JSON-RPC error', async () => {
        global.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))

        const result = await main(baseParams({ __ow_method: 'post', __ow_body: rpcBody('tools/list') }))

        expect(result.statusCode).toBe(502)
        const body = JSON.parse(result.body)
        expect(body.error.message).toMatch(/Upstream MCP server unreachable/)
    })

    test('passes through an upstream error status and body unchanged', async () => {
        global.fetch.mockResolvedValueOnce({
            status: 401,
            text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'unauthorized upstream' } })
        })

        const result = await main(baseParams({ __ow_method: 'post', __ow_body: rpcBody('tools/list') }))

        expect(result.statusCode).toBe(401)
        const body = JSON.parse(result.body)
        expect(body.error.message).toBe('unauthorized upstream')
    })
})

describe('dashboard-api - each user opens THEIR OWN cookbook (D79)', () => {
    const identityParams = (overrides = {}) => baseParams({ DASHBOARD_REQUIRE_IDENTITY: 'true', ...overrides })

    test('identity is required BY DEFAULT - an unset flag must not silently share one view', async () => {
        const params = baseParams({ __ow_method: 'post', __ow_body: rpcBody('tools/list') })
        delete params.DASHBOARD_REQUIRE_IDENTITY

        const result = await main(params)

        expect(result.statusCode).toBe(401)
        expect(global.fetch).not.toHaveBeenCalled()
        expect(JSON.parse(result.body).error.message).toMatch(/sign in to open your own view/i)
    })

    test('a caller with no identity is refused, NOT quietly given the shared service view', async () => {
        const result = await main(identityParams({ __ow_method: 'post', __ow_body: rpcBody('tools/list') }))

        expect(result.statusCode).toBe(401)
        expect(global.fetch).not.toHaveBeenCalled()
        // The refusal must explain the privacy model, not just say "denied".
        expect(JSON.parse(result.body).error.message).toMatch(/private to you|visible to everyone/i)
    })

    test('the user\'s OWN key is forwarded upstream as x-api-key, so the MCP server resolves them', async () => {
        global.fetch.mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })

        const result = await main(identityParams({
            __ow_method: 'post',
            __ow_headers: { 'x-cookbook-user-key': 'tap_alice_abc123' },
            __ow_body: rpcBody('tools/list')
        }))

        expect(result.statusCode).toBe(200)
        const [, init] = global.fetch.mock.calls[0]
        expect(init.headers['x-api-key']).toBe('tap_alice_abc123')
        // The SHARED key must never be substituted or leaked once a user identified themselves.
        expect(init.headers['x-api-key']).not.toBe(TEST_KEY)
        expect(result.body).not.toContain(TEST_KEY)
    })

    test('two different keys reach upstream as two different identities', async () => {
        global.fetch
            .mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })
            .mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })

        await main(identityParams({ __ow_method: 'post', __ow_headers: { 'x-cookbook-user-key': 'tap_alice_1' }, __ow_body: rpcBody('tools/list') }))
        await main(identityParams({ __ow_method: 'post', __ow_headers: { 'x-cookbook-user-key': 'tap_bob_2' }, __ow_body: rpcBody('tools/list') }))

        expect(global.fetch.mock.calls[0][1].headers['x-api-key']).toBe('tap_alice_1')
        expect(global.fetch.mock.calls[1][1].headers['x-api-key']).toBe('tap_bob_2')
    })

    test('a signed-in IMS token still WINS over a stale pasted key', async () => {
        global.fetch.mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })

        await main(identityParams({
            __ow_method: 'post',
            __ow_headers: { authorization: 'Bearer user-ims-token', 'x-cookbook-user-key': 'tap_alice_1' },
            __ow_body: rpcBody('tools/list')
        }))

        const [, init] = global.fetch.mock.calls[0]
        expect(init.headers.Authorization).toBe('Bearer user-ims-token')
        expect(init.headers['x-api-key']).toBeUndefined()
    })

    test('the passcode gate still applies before identity - both locks, in order', async () => {
        const result = await main(identityParams({
            DASHBOARD_PASSCODE: 'test-gate-code',
            __ow_method: 'post',
            __ow_headers: { 'x-cookbook-user-key': 'tap_alice_1' },
            __ow_body: rpcBody('tools/list')
        }))

        expect(result.statusCode).toBe(401)
        expect(JSON.parse(result.body).error.message).toMatch(/locked/i)
        expect(global.fetch).not.toHaveBeenCalled()
    })

    test('GET info tells the SPA a login is required, and leaks no credential value', async () => {
        const result = await main(identityParams({ DASHBOARD_PASSCODE: 'test-gate-code' }))

        const body = JSON.parse(result.body)
        expect(body.identity).toEqual(expect.objectContaining({ required: true, loginSupported: true }))
        expect(body.passcodeRequired).toBe(true)
        expect(result.body).not.toContain('test-gate-code')
        expect(result.body).not.toContain(TEST_KEY)
    })

    test('CORS advertises the user-key header, or the browser would strip it', async () => {
        const result = await main(identityParams({ __ow_method: 'options', __ow_headers: { origin: 'https://x.adobeio-static.net' } }))

        expect(result.headers['Access-Control-Allow-Headers']).toMatch(/x-cookbook-user-key/)
    })

    test('DASHBOARD_REQUIRE_IDENTITY=false keeps the single-tenant demo mode working', async () => {
        global.fetch.mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })

        const result = await main(baseParams({ __ow_method: 'post', __ow_body: rpcBody('tools/list') }))

        expect(result.statusCode).toBe(200)
        expect(global.fetch.mock.calls[0][1].headers['x-api-key']).toBe(TEST_KEY)
    })
})
