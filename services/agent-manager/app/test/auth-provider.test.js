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
 * Tests for the pluggable auth-provider switch (D66/Phase 1): AUTH_PROVIDER selects the
 * validation strategy and provider defaults; PRM advertises the selected provider's AS.
 */

const { loadAuthConfig } = require('../lib/auth/config')
const { buildProtectedResourceMetadata } = require('../lib/auth/prm')
const { validateBearerToken } = require('../lib/auth/oidc')

/** Build a decodable (unsigned) JWT with the given payload - for the compensating client check. */
function fakeJwt (payload) {
    const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return `${b64({ alg: 'none' })}.${b64(payload)}.`
}

describe('loadAuthConfig - provider selection (D66/D73: adobe-ims is the only active provider)', () => {
    test('explicit AUTH_PROVIDER=adobe-ims -> userinfo strategy + IMS issuer/discovery defaults', () => {
        const c = loadAuthConfig({ AUTH_PROVIDER: 'adobe-ims' })
        expect(c.provider).toBe('adobe-ims')
        expect(c.validationStrategy).toBe('userinfo')
        expect(c.issuer).toBe('https://ims-na1.adobelogin.com')
        expect(c.discoveryUrl).toContain('ims-na1.adobelogin.com')
        expect(c.discoveryUrl).toContain('/ims/.well-known/openid-configuration')
    })

    test('AUTH_PROVIDER=microsoft-entra is a selectable scaffold (jwks)', () => {
        const c = loadAuthConfig({ AUTH_PROVIDER: 'microsoft-entra', OIDC_ISSUER: 'https://login.microsoftonline.com/t/v2.0', OIDC_AUDIENCE: 'api://x' })
        expect(c.provider).toBe('microsoft-entra')
        expect(c.providerScaffold).toBe(true)
        expect(c.validationStrategy).toBe('jwks')
    })

    test('no AUTH_PROVIDER -> derived from the issuer host (back-compat); an unrecognized issuer falls back to adobe-ims', () => {
        expect(loadAuthConfig({ OIDC_ISSUER: 'https://ims-na1.adobelogin.com' }).provider).toBe('adobe-ims')
        expect(loadAuthConfig({ OIDC_ISSUER: 'https://login.microsoftonline.com/t/v2.0', OIDC_AUDIENCE: 'api://x' }).provider).toBe('microsoft-entra')
        expect(loadAuthConfig({ OIDC_ISSUER: 'https://foo.us.auth0.com/', OIDC_AUDIENCE: 'https://api' }).provider).toBe('adobe-ims')
    })

    test('an unrecognized AUTH_PROVIDER falls back to the default (adobe-ims), not the derive path', () => {
        expect(loadAuthConfig({ AUTH_PROVIDER: 'okta-nope', OIDC_ISSUER: 'https://x.us.auth0.com/' }).provider).toBe('adobe-ims')
    })

    test('D73: auth0 is no longer a registered provider - AUTH_PROVIDER=auth0 falls back to adobe-ims', () => {
        const c = loadAuthConfig({ AUTH_PROVIDER: 'auth0', OIDC_ISSUER: 'https://x.us.auth0.com/', OIDC_AUDIENCE: 'https://api' })
        expect(c.provider).toBe('adobe-ims')
        expect(c.providerDirectLogin).toBe(false)
    })

    test('legacy deployment: audience set, no provider -> jwks preserved (provider-agnostic heuristic)', () => {
        const c = loadAuthConfig({ OIDC_ISSUER: 'https://x.us.auth0.com/', OIDC_AUDIENCE: 'https://api' })
        expect(c.validationStrategy).toBe('jwks')
    })
})

