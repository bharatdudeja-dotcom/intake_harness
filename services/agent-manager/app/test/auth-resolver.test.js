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
 * resolveRequestAuth takes a plain `{ headers, host, packageName }` request
 * shape plus a loaded config (D34 portability tidy-up) - the host wrapper
 * normalizes its transport's request; no platform format reaches lib/auth.
 */

jest.mock('../lib/auth/oidc', () => ({ validateBearerToken: jest.fn() }))

const { validateBearerToken } = require('../lib/auth/oidc')
const { resolveRequestAuth, loadAuthConfig } = require('../lib/auth')

const HOST = '110557-tapmcpconnector-stage.adobeioruntime.net'
const EXPECTED_PRM_URL = 'https://110557-tapmcpconnector-stage.adobeioruntime.net/api/v1/web/tap-mcp-connector/well-known'

/** @returns {{headers: object, host: string, packageName: string}} */
function request (headers = {}) {
    return { headers, host: HOST, packageName: '' }
}

describe('lib/auth dual resolver', () => {
    beforeEach(() => {
        validateBearerToken.mockReset()
    })

    test('Authorization: Bearer routes to the OIDC path and succeeds on a valid token', async () => {
        validateBearerToken.mockResolvedValueOnce({ ok: true, userInfo: { sub: 'u1' } })
        const config = loadAuthConfig({ OIDC_ISSUER: 'https://issuer.example.com' })

        const result = await resolveRequestAuth(request({ authorization: 'Bearer sometoken' }), config)

        expect(result.ok).toBe(true)
        expect(result.mode).toBe('oidc')
        expect(result.userInfo.sub).toBe('u1')
    })

    test('Authorization: Bearer with an invalid token -> 401 with a PRM url for discovery', async () => {
        validateBearerToken.mockResolvedValueOnce({ ok: false, error: 'Invalid or expired token' })
        const config = loadAuthConfig({ OIDC_ISSUER: 'https://issuer.example.com' })

        const result = await resolveRequestAuth(request({ authorization: 'Bearer badtoken' }), config)

        expect(result.ok).toBe(false)
        expect(result.error).toBe('Invalid or expired token')
        expect(result.prmUrl).toBe(EXPECTED_PRM_URL)
    })

    test('x-api-key routes to the agent path and succeeds when it matches the configured key', async () => {
        const config = loadAuthConfig({ SERVICE_API_KEY: 'secret123' })

        const result = await resolveRequestAuth(request({ 'x-api-key': 'secret123' }), config)

        expect(result.ok).toBe(true)
        expect(result.mode).toBe('api-key')
        expect(validateBearerToken).not.toHaveBeenCalled()
    })

    test('x-api-key mismatch -> 401 with a PRM url', async () => {
        const config = loadAuthConfig({ SERVICE_API_KEY: 'secret123' })

        const result = await resolveRequestAuth(request({ 'x-api-key': 'wrong' }), config)

        expect(result.ok).toBe(false)
        expect(result.prmUrl).toBe(EXPECTED_PRM_URL)
    })

    test('x-api-key present but no service key configured -> 401', async () => {
        const config = loadAuthConfig({})

        const result = await resolveRequestAuth(request({ 'x-api-key': 'anything' }), config)

        expect(result.ok).toBe(false)
    })

    test('neither header present -> 401 with a PRM url', async () => {
        const config = loadAuthConfig({})

        const result = await resolveRequestAuth(request({}), config)

        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/authentication required/i)
        expect(result.prmUrl).toBe(EXPECTED_PRM_URL)
    })

    test('Authorization header present but not a Bearer scheme falls through to the x-api-key/neither path', async () => {
        const config = loadAuthConfig({})

        const result = await resolveRequestAuth(request({ authorization: 'Basic dXNlcjpwYXNz' }), config)

        expect(result.ok).toBe(false)
        expect(validateBearerToken).not.toHaveBeenCalled()
    })
})
