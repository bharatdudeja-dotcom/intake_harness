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
 * RFC 9728 OAuth 2.0 Protected Resource Metadata (PRM) document builder.
 */

/**
 * @param {{resourceUrl: string, issuer: string, authorizationServer?: string, requiredScope: string}} config
 *   `authorizationServer`, when set, OVERRIDES `issuer` in the advertised `authorization_servers`
 *   (D68): the login bridge's own URL, not the real upstream provider - `mcp-remote` must talk
 *   to the bridge (whose HTTPS callback IS allowed on the provider's redirect URI list), not
 *   directly to the provider (which would reject its bare localhost redirect_uri).
 * @returns {object} RFC 9728 Protected Resource Metadata document
 */
function buildProtectedResourceMetadata (config) {
    const authServer = config.authorizationServer || config.issuer
    return {
        resource: config.resourceUrl,
        authorization_servers: authServer ? [authServer] : [],
        scopes_supported: Array.isArray(config.scopesSupported) && config.scopesSupported.length
            ? config.scopesSupported
            : (config.requiredScope ? [config.requiredScope] : []),
        bearer_methods_supported: ['header']
    }
}

/**
 * @param {string} prmUrl absolute URL of the PRM document
 * @returns {string} value for the WWW-Authenticate response header
 */
function buildWwwAuthenticateHeader (prmUrl) {
    return `Bearer resource_metadata="${prmUrl}"`
}

module.exports = { buildProtectedResourceMetadata, buildWwwAuthenticateHeader }
