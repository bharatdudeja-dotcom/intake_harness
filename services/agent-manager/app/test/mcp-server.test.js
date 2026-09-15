/*
Copyright 2022 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/

/**
 * End-to-end tests for the MCP server action, driven through main() with
 * real JSON-RPC request bodies (matches how Adobe I/O Runtime invokes it).
 *
 * @adobe/aio-lib-files is faked out with an in-memory map so the resource
 * loop (save_resource/list_resources/search_resources/get_resource) can be
 * exercised end to end without real Azure/TVM credentials. Tool-call tests
 * authenticate via x-api-key (SERVICE_API_KEY) - the dual-auth OIDC path is
 * exercised separately in the "Dual auth" section below and in
 * test/auth-oidc.test.js / test/auth-resolver.test.js.
 */

jest.mock('@adobe/aio-lib-files')

const filesLib = require('@adobe/aio-lib-files')

const TEST_API_KEY = 'test-api-key'
const HOST = '110557-tapmcpconnector-stage.adobeioruntime.net'

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

/** @returns {Record<string, any>} base params authenticated via x-api-key, merged with overrides */
function authedParams (overrides = {}) {
    return {
        SERVICE_API_KEY: TEST_API_KEY,
        __ow_headers: { 'x-api-key': TEST_API_KEY, host: HOST },
        LOG_LEVEL: 'info',
        ...overrides
    }
}

/** @returns {Promise<object>} parsed JSON-RPC response body for a tools/call or other JSON-RPC method */
async function rpc (method, params = {}, id = 1, paramOverrides = {}) {
    const result = await main(authedParams({
        __ow_method: 'post',
        __ow_body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        ...paramOverrides
    }))
    return { result, body: JSON.parse(result.body) }
}

/** @returns {Promise<object>} parsed tool result (content array + optional isError) for a tools/call */
async function callTool (name, args, id = 1) {
    const { body } = await rpc('tools/call', { name, arguments: args }, id)
    return body
}

