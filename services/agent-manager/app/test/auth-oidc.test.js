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

/** @returns {string} an unsigned JWT with the given payload (signature is not verified by our code) */
function makeJwt (payload) {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return `${header}.${body}.signature`
}

const config = {
    issuer: 'https://issuer.example.com',
    discoveryUrl: 'https://issuer.example.com/.well-known/openid-configuration',
    clientId: 'expected-client-id',
    requiredScope: 'openid'
}

describe('lib/auth/oidc validateBearerToken', () => {
    let fetchMock
    let validateBearerToken

    beforeEach(() => {
        // oidc.js caches the discovery document at module scope (by design, for
        // production use) - reset the module registry per test so each test's
        // fetchMock queue isn't served from a previous test's cached discovery doc.
        jest.resetModules()
        ;({ validateBearerToken } = require('../lib/auth/oidc'))
        fetchMock = jest.fn()
        global.fetch = fetchMock
    })

    function mockDiscovery (doc = { userinfo_endpoint: 'https://issuer.example.com/userinfo' }) {
        fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => doc }))
    }

    test('missing token is rejected without any network calls', async () => {
        const result = await validateBearerToken('', config)
        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/missing/i)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    test('no OIDC provider configured is rejected', async () => {
        const result = await validateBearerToken('some-token', { issuer: '' })
        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/no oidc provider/i)
    })

    test('opaque (non-JWT) token is accepted on userinfo validity alone', async () => {
        mockDiscovery()
        fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ sub: 'abc' }) }))
        const result = await validateBearerToken('opaque-token-not-a-jwt', config)
        expect(result.ok).toBe(true)
        expect(result.userInfo.sub).toBe('abc')
        expect(result.claims).toBeNull()
    })

    test('decodable JWT with matching client_id and required scope is valid', async () => {
        const token = makeJwt({ client_id: 'expected-client-id', scope: 'openid profile', exp: Math.floor(Date.now() / 1000) + 3600 })
        mockDiscovery()
        fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ sub: 'u1' }) }))
        const result = await validateBearerToken(token, config)
        expect(result.ok).toBe(true)
    })

    test('decodable JWT with wrong client_id (azp) is rejected - the audience-binding compensating control', async () => {
        const token = makeJwt({ azp: 'someone-elses-client', scope: 'openid', exp: Math.floor(Date.now() / 1000) + 3600 })
        mockDiscovery()
        fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({}) }))
        const result = await validateBearerToken(token, config)
        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/not issued for this connector/i)
    })

    test('decodable JWT with matching client_id but wrong scope is rejected', async () => {
        const token = makeJwt({ client_id: 'expected-client-id', scope: 'profile', exp: Math.floor(Date.now() / 1000) + 3600 })
        mockDiscovery()
        fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({}) }))
        const result = await validateBearerToken(token, config)
        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/required scope/i)
    })

    test('decodable JWT with matching client_id and no scope claim at all is accepted (nothing to enforce)', async () => {
        const token = makeJwt({ client_id: 'expected-client-id', exp: Math.floor(Date.now() / 1000) + 3600 })
        mockDiscovery()
        fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({}) }))
        const result = await validateBearerToken(token, config)
        expect(result.ok).toBe(true)
    })

    test('expired token (decodable) is rejected without calling userinfo', async () => {
        const token = makeJwt({ client_id: 'expected-client-id', exp: Math.floor(Date.now() / 1000) - 10 })
        const result = await validateBearerToken(token, config)
        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/expired/i)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    test('userinfo endpoint rejects the token -> invalid', async () => {
        mockDiscovery()
        fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 401 }))
        const result = await validateBearerToken('bad-token', config)
        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/invalid or expired/i)
    })

    test('discovery document missing userinfo_endpoint -> rejected', async () => {
        mockDiscovery({})
        const result = await validateBearerToken('some-token', config)
        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/userinfo endpoint/i)
    })

    test('no clientId configured skips the compensating checks entirely', async () => {
        const token = makeJwt({ client_id: 'anything-at-all', exp: Math.floor(Date.now() / 1000) + 3600 })
        mockDiscovery()
        fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({}) }))
        const result = await validateBearerToken(token, { ...config, clientId: '' })
        expect(result.ok).toBe(true)
    })
})
