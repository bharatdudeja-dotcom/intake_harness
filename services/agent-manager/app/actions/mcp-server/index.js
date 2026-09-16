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
 * MCP Server for Adobe I/O Runtime - With MCP SDK Implementation
 *
 * Following the exact pattern from TypeScript SDK examples but adapted for Adobe I/O Runtime.
 * Uses the stateless pattern where fresh server and transport instances are created per request.
 */

// Must run before @modelcontextprotocol/sdk imports (SDK 1.24+ uses global File at load time).
require('./node18-web-globals.js')

const { Core } = require('@adobe/aio-sdk')
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { registerTools, registerResources, registerPrompts, SERVER_INSTRUCTIONS } = require('./tools.js')
const mcpGateway = require('../../lib/mcp-gateway')
const { resolveRequestAuth, loadAuthConfig } = require('../../lib/auth')
const { buildWwwAuthenticateHeader } = require('../../lib/auth/prm')
const settings = require('../../lib/settings')

// SDK 1.24+ uses Web Standard transport. Optional module (see webpack externals) so build succeeds on 1.17.4.
// undefined = not yet loaded; null = load failed or unavailable; otherwise the transport class.
let _webStandardTransport
function getWebStandardTransport () {
 if (_webStandardTransport !== undefined) return _webStandardTransport
 try {
  const web = require('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js')
  _webStandardTransport = web.WebStandardStreamableHTTPServerTransport
 } catch (_) {
  _webStandardTransport = null
 }
 return _webStandardTransport
}

// Global logger variable
let logger = null

/**
 * Create MCP server instance with all capabilities
 * Following the exact pattern from SDK examples
 */
/**
 * Re-expose the tools of every gateway-enabled MCP server.
 *
 * Nothing here names a tool or a server: the list comes from the registry and
 * from each upstream's own tools/list. Name collisions are impossible because
 * every proxied tool is prefixed with the server it came from, which also means
 * a vendor shipping a tool called `approve_step` can never shadow ours.
 */
async function registerGatewayTools (server) {
    let catalog
    try {
        catalog = await mcpGateway.catalog(settings.mcpServers())
    } catch (e) {
        // A broken registry must not take the whole server down. The native
        // tools are what most callers need.
        logger?.warn(`Gateway discovery failed entirely: ${e.message}`)
        return
    }

    for (const s of catalog.servers) {
        if (s.error) logger?.warn(`Gateway: ${s.id} did not answer (${s.error}) - contributing no tools`)
        else logger?.info(`Gateway: ${s.id} contributed ${s.tool_count} tool(s)`)
    }

    for (const t of catalog.tools) {
        try {
            server.registerTool(
                t.name,
                { description: t.description, inputSchema: t.zodShape },
                async (args) => {
                    const result = await mcpGateway.callProxied(t.name, args, settings.mcpServers())
                    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] }
                }
            )
        } catch (e) {
            logger?.warn(`Gateway: could not register ${t.name}: ${e.message}`)
        }
    }
}

/**
 * Build the server.
 *
 * Async because the gateway's tools are DISCOVERED, not declared: whatever the
 * registered MCP servers expose right now is what a connected client sees on
 * its next tools/list. That is the point of the layer - swapping one team's
 * agent for another's is a Settings change, and Claude picks up the new
 * capability with no deploy. Discovery is cached (lib/mcp-gateway.js), so only
 * the first request in a minute pays for it, and an upstream that does not
 * answer contributes no tools rather than failing the request.
 */
async function createMcpServer (context = {}) {
    const server = new McpServer({
    name: 'cx-agent-manager',
        version: '1.0.0'
    }, {
        capabilities: {
            logging: {},
            tools: {},
            resources: {},
            prompts: {}
        },
        instructions: SERVER_INSTRUCTIONS
    })

    // Register all capabilities
    registerTools(server, context)
    registerResources(server, context)
    registerPrompts(server, context)
    await registerGatewayTools(server)

    if (logger) {
        logger.info('MCP Server created with tools, resources, prompts, and logging capabilities')
    }

    return server
}