describe('MCP Server - Company Connector', () => {
    describe('Health Check', () => {
        test('should respond to an AUTHENTICATED GET request with health status', async () => {
            const result = await main({ __ow_method: 'get', __ow_path: '/', LOG_LEVEL: 'info', SERVICE_API_KEY: 'k', __ow_headers: { 'x-api-key': 'k' } })

            expect(result.statusCode).toBe(200)
            expect(result.headers['Content-Type']).toBe('application/json')

            const body = JSON.parse(result.body)
            expect(body.status).toBe('healthy')
            expect(body.server).toBe('tap-mcp-connector')
        })

        // D78 regression: GET MUST also be auth-gated. An MCP client probes this endpoint with an
        // unauthenticated GET (Accept: application/json, text/event-stream) purely to read the
        // authorization server out of the 401's WWW-Authenticate header. When GET answered 200,
        // the client concluded "no auth needed" and treated THIS url as the authorization server,
        // deriving a bogus <mcp-server>/token endpoint - the token exchange then 404'd.
        test('an UNAUTHENTICATED GET returns 401 with WWW-Authenticate, not 200 (RFC 9728 discovery)', async () => {
            const result = await main({
                __ow_method: 'get',
                __ow_path: '/',
                LOG_LEVEL: 'error',
                SERVICE_API_KEY: 'k',
                OIDC_ISSUER: 'https://ims-na1.adobelogin.com/',
                MCP_PRM_URL: 'https://example.test/api/v1/web/tap-mcp-connector/well-known',
                __ow_headers: { host: 'example.test' }
            })

            expect(result.statusCode).toBe(401)
            expect(result.headers['WWW-Authenticate']).toContain('resource_metadata=')
            expect(result.headers['WWW-Authenticate']).toContain('well-known')
        })

        test('an unauthenticated SSE-style GET probe also 401s (the exact shape mcp-remote sends)', async () => {
            const result = await main({
                __ow_method: 'get',
                __ow_path: '/',
                LOG_LEVEL: 'error',
                SERVICE_API_KEY: 'k',
                OIDC_ISSUER: 'https://ims-na1.adobelogin.com/',
                MCP_PRM_URL: 'https://example.test/api/v1/web/tap-mcp-connector/well-known',
                __ow_headers: { host: 'example.test', accept: 'application/json, text/event-stream' }
            })

            expect(result.statusCode).toBe(401)
            expect(result.headers['WWW-Authenticate']).toContain('resource_metadata=')
        })

        test('MCP_AUTH_MODE=none still allows an unauthenticated GET (explicit bypass, unchanged)', async () => {
            const result = await main({ __ow_method: 'get', __ow_path: '/', LOG_LEVEL: 'error', MCP_AUTH_MODE: 'none' })
            expect(result.statusCode).toBe(200)
        })
    })

    describe('CORS Support', () => {
        test('should handle OPTIONS request for CORS preflight', async () => {
            const result = await main({ __ow_method: 'options', LOG_LEVEL: 'info' })

            expect(result.statusCode).toBe(200)
            expect(result.headers['Access-Control-Allow-Origin']).toBe('*')
            expect(result.headers['Access-Control-Allow-Methods']).toContain('POST')
        })
    })

    describe('Dual auth (Increment 2, D19/D21)', () => {
        test('x-api-key succeeds (headless-agent path)', async () => {
            const { result, body } = await rpc('tools/list')
            expect(result.statusCode).toBe(200)
            expect(body.result.tools).toBeDefined()
        })

        test('tools/list advertises OAuth security schemes for ChatGPT connectors', async () => {
            const { body } = await rpc('tools/list', {}, 1, { OIDC_REQUIRED_SCOPE: 'resource.rw' })
            const tool = body.result.tools.find(t => t.name === 'get_resource_policy')

            expect(tool.securitySchemes).toEqual([{ type: 'oauth2', scopes: ['resource.rw'] }])
            expect(tool._meta.securitySchemes).toEqual([{ type: 'oauth2', scopes: ['resource.rw'] }])
            expect(tool.execution).toBeUndefined()
            expect(tool.title).toBe('Get Resource Policy')
            expect(tool.annotations).toEqual({
                readOnlyHint: true,
                destructiveHint: false,
                openWorldHint: false,
                idempotentHint: true
            })
            expect(JSON.stringify(tool.inputSchema)).not.toContain('$schema')
        })

        test('tools/list sanitizes schemas for strict ChatGPT action import', async () => {
            const { body } = await rpc('tools/list', {}, 1, { OIDC_REQUIRED_SCOPE: 'resource.rw' })
            const raw = JSON.stringify(body.result.tools)

            expect(raw).not.toContain('"$schema"')
            expect(raw).not.toContain('"additionalProperties":{}')
        })

        test('valid OIDC Bearer token succeeds (per-user path)', async () => {
            const fetchMock = jest.fn()
                .mockImplementationOnce(async () => ({ ok: true, json: async () => ({ userinfo_endpoint: 'https://issuer.example.com/userinfo' }) }))
                .mockImplementationOnce(async () => ({ ok: true, json: async () => ({ sub: 'user-123', email: 'person@example.com' }) }))
            global.fetch = fetchMock

            const result = await main({
                __ow_method: 'post',
                __ow_headers: { authorization: 'Bearer some-oidc-token', host: HOST },
                __ow_body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
                OIDC_ISSUER: 'https://issuer.example.com',
                LOG_LEVEL: 'info'
            })

            expect(result.statusCode).toBe(200)
            const body = JSON.parse(result.body)
            expect(body.result.tools).toBeDefined()
        })

        test('no credentials -> 401 with WWW-Authenticate pointing at the PRM document', async () => {
            const result = await main({
                __ow_method: 'post',
                __ow_headers: { host: HOST },
                __ow_body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
                LOG_LEVEL: 'info'
            })

            expect(result.statusCode).toBe(401)
            expect(result.headers['WWW-Authenticate']).toBe(
                'Bearer resource_metadata="https://110557-tapmcpconnector-stage.adobeioruntime.net/api/v1/web/tap-mcp-connector/well-known"'
            )
            const body = JSON.parse(result.body)
            expect(body.error.code).toBe(-32001)
        })

        test('MCP_AUTH_MODE=none allows no credentials and strips OAuth schemes', async () => {
            const result = await main({
                __ow_method: 'post',
                __ow_headers: { host: HOST },
                __ow_body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
                MCP_AUTH_MODE: 'none',
                OIDC_REQUIRED_SCOPE: 'resource.rw',
                LOG_LEVEL: 'info'
            })

            expect(result.statusCode).toBe(200)
            const body = JSON.parse(result.body)
            const tool = body.result.tools.find(t => t.name === 'get_resource_policy')
            expect(tool).toBeDefined()
            expect(tool.securitySchemes).toBeUndefined()
            expect(tool._meta?.securitySchemes).toBeUndefined()
        })

        test('wrong x-api-key -> 401 with WWW-Authenticate', async () => {
            const result = await main(authedParams({
                __ow_method: 'post',
                __ow_headers: { 'x-api-key': 'wrong-key', host: HOST },
                __ow_body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
            }))

            expect(result.statusCode).toBe(401)
            expect(result.headers['WWW-Authenticate']).toContain('resource_metadata=')
        })
    })

    describe('MCP Protocol', () => {
        test('should handle initialize request', async () => {
            const { result, body } = await rpc('initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'test-client', version: '1.0.0' }
            })

            expect(result.statusCode).toBe(200)
            expect(body.result.serverInfo.name).toBe('tap-mcp-connector')
        })

        test('tools/list should show every control-plane tool', async () => {
            const { body } = await rpc('tools/list')

            const toolNames = body.result.tools.map(tool => tool.name)
            expect(toolNames).toEqual(expect.arrayContaining([
                'get_resource_policy', 'list_resource_types', 'get_segmentation_config',
                'start_project', 'set_work_context', 'save_resource', 'find_similar',
                'approve_resource', 'certify', 'export_as_skill',
                'list_active_tasks', 'set_task_status', 'link_recipes',
                'list_resources', 'search_resources', 'get_resource',
                // Increment 11 (D45): ordered Step/Recipe model + project lifecycle + retention
                'start_recipe', 'append_step', 'approve_step', 'approve_steps', 'discard_step',
                'get_recipe', 'list_recipes', 'list_steps',
                'bake_project', 'set_project_status', 'list_projects', 'purge_expired',
                // Increment 12 (D47/D48): task=recipe cross-tool, recipe bake, editable settings
                'get_active_recipe', 'bake_recipe', 'get_settings', 'update_settings',
                // Increment 14 (D52): destructive admin reset
                'admin_reset_data',
                // Increment 14 (D53): company CX knowledge graph
                'get_cx_graph', 'rebuild_cx_graph',
                // Increment 15 (D55): admin cross-owner views
                'admin_list_recipes', 'admin_list_projects',
                // Increment 18 (D64): chef roles + Head Chef CX-graph gate
                'get_role', 'set_head_chefs', 'list_cx_pending', 'headchef_approve', 'headchef_reject',
                // Increment 19 (D66): multi-role RBAC
                'get_my_roles', 'list_user_roles', 'set_user_roles',
                // D79: practice / capability groups
                'list_practices', 'set_practices', 'set_user_practices',
                // D81: admin-created Cookbook logins
                'create_user', 'list_users', 'set_user_password', 'set_user_enabled',
                // D82: self-service password change
                'change_my_password',
                // D84: targeted admin delete
                'delete_recipe',
                // D86: assignment, the explicit share of unfinished work
                'assign_step', 'unassign_step', 'list_my_assignments',
                // D96: the name directory
                'list_people', 'set_user_display_name'
            ]))
            expect(toolNames).toContain('list_agent_systems')
            expect(toolNames).toContain('list_system_agents')
            expect(toolNames).toContain('start_intake')
            expect(toolNames).toContain('get_intake')
            expect(toolNames).toContain('list_mcp_servers')
            expect(toolNames).toContain('set_mcp_server')
            expect(toolNames).toContain('check_mcp_server')
            expect(toolNames).toHaveLength(67)
        })

    })

    describe('Resource loop round-trip', () => {
        test('save -> list -> search -> get (experimental by default, D42)', async () => {
            const saveBody = await callTool('save_resource', {
                title: 'ping test',
                type: 'decision',
                content: 'hello',
                project: 'Ping Project'
            }, 1)
            expect(saveBody.result.content[0].type).toBe('text')
            const { id, status, version } = JSON.parse(saveBody.result.content[0].text)
            expect(id).toEqual(expect.stringContaining('decision-'))
            expect(status).toBe('experimental') // human-gate by default now
            expect(version).toBe(1)

            const listBody = await callTool('list_resources', {}, 2)
            const listed = JSON.parse(listBody.result.content[0].text)
            expect(listed.map(r => r.id)).toContain(id)
            expect(listed.find(r => r.id === id).content).toBeUndefined() // metadata only
            expect(listed.find(r => r.id === id).status).toBe('experimental')
            expect(listed.find(r => r.id === id).segments.project).toBe('Ping Project')

            const searchBody = await callTool('search_resources', { query: 'ping' }, 3)
            const found = JSON.parse(searchBody.result.content[0].text)
            expect(found.map(r => r.id)).toContain(id)

            const getBody = await callTool('get_resource', { id }, 4)
            const full = JSON.parse(getBody.result.content[0].text)
            expect(full.content).toBe('hello')
            expect(full.title).toBe('ping test')
            expect(full.type).toBe('decision')
            expect(full.format).toBe('md')
            expect(full.owner).toBe('service-account') // x-api-key -> service principal
        })

        test('list_resources filters by project and tag', async () => {
            await callTool('save_resource', {
                title: 'scoped note', type: 'decision', content: 'x', project: 'proj-a', tags: ['alpha']
            }, 1)
            await callTool('save_resource', {
                title: 'other note', type: 'decision', content: 'y', project: 'proj-b', tags: ['beta']
            }, 2)

            const byProject = JSON.parse((await callTool('list_resources', { project: 'proj-a' }, 3)).result.content[0].text)
            expect(byProject).toHaveLength(1)
            expect(byProject[0].title).toBe('scoped note')

            const byTag = JSON.parse((await callTool('list_resources', { tag: 'beta' }, 4)).result.content[0].text)
            expect(byTag).toHaveLength(1)
            expect(byTag[0].title).toBe('other note')
        })

        test('recipe saves experimental; approve_resource promotes it to approved with consent fields', async () => {
            const saveBody = await callTool('save_resource', {
                type: 'architecture-diagram',
                title: 'System overview',
                content: 'graph TD; A-->B;',
                format: 'mermaid',
                project: 'Overview Project',
                fields: { system: 'connector' }
            }, 1)
            const { id, status } = JSON.parse(saveBody.result.content[0].text)
            expect(status).toBe('experimental')

            const beforeApproval = JSON.parse((await callTool('get_resource', { id }, 2)).result.content[0].text)
            expect(beforeApproval.status).toBe('experimental')

            const approveBody = await callTool('approve_resource', { id }, 3)
            const approved = JSON.parse(approveBody.result.content[0].text)
            expect(approved.status).toBe('approved')
            expect(approved.approved_by).toBe('service-account')
            expect(approved.approved_at).toBeDefined()

            const afterApproval = JSON.parse((await callTool('get_resource', { id }, 4)).result.content[0].text)
            expect(afterApproval.status).toBe('approved')
            expect(afterApproval.approved_by).toBe('service-account')
        })
    })

    describe('Error Handling', () => {
        test('should handle invalid JSON-RPC request', async () => {
            const result = await main(authedParams({ __ow_method: 'post', __ow_body: 'invalid json' }))

            expect(result.statusCode).toBe(500)
            const body = JSON.parse(result.body)
            expect(body.jsonrpc).toBe('2.0')
            expect(body.error).toBeDefined()
        })

        test('should handle unknown tool call', async () => {
            const body = await callTool('nonexistent_tool', {})
            expect(body.result.isError).toBe(true)
            expect(body.result.content[0].text).toContain('-32602')
        })

        test('should enforce the resource type enum on save_resource', async () => {
            const body = await callTool('save_resource', { title: 't', type: 'not-a-real-type', content: 'c' })
            expect(body.result.isError).toBe(true)
            expect(body.result.content[0].text).toContain('invalid_enum_value')
        })

        test('get_resource should handle an unknown id gracefully', async () => {
            const body = await callTool('get_resource', { id: 'does-not-exist' })
            expect(body.result.isError).toBe(true)
            expect(body.result.content[0].text).toContain('does-not-exist')
        })

        test('should handle unsupported HTTP method', async () => {
            const result = await main({ __ow_method: 'put', LOG_LEVEL: 'info' })
            expect(result.statusCode).toBe(405)
        })
    })
})
