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
 * Tests the JWKS/JWT verification path (Auth0-style, D24) with REAL jose signature
 * verification against a locally-generated RS256 keypair - lib/auth/jwks.js is mocked
 * so `getJwks()` returns a `createLocalJWKSet` resolver instead of fetching over the
 * network, but the actual cryptographic verification (signature, iss, aud, exp) is
 * exercised for real via `jose.jwtVerify`.
 */

jest.mock('../lib/auth/jwks', () => ({ getJwks: jest.fn() }))

const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require('jose')

const ISSUER = 'https://dev-test.us.auth0.com/'
const AUDIENCE = 'https://tap-mcp-connector'
const CLIENT_ID = 'uMhNS8shtfhNQIO5XEnTZn9WqzWvjmA0'
const DISCOVERY_URL = `${ISSUER}.well-known/openid-configuration`
const JWKS_URI = `${ISSUER}.well-known/jwks.json`
const KID = 'test-key-1'

const baseConfig = {
    issuer: ISSUER,
    discoveryUrl: DISCOVERY_URL,
    audience: AUDIENCE,
    clientId: CLIENT_ID,
    requiredScope: 'resource.rw'
}

let signingKey // the "real" key, published in the JWKS
let otherKey // a second key never published, used to forge a bad signature
let getJwks
let validateBearerToken

beforeAll(async () => {
    signingKey = await generateKeyPair('RS256')
    otherKey = await generateKeyPair('RS256')
})

beforeEach(() => {
    // oidc.js caches the discovery document at module scope (by design, for
    // production use) - reset the module registry per test so each test's fetch
    // mock isn't served from a previous test's cached discovery doc.
    jest.resetModules()
    ;({ getJwks } = require('../lib/auth/jwks'))
    ;({ validateBearerToken } = require('../lib/auth/oidc'))

    global.fetch = jest.fn(async (url) => {
        if (url === DISCOVERY_URL) {
            return { ok: true, json: async () => ({ jwks_uri: JWKS_URI, userinfo_endpoint: `${ISSUER}userinfo` }) }
        }
        throw new Error(`unexpected fetch in test: ${url}`)
    })
})

/** @returns {Promise<string>} a signed JWT, defaults matching a valid token for baseConfig */
async function makeToken ({ issuer = ISSUER, audience = AUDIENCE, scope = 'resource.rw', azp = CLIENT_ID, exp, signWith = signingKey.privateKey, kid = KID } = {}) {
    let builder = new SignJWT({ scope, azp })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuedAt()

    if (issuer !== null) builder = builder.setIssuer(issuer)
    if (audience !== null) builder = builder.setAudience(audience)
    builder = exp !== undefined ? builder.setExpirationTime(exp) : builder.setExpirationTime('1h')

    return builder.sign(signWith)
}

async function localJwks () {
    const jwk = await exportJWK(signingKey.publicKey)
    return createLocalJWKSet({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] })
}

describe('lib/auth/oidc JWKS path (Auth0-style, real signature verification)', () => {
    test('valid token (correct signature, issuer, audience, scope, client) is accepted', async () => {
        getJwks.mockReturnValue(await localJwks())
        const token = await makeToken()

        const result = await validateBearerToken(token, baseConfig)

        expect(result.ok).toBe(true)
        expect(result.claims.scope).toBe('resource.rw')
    })

    test('D55: a valid token returns userInfo built from its claims, so owner resolution does not collapse to service-account', async () => {
        getJwks.mockReturnValue(await localJwks())
        const withSub = await new (require('jose').SignJWT)({ scope: 'resource.rw', azp: CLIENT_ID, sub: 'auth0|abc123', email: 'person@example.com' })
            .setProtectedHeader({ alg: 'RS256', kid: KID })
            .setIssuedAt().setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime('1h')
            .sign(signingKey.privateKey)

        const result = await validateBearerToken(withSub, baseConfig)

        expect(result.ok).toBe(true)
        expect(result.userInfo).toBeDefined()
        expect(result.userInfo.sub).toBe('auth0|abc123')
        expect(result.userInfo.email).toBe('person@example.com')
    })

    test('expired token is rejected', async () => {
        getJwks.mockReturnValue(await localJwks())
        const token = await makeToken({ exp: Math.floor(Date.now() / 1000) - 60 })

        const result = await validateBearerToken(token, baseConfig)

        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/expired/i)
    })

    test('wrong audience is rejected', async () => {
        getJwks.mockReturnValue(await localJwks())
        const token = await makeToken({ audience: 'https://someone-elses-api' })

        const result = await validateBearerToken(token, baseConfig)

        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/claim validation failed/i)
    })

    test('wrong issuer is rejected', async () => {
        getJwks.mockReturnValue(await localJwks())
        const token = await makeToken({ issuer: 'https://not-our-tenant.us.auth0.com/' })

        const result = await validateBearerToken(token, baseConfig)

        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/claim validation failed/i)
    })

    test('bad signature (token signed with an unpublished key) is rejected', async () => {
        getJwks.mockReturnValue(await localJwks())
        // signed with otherKey's private key but claims kid of the published key -
        // jose finds the published key by kid, then fails to verify the signature with it.
        const token = await makeToken({ signWith: otherKey.privateKey })

        const result = await validateBearerToken(token, baseConfig)

        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/signature/i)
    })

    test('missing token is rejected without any network or JWKS calls', async () => {
        const result = await validateBearerToken('', baseConfig)

        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/missing/i)
        expect(getJwks).not.toHaveBeenCalled()
    })

    test('missing/insufficient scope is rejected (strict enforcement on the JWKS path)', async () => {
        getJwks.mockReturnValue(await localJwks())
        const token = await makeToken({ scope: 'some.other.scope' })

        const result = await validateBearerToken(token, baseConfig)

        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/required scope/i)
    })

    test('Auth0 RBAC permissions claim satisfies the required scope', async () => {
        getJwks.mockReturnValue(await localJwks())
        const token = await new SignJWT({ permissions: ['resource.rw'], azp: CLIENT_ID, sub: 'auth0|abc123' })
            .setProtectedHeader({ alg: 'RS256', kid: KID })
            .setIssuedAt()
            .setIssuer(ISSUER)
            .setAudience(AUDIENCE)
            .setExpirationTime('1h')
            .sign(signingKey.privateKey)

        const result = await validateBearerToken(token, baseConfig)

        expect(result.ok).toBe(true)
    })

    test('client mismatch (azp does not match configured OAUTH_CLIENT_ID) is rejected', async () => {
        getJwks.mockReturnValue(await localJwks())
        const token = await makeToken({ azp: 'some-other-client-id' })

        const result = await validateBearerToken(token, baseConfig)

        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/client mismatch/i)
    })

    test('no clientId configured skips the client-binding check', async () => {
        getJwks.mockReturnValue(await localJwks())
        const token = await makeToken({ azp: 'anyone' })

        const result = await validateBearerToken(token, { ...baseConfig, clientId: '' })

        expect(result.ok).toBe(true)
    })

    test('discovery document missing jwks_uri is rejected', async () => {
        global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) }))
        const token = await makeToken()

        const result = await validateBearerToken(token, baseConfig)

        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/jwks_uri/i)
        expect(getJwks).not.toHaveBeenCalled()
    })
})