/**
 * Parse request body from Adobe I/O Runtime parameters
 */
function parseRequestBody (params) {
    if (!params.__ow_body) {
        return null
    }

    try {
        if (typeof params.__ow_body === 'string') {
            // Try base64 decode first, then direct parse
            try {
                const decoded = Buffer.from(params.__ow_body, 'base64').toString('utf8')
                return JSON.parse(decoded)
            } catch (e) {
                return JSON.parse(params.__ow_body)
            }
        } else {
            return params.__ow_body
        }
    } catch (error) {
        logger?.error('Failed to parse request body:', error)
        throw new Error(`Failed to parse request body: ${error.message}`)
    }
}

/**
 * Normalize headers to lowercase keys for consistent lookup
 */
function normalizeHeaders (headers) {
    const normalized = {}
    if (headers) {
        for (const key in headers) {
            normalized[key.toLowerCase()] = headers[key]
        }
    }
    return normalized
}

function isNoAuthMode (params = {}) {
    const mode = String(params.MCP_AUTH_MODE || '').trim().toLowerCase()
    return mode === 'none' || mode === 'off' || mode === 'disabled'
}

function oauthSecuritySchemes (params = {}) {
    if (isNoAuthMode(params)) return []
    const scope = String(params.OIDC_REQUIRED_SCOPE || 'resource.rw').trim() || 'resource.rw'
    return [{ type: 'oauth2', scopes: [scope] }]
}

function titleFromToolName (name) {
    return String(name || '')
        .split('_')
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
}

function defaultToolAnnotations (name) {
    const readOnlyTools = new Set([
        'get_resource_policy',
        'list_resource_types',
        'get_segmentation_config',
        'find_similar',
        'list_active_tasks',
        'list_resources',
        'search_resources',
        'get_resource',
        'get_recipe',
        'list_recipes',
        'list_steps',
        'get_active_recipe',
        'list_projects',
        'get_settings',
        'admin_list_recipes',
        'admin_list_projects',
        'get_cx_graph',
        'export_as_skill'
    ])
    const destructiveTools = new Set([
        'discard_step',
        'purge_expired',
        'admin_reset_data'
    ])
    const openWorldTools = new Set([
        'admin_list_recipes',
        'admin_list_projects',
        'get_cx_graph'
    ])

    const readOnly = readOnlyTools.has(name)
    return {
        readOnlyHint: readOnly,
        destructiveHint: destructiveTools.has(name),
        openWorldHint: openWorldTools.has(name) || !readOnly,
        idempotentHint: readOnly
    }
}

function sanitizeJsonSchemaForChatGpt (schema) {
    if (Array.isArray(schema)) return schema.map(sanitizeJsonSchemaForChatGpt)
    if (!schema || typeof schema !== 'object') return schema

    const cleaned = {}
    for (const [key, value] of Object.entries(schema)) {
        if (key === '$schema') continue
        if (
            key === 'additionalProperties' &&
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Object.keys(value).length === 0
        ) {
            cleaned[key] = true
            continue
        }
        cleaned[key] = sanitizeJsonSchemaForChatGpt(value)
    }
    return cleaned
}

