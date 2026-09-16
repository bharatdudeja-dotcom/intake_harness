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
 * Resolves this deployment's own MCP resource URL and Protected Resource
 * Metadata (PRM) document URL.
 *
 * Host-neutral: callers pass a plain, already-normalized request shape
 * `{ host, packageName }` - the host wrapper (actions/<action>/index.js) is
 * responsible for extracting these from whatever transport it runs on. This
 * module knows nothing about any particular serverless platform's request
 * format.
 *
 * The PRM document is served from its own endpoint and advertised via the
 * `WWW-Authenticate: resource_metadata=...` header rather than a fixed
 * root-level `/.well-known/*` path - the RFC 9728-sanctioned pattern for hosts
 * that can't route root-level well-known paths (see knowledge/OAUTH-SPIKE.md §2).
 * `MCP_RESOURCE_URL` / `MCP_PRM_URL` config overrides let any host set these
 * explicitly instead of relying on the URL shape assumed by the dynamic
 * fallback below.
 */

const DEFAULT_PACKAGE_NAME = 'tap-mcp-connector'
const MCP_ACTION_SEGMENT = 'mcp-server'
const PRM_ACTION_SEGMENT = 'well-known' // deploy-config schema rejects a leading-dot action key
const OAUTH_BRIDGE_ACTION_SEGMENT = 'oauth-bridge' // D68 login bridge (see lib/auth/oauthBridge.js)

/**
 * @param {{host?: string, packageName?: string}} request plain values extracted by the host wrapper
 * @returns {string} `https://<host>/api/v1/web/<package>` or '' if no host known
 */
function dynamicBase (request = {}) {
    const host = (request.host && String(request.host).trim()) || ''
    if (!host) return ''
    const packageName = (request.packageName && String(request.packageName).trim()) || DEFAULT_PACKAGE_NAME
    return `https://${host}/api/v1/web/${packageName}`
}

/**
 * @param {{host?: string, packageName?: string}} request
 * @param {{resourceUrl: string}} config
 * @returns {string} absolute URL of the MCP server endpoint
 */
function resolveResourceUrl (request, config) {
    if (config.resourceUrl) return config.resourceUrl
    const base = dynamicBase(request)
    return base ? `${base}/${MCP_ACTION_SEGMENT}` : ''
}

/**
 * @param {{host?: string, packageName?: string}} request
 * @param {{prmUrl: string}} config
 * @returns {string} absolute URL of the Protected Resource Metadata document
 */
function resolvePrmUrl (request, config) {
    if (config.prmUrl) return config.prmUrl
    const base = dynamicBase(request)
    return base ? `${base}/${PRM_ACTION_SEGMENT}` : ''
}

/**
 * @param {{host?: string, packageName?: string}} request
 * @param {{oauthBridgeUrl?: string}} config
 * @returns {string} absolute base URL of the login-bridge action (D68) - `<base>/oauth-bridge`,
 *   from which `/.well-known/openid-configuration`, `/authorize`, `/token`, `/register`, and
 *   `/callback` are all reached via trailing-path-segment routing (confirmed live on this host -
 *   see knowledge/AUTH-PROVIDER-SPIKE.md Phase 0 and the routing note in the bridge action itself).
 */
function resolveOAuthBridgeUrl (request, config = {}) {
    if (config.oauthBridgeUrl) return config.oauthBridgeUrl
    const base = dynamicBase(request)
    return base ? `${base}/${OAUTH_BRIDGE_ACTION_SEGMENT}` : ''
}

/**
 * The authorization-server ISSUER to advertise in the PRM (D78) - deliberately distinct from
 * `resolveOAuthBridgeUrl`, which is the action's own base path.
 *
 * WHY they differ: MCP clients resolve authorization-server metadata ONLY at the issuer's
 * ORIGIN ROOT (`<origin>/.well-known/oauth-authorization-server`) - confirmed live from a client
 * debug log, which never attempted the path-suffixed variant this host can serve. With no
 * metadata resolved, such a client falls back to `new URL('/token', issuer)`, i.e. an
 * origin-root `/token`, and the exchange fails. This host cannot route root-level paths for
 * server actions at all (see knowledge/OAUTH-SPIKE.md §2) - but its static-asset origin CAN
 * serve a root-level file, and also proxies the action paths. So the advertised issuer is that
 * static origin, whose root `/.well-known/oauth-authorization-server` document (checked in at
 * `web-src/.well-known/`) points every endpoint back at this same bridge action.
 *
 * `OAUTH_ISSUER_URL` overrides it; otherwise falls back to the bridge action's own base URL so a
 * host that CAN serve root paths needs no extra file or config.
 * @param {{host?: string, packageName?: string}} request
 * @param {{oauthIssuerUrl?: string, oauthBridgeUrl?: string}} config
 * @returns {string}
 */
function resolveOAuthIssuerUrl (request, config = {}) {
    if (config.oauthIssuerUrl) return config.oauthIssuerUrl
    return resolveOAuthBridgeUrl(request, config)
}

module.exports = { resolveResourceUrl, resolvePrmUrl, resolveOAuthBridgeUrl, resolveOAuthIssuerUrl }