describe('PRM advertises the selected provider AS (D66)', () => {
    test('auth0 issuer', () => {
        const c = loadAuthConfig({ AUTH_PROVIDER: 'auth0', OIDC_ISSUER: 'https://x.us.auth0.com/', OIDC_AUDIENCE: 'https://api' })
        const prm = buildProtectedResourceMetadata({ ...c, resourceUrl: 'https://mcp' })
        expect(prm.authorization_servers).toEqual(['https://x.us.auth0.com/'])
    })

    test('adobe-ims issuer default flows into PRM', () => {
        const c = loadAuthConfig({ AUTH_PROVIDER: 'adobe-ims' })
        const prm = buildProtectedResourceMetadata({ ...c, resourceUrl: 'https://mcp' })
        expect(prm.authorization_servers).toEqual(['https://ims-na1.adobelogin.com'])
    })

    test('adobe-ims with an explicit issuer (trailing slash) advertises that AS + openid/profile/email scopes (D67)', () => {
        const c = loadAuthConfig({ AUTH_PROVIDER: 'adobe-ims', OIDC_ISSUER: 'https://ims-na1.adobelogin.com/', OAUTH_CLIENT_ID: '7f7ad7', OIDC_REQUIRED_SCOPE: 'openid', OIDC_SCOPES: 'openid profile email' })
        expect(c.provider).toBe('adobe-ims')
        expect(c.validationStrategy).toBe('userinfo')
        expect(c.clientId).toBe('7f7ad7')
        const prm = buildProtectedResourceMetadata({ ...c, resourceUrl: 'https://mcp' })
        expect(prm.authorization_servers).toEqual(['https://ims-na1.adobelogin.com/'])
        expect(prm.scopes_supported).toEqual(['openid', 'profile', 'email'])
    })

    test('OIDC_SCOPES falls back to the required scope when unset', () => {
        const c = loadAuthConfig({ AUTH_PROVIDER: 'auth0', OIDC_ISSUER: 'https://x.us.auth0.com/', OIDC_AUDIENCE: 'https://api', OIDC_REQUIRED_SCOPE: 'resource.rw' })
        expect(c.scopesSupported).toEqual(['resource.rw'])
    })
})

describe('direct-vs-bridge login mode selection (D72/D73)', () => {
    // D73: Auth0 (the only directLogin provider so far) was removed at the operator's request -
    // adobe-ims is the sole active provider now, and it is NOT direct-login (needs the bridge).
    // The directLogin mechanism itself stays in place, unused by any active provider, for a
    // future public-client provider (see lib/auth/config.js PROVIDERS registry comment).
    test('no currently-registered provider is direct-login', () => {
        expect(loadAuthConfig({ AUTH_PROVIDER: 'adobe-ims' }).providerDirectLogin).toBe(false)
        expect(loadAuthConfig({ AUTH_PROVIDER: 'microsoft-entra', OIDC_ISSUER: 'https://login.microsoftonline.com/t/v2.0', OIDC_AUDIENCE: 'api://x' }).providerDirectLogin).toBe(false)
    })

    test('mechanism-level: PRM advertises the issuer DIRECTLY when providerDirectLogin is true (no active provider sets this today)', () => {
        const c = { issuer: 'https://idp.example/', providerDirectLogin: true }
        const authorizationServer = c.providerDirectLogin ? c.issuer : 'https://should-not-be-used/oauth-bridge'
        const prm = buildProtectedResourceMetadata({ ...c, resourceUrl: 'https://mcp', authorizationServer })
        expect(prm.authorization_servers).toEqual(['https://idp.example/'])
    })

    test('PRM advertises the login BRIDGE (not the real issuer) for adobe-ims', () => {
        const c = loadAuthConfig({ AUTH_PROVIDER: 'adobe-ims', MCP_OAUTH_BRIDGE_URL: 'https://stage.example/oauth-bridge' })
        const authorizationServer = c.providerDirectLogin ? c.issuer : c.oauthBridgeUrl
        const prm = buildProtectedResourceMetadata({ ...c, resourceUrl: 'https://mcp', authorizationServer })
        expect(prm.authorization_servers).toEqual(['https://stage.example/oauth-bridge'])
        expect(prm.authorization_servers).not.toEqual([c.issuer])
    })
})