function decorateToolsListResponse (body, params = {}) {
    if (!body || typeof body !== 'string') return body
    let payload
    try {
        payload = JSON.parse(body)
    } catch (e) {
        return body
    }
    const tools = payload?.result?.tools
    if (!Array.isArray(tools)) return body

    const securitySchemes = oauthSecuritySchemes(params)
    for (const tool of tools) {
        if (!tool || typeof tool !== 'object') continue
        // The MCP SDK emits an `execution` extension for task support. ChatGPT's
        // connector importer is stricter than generic MCP clients, so keep the
        // descriptor to the public tool fields it expects.
        delete tool.execution
        tool.title = tool.title || titleFromToolName(tool.name)
        tool.annotations = {
            ...defaultToolAnnotations(tool.name),
            ...(tool.annotations || {})
        }
        if (tool.inputSchema) {
            tool.inputSchema = sanitizeJsonSchemaForChatGpt(tool.inputSchema)
        }
        if (securitySchemes.length === 0) {
            delete tool.securitySchemes
            if (tool._meta) delete tool._meta.securitySchemes
            continue
        }
        tool.securitySchemes = tool.securitySchemes || securitySchemes
        tool._meta = {
            ...(tool._meta || {}),
            securitySchemes: tool._meta?.securitySchemes || securitySchemes
        }
    }
    return JSON.stringify(payload)
}

/**
 * Create a Web Standard Request from Adobe I/O params (for SDK 1.24+ WebStandardStreamableHTTPServerTransport)
*/
function createWebRequest (params) {
    const body = parseRequestBody(params)
    const incomingHeaders = normalizeHeaders(params.__ow_headers)
    const method = (params.__ow_method || 'POST').toUpperCase()
    const path = params.__ow_path || '/mcp-server'
    const url = `https://runtime.adobe.io${path}`
    const headers = new Headers(incomingHeaders)
    // SDK 1.24+ requires both; set after incoming so client cannot override
    headers.set('content-type', 'application/json')
    headers.set('accept', 'application/json, text/event-stream')
    const mcpSessionId = params['mcp-session-id'] || incomingHeaders['mcp-session-id']
    if (mcpSessionId) headers.set('mcp-session-id', mcpSessionId)
    const init = { method, headers }
    if (body != null && method === 'POST') {
      init.body = typeof body === 'string' ? body : JSON.stringify(body)
    }
    return new Request(url, init)
}
/**
 * Convert Web Standard Response to Adobe I/O Runtime return shape { statusCode, headers, body }
 */
async function responseToRuntime (response, params = {}) {
const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, x-api-key, mcp-session-id, Last-Event-ID',
    'Access-Control-Expose-Headers': 'Content-Type, mcp-session-id, Last-Event-ID',
    'Access-Control-Max-Age': '86400'
}
response.headers.forEach((value, key) => {
    headers[key] = value
})
const body = decorateToolsListResponse(await response.text(), params)
return { statusCode: response.status, headers, body }
}
/**
 * Create minimal req object compatible with StreamableHTTPServerTransport (SDK 1.17.x)
 */
function createCompatibleRequest (params) {
    const body = parseRequestBody(params)

    // Normalize incoming headers to lowercase keys
    const incomingHeaders = normalizeHeaders(params.__ow_headers)

    // Log if client requested SSE (for debugging)
    if (incomingHeaders.accept && incomingHeaders.accept.includes('text/event-stream')) {
        logger?.info('Client requested SSE streaming, forcing JSON mode (serverless limitation)')
    }

    // Build headers with lowercase keys
    // SDK requires Accept header to include both application/json AND text/event-stream
    const headers = {
        'content-type': 'application/json',
        'mcp-session-id': params['mcp-session-id'] || incomingHeaders['mcp-session-id'],
        ...incomingHeaders,
        // SDK requires both content types - it will use enableJsonResponse to pick JSON mode
        'accept': 'application/json, text/event-stream'
    }

    return {
        method: (params.__ow_method || 'GET').toUpperCase(),
        url: params.__ow_path || '/mcp-server',
        path: params.__ow_path || '/mcp-server',
        headers,
        body,
        // Socket mock for streaming checks
        socket: {
            remoteAddress: '127.0.0.1',
            encrypted: true
        },
        get (name) {
            return this.headers[name.toLowerCase()]
        }
    }
}

/**
 * Create minimal res object compatible with StreamableHTTPServerTransport
 */
