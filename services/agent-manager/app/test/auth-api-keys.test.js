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
 * Multi-key -> owner mapping (D55): lib/auth/apiKeys.js pure lookup, plus the resolver
 * wiring (lib/auth/index.js) that turns a mapped key into a second user's owner identity.
 */

const { parseKeyOwners, resolveApiKeyOwner } = require('../lib/auth/apiKeys')

describe('lib/auth/apiKeys - parseKeyOwners', () => {
    // D79: entries normalize to a richer identity object. A bare string stays valid (back-compat).
    test('parses the legacy string shape into a normalized identity', () => {
        expect(parseKeyOwners('{"k1":"bob@example.com","k2":"carol"}')).toEqual({
            k1: { owner: 'bob@example.com', userId: 'bob@example.com', email: '', roles: [] },
            k2: { owner: 'carol', userId: 'carol', email: '', roles: [] }
        })
    })

    test('parses the rich object shape, preferring email as the owner identity (D79)', () => {
        expect(parseKeyOwners('{"k1":{"userId":"alice","email":"alice@a.example","roles":["chef"]}}')).toEqual({
            k1: { owner: 'alice@a.example', userId: 'alice', email: 'alice@a.example', roles: ['chef'] }
        })
    })

    test('a rich entry with only a userId uses it as the owner', () => {
        expect(parseKeyOwners('{"k1":{"userId":"viewer","roles":["viewer"]}}').k1)
            .toEqual({ owner: 'viewer', userId: 'viewer', email: '', roles: ['viewer'] })
    })
    test('empty/unset/malformed input yields an empty map, never throws', () => {
        expect(parseKeyOwners('')).toEqual({})
        expect(parseKeyOwners(undefined)).toEqual({})
        expect(parseKeyOwners('not json')).toEqual({})
        expect(parseKeyOwners('[]')).toEqual({})
        expect(parseKeyOwners('null')).toEqual({})
    })
    test('skips unusable entries without failing the whole map (one bad entry cannot lock everyone out)', () => {
        expect(parseKeyOwners('{"k1":123,"k2":"ok","k3":{},"k4":[]}')).toEqual({
            k2: { owner: 'ok', userId: 'ok', email: '', roles: [] }
        })
    })
})

describe('lib/auth/apiKeys - resolveApiKeyOwner', () => {
    const config = { serviceApiKey: 'shared-secret', apiKeyOwnersRaw: '{"tap_bob_x":"bob@example.com"}' }

    test('the default service key resolves with no owner override (service-account fallback applies downstream)', () => {
        expect(resolveApiKeyOwner('shared-secret', config)).toEqual({ ok: true, owner: null })
    })
    test('a mapped key resolves to its owner label', () => {
        expect(resolveApiKeyOwner('tap_bob_x', config)).toEqual({ ok: true, owner: 'bob@example.com', userId: 'bob@example.com', email: '', roles: [] })
    })
    test('an unrecognized key is rejected', () => {
        expect(resolveApiKeyOwner('nope', config)).toEqual({ ok: false })
    })
    test('with no mapping configured, only the default key resolves', () => {
        const bare = { serviceApiKey: 'shared-secret' }
        expect(resolveApiKeyOwner('shared-secret', bare)).toEqual({ ok: true, owner: null })
        expect(resolveApiKeyOwner('anything', bare)).toEqual({ ok: false })
    })
})

describe('lib/auth resolver - mapped key produces a per-user identity (D55)', () => {
    jest.mock('../lib/auth/oidc', () => ({ validateBearerToken: jest.fn() }))
    const { resolveRequestAuth, loadAuthConfig } = require('../lib/auth')

    test('a mapped x-api-key resolves ok with userInfo.sub set to the mapped owner', async () => {
        const config = loadAuthConfig({ SERVICE_API_KEY: 'shared-secret', API_KEY_OWNERS: '{"tap_bob_x":"bob@example.com"}' })
        const result = await resolveRequestAuth({ headers: { 'x-api-key': 'tap_bob_x' }, host: 'h', packageName: '' }, config)
        expect(result.ok).toBe(true)
        expect(result.mode).toBe('api-key')
        expect(result.userInfo).toEqual({ sub: 'bob@example.com' })
    })

    test('the default service key still resolves with no userInfo (service-account fallback)', async () => {
        const config = loadAuthConfig({ SERVICE_API_KEY: 'shared-secret', API_KEY_OWNERS: '{"tap_bob_x":"bob@example.com"}' })
        const result = await resolveRequestAuth({ headers: { 'x-api-key': 'shared-secret' }, host: 'h', packageName: '' }, config)
        expect(result.ok).toBe(true)
        expect(result.userInfo).toBeUndefined()
    })

    test('an unmapped, non-default key is still rejected', async () => {
        const config = loadAuthConfig({ SERVICE_API_KEY: 'shared-secret', API_KEY_OWNERS: '{"tap_bob_x":"bob@example.com"}' })
        const result = await resolveRequestAuth({ headers: { 'x-api-key': 'someone-elses-key' }, host: 'h', packageName: '' }, config)
        expect(result.ok).toBe(false)
    })
})
