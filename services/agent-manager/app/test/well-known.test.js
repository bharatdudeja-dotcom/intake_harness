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

const { main } = require('../actions/well-known/index.js')

describe('well-known action (RFC 9728 PRM endpoint)', () => {
    test('GET returns a valid PRM document shaped correctly for this deployment', async () => {
        const result = await main({
            __ow_method: 'get',
            __ow_headers: { host: '110557-tapmcpconnector-stage.adobeioruntime.net' },
            OIDC_ISSUER: 'https://ims-na1.adobelogin.com',
            OIDC_REQUIRED_SCOPE: 'openid',
            LOG_LEVEL: 'error'
        })

        expect(result.statusCode).toBe(200)
        expect(result.headers['Content-Type']).toBe('application/json')

        const doc = JSON.parse(result.body)
        expect(doc.resource).toBe('https://110557-tapmcpconnector-stage.adobeioruntime.net/api/v1/web/tap-mcp-connector/mcp-server')
        // D68: the PRM advertises the login BRIDGE, not the real provider directly - a client's
        // localhost redirect_uri would otherwise be sent straight to the provider, which rejects
        // it (see knowledge/AUTH-PROVIDER-SPIKE.md §6).
        expect(doc.authorization_servers).toEqual(['https://110557-tapmcpconnector-stage.adobeioruntime.net/api/v1/web/tap-mcp-connector/oauth-bridge'])
        expect(doc.scopes_supported).toEqual(['openid'])
        expect(doc.bearer_methods_supported).toEqual(['header'])
    })

    test('OPTIONS returns a CORS preflight response', async () => {
        const result = await main({ __ow_method: 'options' })
        expect(result.statusCode).toBe(200)
        expect(result.headers['Access-Control-Allow-Origin']).toBe('*')
    })

    // D73: Auth0 (the only direct-login provider) was removed at the operator's request -
    // AUTH_PROVIDER=auth0 is no longer recognized and falls back to the default (adobe-ims),
    // which still goes through the login bridge, same as leaving AUTH_PROVIDER unset.
    test('AUTH_PROVIDER=auth0 is no longer recognized - falls back to adobe-ims + the login bridge', async () => {
        const result = await main({
            __ow_method: 'get',
            __ow_headers: { host: '110557-tapmcpconnector-stage.adobeioruntime.net' },
            AUTH_PROVIDER: 'auth0',
            OIDC_ISSUER: 'https://dev-ot2kvu3dt7xym2fc.us.auth0.com/',
            OIDC_AUDIENCE: 'https://110557-tapmcpconnector-stage.adobeioruntime.net/api/v1/web/tap-mcp-connector/mcp-server',
            OIDC_REQUIRED_SCOPE: 'openid',
            LOG_LEVEL: 'error'
        })
        const doc = JSON.parse(result.body)
        expect(doc.authorization_servers).toEqual(['https://110557-tapmcpconnector-stage.adobeioruntime.net/api/v1/web/tap-mcp-connector/oauth-bridge'])
    })

    // Unchanged back-compat: adobe-ims (no AUTH_PROVIDER override) still goes through the bridge.
    test('adobe-ims (derived from the IMS issuer, no AUTH_PROVIDER set) still advertises the login bridge', async () => {
        const result = await main({
            __ow_method: 'get',
            __ow_headers: { host: '110557-tapmcpconnector-stage.adobeioruntime.net' },
            OIDC_ISSUER: 'https://ims-na1.adobelogin.com',
            OIDC_REQUIRED_SCOPE: 'openid',
            LOG_LEVEL: 'error'
        })
        const doc = JSON.parse(result.body)
        expect(doc.authorization_servers).toEqual(['https://110557-tapmcpconnector-stage.adobeioruntime.net/api/v1/web/tap-mcp-connector/oauth-bridge'])
    })
})