function createCompatibleResponse () {
    let statusCode = 200
    let headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, x-api-key, mcp-session-id, Last-Event-ID',
        'Access-Control-Expose-Headers': 'Content-Type, mcp-session-id, Last-Event-ID',
        'Access-Control-Max-Age': '86400'
    }
    let body = ''
    let headersSent = false

    const res = {
        // Status and headers
        status: code => { 
            statusCode = code
            res.statusCode = code
            return res 
        },
        setHeader: (name, value) => { headers[name] = value; return res },
        getHeader: name => headers[name],
        writeHead: (code, reasonOrHeaders, headerObj) => {
            statusCode = code
            res.statusCode = code
            // Handle both writeHead(code, headers) and writeHead(code, reason, headers)
            const hdrs = typeof reasonOrHeaders === 'object' ? reasonOrHeaders : (headerObj || {})
            headers = { ...headers, ...hdrs }
            headersSent = true
            return res
        },

        // Writing response
        write: chunk => {
            if (chunk) {
                body += typeof chunk === 'string' ? chunk : JSON.stringify(chunk)
            }
            return true
        },
        end: chunk => {
            if (chunk) {
                body += typeof chunk === 'string' ? chunk : JSON.stringify(chunk)
            }
            headersSent = true
            return res
        },
        json: obj => {
            headers['Content-Type'] = 'application/json'
            body = JSON.stringify(obj)
            headersSent = true
            return res
        },
        send: data => {
            if (data) {
                body = typeof data === 'string' ? data : JSON.stringify(data)
            }
            headersSent = true
            return res
        },

        // Properties
        get headersSent () { return headersSent },
        get writableEnded () { return false },
        get writableFinished () { return false },
        get finished () { return false },
        get writable () { return true },
        statusCode: 200,
        
        // Socket mock (needed for streaming checks)
        socket: {
            writable: true,
            destroyed: false,
            on: () => {},
            once: () => {},
            removeListener: () => {},
            write: () => true,
            end: () => {}
        },
        connection: null,
        
        // Flush method
        flushHeaders: () => { headersSent = true },

        // Event emitter (minimal implementation)
        on: (event, handler) => { return res },
        once: (event, handler) => { return res },
        emit: (event, ...args) => { return true },
        removeListener: () => { return res },
        addListener: (event, handler) => { return res },
        off: (event, handler) => { return res },

        // Get result for Adobe I/O Runtime
        getResult: (params = {}) => {
            logger?.info('Final response - Status:', statusCode, 'Body length:', body.length, 'Headers:', Object.keys(headers).join(', '))
            return { statusCode, headers, body: decorateToolsListResponse(body, params) }
        }
    }

    return res
}

/**
 * Handle health check requests
 */
function handleHealthCheck () {
    return {
        statusCode: 200,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
            'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, x-api-key, mcp-session-id, Last-Event-ID',
            'Access-Control-Expose-Headers': 'Content-Type, mcp-session-id, Last-Event-ID',
            'Access-Control-Max-Age': '86400',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            status: 'healthy',
            server: 'cx-agent-manager',
            version: '1.0.0',
            description: 'Adobe I/O Runtime MCP Server using official TypeScript SDK MCP v1.24.x',
            timestamp: new Date().toISOString(),
            transport: 'StreamableHTTP',
            sdk: '@modelcontextprotocol/sdk'
        })
    }
}

/**
 * Handle CORS OPTIONS requests
 */
function handleOptionsRequest () {
    return {
        statusCode: 200,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
            'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, x-api-key, mcp-session-id, Last-Event-ID',
            'Access-Control-Expose-Headers': 'Content-Type, mcp-session-id, Last-Event-ID',
            'Access-Control-Max-Age': '86400'
        },
        body: ''
    }
}

