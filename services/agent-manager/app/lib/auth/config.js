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
 * Provider-neutral OIDC auth configuration (D21).
 *
 * Adobe IMS is this deployment's configured provider, not a hardcoded dependency -
 * pointing this connector at a different OIDC provider (Cognito, Entra, Okta) is a config
 * change (these env vars), not a code change. See .env.example. (D73: Auth0 support was
 * built and live-tested through D72, then removed at the operator's request - IMS is the only
 * active provider now; Microsoft Entra remains an optional config-only scaffold for later.)
 *
 * `issuer` is kept EXACTLY as configured (no trailing-slash normalization) - providers are
 * inconsistent here (some include a trailing slash, some don't), and for the JWKS verification
 * path (lib/auth/oidc.js), `issuer` is compared byte-for-byte against the token's `iss` claim,
 * so normalizing it would break that check for a provider that does include the slash.
 */

function trim (value) {
    return (value && String(value).trim()) || ''
}

/**
 * Pluggable auth-provider registry (D66). Selecting a provider drives (a) the validation
 * strategy, (b) which authorization server the PRM advertises, and (c) whether the MCP client
 * talks to that provider DIRECTLY or through the login bridge (D72). This is the ONLY module
 * that names providers (an allowed adapter seam, D21/D34) - lib/auth/oidc.js stays vendor-neutral.
 *
 * validation: 'jwks'     -> audience-bound JWT verification (Entra, Cognito, Okta...).
 *             'userinfo' -> userinfo-endpoint validation (Adobe IMS - no RFC 8707 audience).
 *
 * directLogin: true  -> the PRM advertises this provider's own issuer; the MCP client (e.g.
 *   mcp-remote) performs OAuth directly against it using ITS OWN localhost redirect_uri, with a
 *   static public client (registered ahead of time; no DCR/relay needed) - only viable for a
 *   provider whose credential type permits a localhost redirect (a public Native/SPA app - D72
 *   proved this live with Auth0 before it was removed per the operator's request, D73).
 * directLogin: false (default) -> the PRM advertises the login bridge instead
 *   (actions/oauth-bridge, lib/auth/oauthBridge.js) - needed for a provider whose credential
 *   only allows HTTPS redirects (Adobe IMS's SPA credential - confirmed live, D68/AUTH-PROVIDER-
 *   SPIKE.md §6). Both paths converge on the SAME lib/auth/oidc.js validation.
 *
 * D73: Adobe IMS is the only ACTIVE provider right now (the operator's explicit choice, after
 * Auth0 was built + live-tested through D72). Microsoft Entra stays a config-only scaffold
 * (no live wiring) for optional later use. Re-adding another live provider is additive here -
 * see git history on this file for the removed Auth0 entry if it's ever wanted back.
 */
const PROVIDERS = {
    'adobe-ims': {
        label: 'Adobe IMS',
        validation: 'userinfo',
        defaultIssuer: 'https://ims-na1.adobelogin.com',
        defaultDiscoveryUrl: 'https://ims-na1.adobelogin.com/ims/.well-known/openid-configuration'
    },
    // Scaffold only (no live wiring) - optional for later. Entra issues audience-bound JWTs, so JWKS.
    'microsoft-entra': { label: 'Microsoft Entra ID', validation: 'jwks', scaffold: true }
}
const DEFAULT_PROVIDER = 'adobe-ims'

/**
 * Resolve the configured provider id. Explicit AUTH_PROVIDER wins; otherwise derive from the
 * issuer host so existing deployments keep working without setting the new var.
 * @param {string} rawProvider AUTH_PROVIDER value
 * @param {string} issuer OIDC_ISSUER value
 * @returns {keyof PROVIDERS}
 */
function resolveProvider (rawProvider, issuer) {
    const explicit = trim(rawProvider).toLowerCase()
    if (PROVIDERS[explicit]) return explicit
    const iss = trim(issuer).toLowerCase()
    if (iss.includes('adobelogin.com')) return 'adobe-ims'
    if (iss.includes('microsoftonline.com') || iss.includes('login.microsoft')) return 'microsoft-entra'
    return DEFAULT_PROVIDER
}

/**
 * Standard OIDC discovery document location, correct whether or not `issuer`
 * already ends with a trailing slash (both conventions occur in the wild).
 * @param {string} issuer
 * @returns {string}
 */
function buildDiscoveryUrl (issuer) {
    if (!issuer) return ''
    return issuer.endsWith('/') ? `${issuer}.well-known/openid-configuration` : `${issuer}/.well-known/openid-configuration`
}

/**
 * @param {Record<string, any>} params action input parameters (env-backed)
 * @returns {{
 *   issuer: string, discoveryUrl: string, audience: string, clientId: string, clientSecret: string,
 *   requiredScope: string, serviceApiKey: string, resourceUrl: string, prmUrl: string
 * }}
 */
function loadAuthConfig (params = {}) {
    const explicitProvider = trim(params.AUTH_PROVIDER).toLowerCase()
    const provider = resolveProvider(params.AUTH_PROVIDER, params.OIDC_ISSUER)
    const providerDef = PROVIDERS[provider]
    // Provider defaults fill in only when the deployment didn't set an explicit value, so an
    // operator can select `adobe-ims` and get IMS's issuer/discovery without copying URLs.
    const issuer = trim(params.OIDC_ISSUER) || (PROVIDERS[explicitProvider] ? providerDef.defaultIssuer : '') || ''
    const discoveryUrl = trim(params.OIDC_DISCOVERY_URL) || (PROVIDERS[explicitProvider] ? providerDef.defaultDiscoveryUrl : '') || buildDiscoveryUrl(issuer)
    const audience = trim(params.OIDC_AUDIENCE)
    // Validation strategy. When a provider is EXPLICITLY selected, use its strategy (userinfo
    // only makes sense without an audience; an audience always forces JWKS). When no provider is
    // set, preserve the original back-compat heuristic exactly: audience -> jwks, else userinfo.
    const validationStrategy = PROVIDERS[explicitProvider]
        ? ((providerDef.validation === 'userinfo' && !audience) ? 'userinfo' : (audience ? 'jwks' : providerDef.validation))
        : (audience ? 'jwks' : 'userinfo')

    return {
        provider,
        providerLabel: providerDef.label,
        providerScaffold: !!providerDef.scaffold,
        // D72: true when the MCP client should perform OAuth directly against this provider
        // (its own localhost redirect, a static public client) instead of via the login bridge.
        providerDirectLogin: !!providerDef.directLogin,
        validationStrategy,
        issuer,
        discoveryUrl,
        // Audience binding for the JWKS path (real RFC 8707 - Entra, Cognito, Okta...). Blank
        // for the userinfo path (IMS). `validationStrategy` above is the authoritative selector.
        audience,
        clientId: trim(params.OAUTH_CLIENT_ID),
        clientSecret: trim(params.OAUTH_CLIENT_SECRET),
        // Public SPA client id for the dashboard's own browser login (PKCE, no secret).
        // Safe to expose to the browser; when unset, the dashboard stays in anonymous
        // shared-key mode so nothing breaks before the credential is provisioned (D65).
        dashboardClientId: trim(params.DASHBOARD_OAUTH_CLIENT_ID),
        // Interim static passcode gate (D65 stopgap): until per-user IMS login is live, the
        // dashboard proxy requires this shared passcode on every data call so the cookbook
        // isn't world-open. Enforced server-side here (the SPA only collects it). NOT a real
        // secret - a weak shared code; superseded by per-user login. Only ever set via env.
        dashboardPasscode: trim(params.DASHBOARD_PASSCODE),
        // Single scope the token MUST carry (the enforcement check). IMS access tokens include
        // "openid" when the client requests it, so that's the safe required scope for adobe-ims.
        requiredScope: trim(params.OIDC_REQUIRED_SCOPE) || 'openid',
        // Scopes ADVERTISED in the PRM (RFC 9728) so the MCP client requests them at sign-in.
        // For IMS we want "openid profile email" so userinfo returns a human-readable email to
        // resolve the owner from. Space-separated OIDC_SCOPES -> array; defaults to requiredScope.
        scopesSupported: (trim(params.OIDC_SCOPES) || trim(params.OIDC_REQUIRED_SCOPE) || 'openid').split(/\s+/).filter(Boolean),
        serviceApiKey: trim(params.SERVICE_API_KEY),
        // Multi-key -> owner mapping (D55) - a JSON object string, parsed in lib/auth/apiKeys.js.
        // Real key values only ever live in .env / action params, never a committed file.
        apiKeyOwnersRaw: trim(params.API_KEY_OWNERS),
        // Optional explicit overrides; otherwise derived per-request from the Host header (lib/auth/urls.js).
        resourceUrl: trim(params.MCP_RESOURCE_URL),
        prmUrl: trim(params.MCP_PRM_URL),
        // D68 login bridge base URL override (see lib/auth/urls.js#resolveOAuthBridgeUrl).
        oauthBridgeUrl: trim(params.MCP_OAUTH_BRIDGE_URL),
        // D78: the AS issuer advertised in the PRM - see lib/auth/urls.js#resolveOAuthIssuerUrl for
        // why this is separate from the bridge action's own base URL.
        oauthIssuerUrl: trim(params.OAUTH_ISSUER_URL)
    }
}

/**
 * @param {{issuer: string}} config
 * @returns {boolean} true if an OIDC provider is configured on this deployment
 */
function isOidcConfigured (config) {
    return !!config.issuer
}

module.exports = { loadAuthConfig, isOidcConfigured }
