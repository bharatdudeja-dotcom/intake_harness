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
 * Serves the RFC 9728 OAuth Protected Resource Metadata (PRM) document.
 *
 * Deployed as its own action because Adobe I/O Runtime can't route a literal
 * root-level `/.well-known/oauth-protected-resource` path - every action lives
 * under `/api/v1/web/<package>/<action>` (see knowledge/OAUTH-SPIKE.md §2). Per
 * RFC 9728 §5 and Claude's own connector docs, the PRM document may live at ANY
 * absolute HTTPS URL as long as the resource server names that URL via
 * `WWW-Authenticate: resource_metadata=...` on 401 responses (see
 * actions/mcp-server/index.js) - this action IS that URL.
 */

const { Core } = require('@adobe/aio-sdk')
const { loadAuthConfig } = require('../../lib/auth/config')
const { resolveResourceUrl, resolvePrmUrl, resolveOAuthIssuerUrl } = require('../../lib/auth/urls')
const { buildProtectedResourceMetadata } = require('../../lib/auth/prm')

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, x-api-key'
}

/**
 * @param {Record<string, any>} params
 * @returns {Promise<{statusCode: number, headers: object, body: string}>}
 */
async function main (params) {
  /*
   * Runtime passes configuration as PARAMETERS; this code reads process.env.
   * Bridge them before anything else runs - lib/storage, lib/auth and the MCP
   * gateway all read the environment at first use, and on this host that was
   * empty. See lib/params-env.js.
   */
  require('../../lib/params-env').applyParams(params)
    const logger = Core.Logger('tap-mcp-connector-well-known', { level: params.LOG_LEVEL || 'info' })

    if ((params.__ow_method || '').toLowerCase() === 'options') {
        return { statusCode: 200, headers: CORS_HEADERS, body: '' }
    }

    const config = loadAuthConfig(params)
    // This wrapper owns the transport's request shape: lib/auth gets plain,
    // normalized values only (portability seam, D21/D34).
    const headers = {}
    for (const key in (params.__ow_headers || {})) headers[key.toLowerCase()] = params.__ow_headers[key]
    const request = { host: headers.host || '', packageName: params.MCP_PACKAGE_NAME || '' }
    const resourceUrl = resolveResourceUrl(request, config)
    const prmUrl = resolvePrmUrl(request, config)
    // D72: a provider marked directLogin (a public client + its own localhost redirect) is
    // advertised directly - no relay needed. Otherwise (Adobe IMS, whose credential only allows
    // HTTPS redirects - the only active provider as of D73) advertise the login bridge (D68).
    const authorizationServer = config.providerDirectLogin ? config.issuer : resolveOAuthIssuerUrl(request, config)
    const doc = buildProtectedResourceMetadata({ ...config, resourceUrl, prmUrl, authorizationServer })

    logger.info('Serving protected resource metadata', { resourceUrl, authorizationServer, directLogin: config.providerDirectLogin, provider: config.provider })

    return {
        statusCode: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(doc, null, 2)
    }
}

module.exports = { main }