/**
 * Handle MCP requests using the SDK
 * Creates fresh server and transport instances per request (stateless pattern).
* Uses WebStandardStreamableHTTPServerTransport on SDK 1.24+ (Request/Response);
* falls back to StreamableHTTPServerTransport + mock req/res on SDK 1.17.x.
*/
async function handleMcpRequest (params) {
    // Load the editable settings override (retention/labels, D48) into the per-request
    // cache before any tool runs, so synchronous readers (computeExpiry, the config tools)
    // see the current values. Never fatal - falls back to bundled defaults on error.
    await settings.refresh()
    // Seed bootstrap admin/head-chef identities from env so the role model + Team UI are
    // reachable on day one (D66), before anyone has been assigned roles in the store.
    settings.setBootstrapAdmins(params.BOOTSTRAP_ADMINS)

    // Tool context carries the caller's identity: userInfo (per-user OIDC) drives
    // owner/approved_by; its absence (the x-api-key path) resolves to the service
    // principal in tools.js (D40/D42).
    const server = await createMcpServer({ userInfo: params.AUTH_USER_INFO, authMode: params.AUTH_MODE })
    const body = parseRequestBody(params)

    try {
        logger?.info('Creating fresh MCP server and transport')

        const WebStandardTransport = getWebStandardTransport()
        if (WebStandardTransport) {
        // SDK 1.24+: use Web Standard transport (no real Node req/res needed)
        const transport = new WebStandardTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true
        })
        await server.connect(transport)
        const webRequest = createWebRequest(params)
        logger?.info('Request method:', body?.method)
        const requestOptions = body != null ? { parsedBody: body } : {}
        const response = await transport.handleRequest(webRequest, requestOptions)
        logger?.info('MCP request processed by SDK (Web Standard transport)')
        return await responseToRuntime(response, params)
        }
        // SDK 1.17.x: use Node-style transport with mock req/res
        const req = createCompatibleRequest(params)
        const res = createCompatibleResponse()

        logger?.info('Request method:', req.body?.method)

        // Create fresh transport for this request
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // Stateless - no session tracking
            enableJsonResponse: true
        })

        // Connect server to transport
        await server.connect(transport)

        // Create a promise that resolves when the response is complete
        const responseComplete = new Promise(resolve => {
            const originalEnd = res.end.bind(res)
            res.end = function (chunk) {
                const result = originalEnd(chunk)
                setTimeout(() => resolve(), 10)
                return result
            }
        })

        // Let the SDK handle the request
        await transport.handleRequest(req, res, req.body)
        await responseComplete

        logger?.info('MCP request processed by SDK')
        return res.getResult(params)

    } catch (error) {
        logger?.error('Error in handleMcpRequest:', error)

        try {
            server.close()
        } catch (cleanupError) {
            logger?.error('Error during cleanup:', cleanupError)
        }

        return {
            statusCode: 500,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                error: {
                    code: -32603,
                    message: `Internal server error: ${error.message}`
                },
                id: null
            })
        }
    }
}

/**
 * Main function for Adobe I/O Runtime
 */