describe('adobe-ims Bearer validation via userinfo (D67)', () => {
    const SPA = '7f7ad7e0a96342b1849f290df28f805e'
    const config = () => loadAuthConfig({ AUTH_PROVIDER: 'adobe-ims', OIDC_ISSUER: 'https://ims-na1.adobelogin.com/', OAUTH_CLIENT_ID: SPA, OIDC_REQUIRED_SCOPE: 'openid' })

    // Route the mocked IMS fetches by URL (discovery vs userinfo), robust to discovery caching.
    function mockIms (userinfo) {
        global.fetch = jest.fn(async (url) => String(url).includes('/userinfo')
            ? ({ ok: true, json: async () => userinfo })
            : ({ ok: true, json: async () => ({ userinfo_endpoint: 'https://ims-na1.adobelogin.com/ims/userinfo/v2' }) }))
    }
    afterEach(() => { delete global.fetch })

    test('valid IMS token (client_id matches the SPA) -> ok, owner-relevant email returned', async () => {
        mockIms({ sub: 'ABC@AdobeID', email: 'bharat.dudeja@tapcxm.com' })
        const token = fakeJwt({ client_id: SPA, scope: 'openid profile email' })
        const res = await validateBearerToken(token, config())
        expect(res.ok).toBe(true)
        expect(res.userInfo.email).toBe('bharat.dudeja@tapcxm.com')
    })

    // D78 regression, from a REAL live token: IMS emits the scope claim COMMA-separated, not
    // space-separated as RFC 6749 specifies. A whitespace-only split read the whole thing as one
    // bogus scope and rejected every genuine token with "missing required scope 'openid'".
    test('accepts a COMMA-separated scope claim - the shape IMS actually issues', async () => {
        mockIms({ sub: 'ABC@AdobeID', email: 'bharat.dudeja@tapcxm.com' })
        const token = fakeJwt({ client_id: SPA, scope: 'openid,profile,email,AdobeID' })
        const res = await validateBearerToken(token, config())
        expect(res.ok).toBe(true)
        expect(res.userInfo.email).toBe('bharat.dudeja@tapcxm.com')
    })

    test('a comma-separated scope claim that genuinely lacks the required scope is still rejected', async () => {
        mockIms({ sub: 'x', email: 'x@y' })
        const token = fakeJwt({ client_id: SPA, scope: 'profile,email,AdobeID' }) // no openid
        const res = await validateBearerToken(token, config())
        expect(res.ok).toBe(false)
        expect(res.error).toMatch(/missing required scope 'openid'/)
    })

    test('a token minted for a DIFFERENT client is rejected (client binding)', async () => {
        mockIms({ sub: 'x', email: 'x@y' })
        const token = fakeJwt({ client_id: 'some-other-client', scope: 'openid' })
        const res = await validateBearerToken(token, config())
        expect(res.ok).toBe(false)
        expect(res.error).toMatch(/not issued for this connector|client/i)
    })

    test('an opaque IMS token is accepted on userinfo validity alone (no decodable client claim)', async () => {
        mockIms({ sub: 'opaque-sub', email: 'person@tapcxm.com' })
        const res = await validateBearerToken('opaque-token-no-dots', config())
        expect(res.ok).toBe(true)
        expect(res.userInfo.email).toBe('person@tapcxm.com')
    })

    test('userinfo rejects the token (401) -> not ok', async () => {
        global.fetch = jest.fn(async (url) => String(url).includes('/userinfo')
            ? ({ ok: false, status: 401, json: async () => ({}) })
            : ({ ok: true, json: async () => ({ userinfo_endpoint: 'https://ims-na1.adobelogin.com/ims/userinfo/v2' }) }))
        const res = await validateBearerToken('opaque-token', config())
        expect(res.ok).toBe(false)
    })
})