async function main (params) {
    try {
        console.log('=== MCP SERVER (CLEAN SDK IMPLEMENTATION) ===')
        console.log('Method:', params.__ow_method)

        // Initialize logger
        try {
            logger = Core.Logger('tap-mcp-connector', { level: params.LOG_LEVEL || 'info' })
        } catch (loggerError) {
            console.error('Logger creation error:', loggerError)
            return {
                statusCode: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: `Logger creation error: ${loggerError.message}` })
            }
        }

        logger.info('MCP Server using @modelcontextprotocol/sdk (Web Standard transport on 1.24+, Node transport on 1.17.x)')
        logger.info(`Request method: ${params.__ow_method}`)

        // Route requests
        const incomingHeaders = normalizeHeaders(params.__ow_headers)

        // Auth gate shared by GET and POST (D78). It MUST cover GET too: an MCP client probes
        // this endpoint with an unauthenticated `GET` (Accept: application/json,
        // text/event-stream) specifically to discover the authorization server from the 401's
        // `WWW-Authenticate` header. When GET answered 200 (health check / graceful-SSE), the
        // client concluded "no auth required" and fell back to treating THIS server's URL as the
        // authorization server - so it derived a bogus `<mcp-server>/token` endpoint and the
        // token exchange 404'd at the gateway, even though the authorize leg (driven by the
        // later 401 on POST) looked correct. Returning 401 + WWW-Authenticate on any
        // unauthenticated request is also simply the RFC 9728 / MCP-spec-correct behavior.
        // OPTIONS stays open - it is just the CORS preflight and carries no data.
        const method = params.__ow_method?.toLowerCase()

        if (method === 'options') {
            logger.info('CORS preflight request')
            return handleOptionsRequest()
        }

        if (method === 'get' || method === 'post') {
            if (isNoAuthMode(params)) {
                params.AUTH_MODE = 'none'
                logger.warn('Authentication bypass enabled by MCP_AUTH_MODE=none')
            } else {
                // Dual auth (D19/D21): Authorization: Bearer -> OIDC provider; x-api-key -> agent path.
                // This wrapper owns the transport's request shape: lib/auth gets plain,
                // normalized values only (portability seam, D21/D34).
                const authRequest = {
                    headers: incomingHeaders,
                    host: incomingHeaders.host || '',
                    packageName: params.MCP_PACKAGE_NAME || ''
                }
                const authResult = await resolveRequestAuth(authRequest, loadAuthConfig(params), logger)
                if (!authResult.ok) {
                    logger.warn(`Authentication failed on ${method.toUpperCase()}:`, authResult.error)
                    return {
                        statusCode: 401,
                        headers: {
                            'Access-Control-Allow-Origin': '*',
                            'Content-Type': 'application/json',
                            'WWW-Authenticate': buildWwwAuthenticateHeader(authResult.prmUrl || '')
                        },
                        body: JSON.stringify({
                            jsonrpc: '2.0',
                            error: { code: -32001, message: authResult.error },
                            id: null
                        })
                    }
                }
                // Attach caller identity to params for downstream tool use (author/owner resolution etc.)
                if (authResult.userInfo) {
                    params.AUTH_USER_INFO = authResult.userInfo
                }
                params.AUTH_MODE = authResult.mode
                logger.info(`Authentication passed (${authResult.mode}) on ${method.toUpperCase()}`)
            }
        }

        switch (method) {
        case 'get':
            // Authenticated GET only (see the gate above).
            // Check if client is requesting SSE stream
            // Return empty 200 response to gracefully indicate SSE is not available
            // This prevents error messages in MCP clients while allowing fallback to HTTP
            if (incomingHeaders.accept && incomingHeaders.accept.includes('text/event-stream')) {
                logger.info('SSE stream requested - not supported in serverless, returning graceful response')
                return {
                    statusCode: 200,
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'close'
                    },
                    body: 'event: error\ndata: {"error": "SSE not supported in serverless. Use HTTP transport."}\n\n'
                }
            }
            logger.info('Health check request')
            return handleHealthCheck()

        case 'post': {
            logger.info('MCP protocol request - authenticated, delegating to SDK')
            return await handleMcpRequest(params)
        }

        default:
            logger.warn(`Method not allowed: ${params.__ow_method}`)
        return {
            statusCode: 405,
            headers: {
                    'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                error: {
                        code: -32000,
                        message: `Method '${params.__ow_method}' not allowed. Supported: GET, POST, OPTIONS`
                },
                id: null
            })
        }
        }

    } catch (error) {
        if (logger) {
            logger.error('Uncaught error in main function:', error)
        } else {
            console.error('Uncaught error in main function:', error)
        }

        return {
            statusCode: 500,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                error: {
                    code: -32603,
                    message: `Unhandled server error: ${error.message}`
                },
                id: null
            })
        }
    }
}

// Export for Adobe I/O Runtime
module.exports = { main }
