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
 * Tests for the OAuth login bridge's persistence + PKCE logic (D68). The upstream
 * @adobe/aio-lib-files call is mocked with an in-memory Map (same pattern as cx-graph.test.js)
 * so these exercise the real transaction/grant lifecycle, not the storage backend.
 */

jest.mock('@adobe/aio-lib-files')
const filesLib = require('@adobe/aio-lib-files')

let data
beforeEach(() => {
    data = new Map()
    filesLib.init = jest.fn(async () => ({
        list: jest.fn(async (path) => (data.has(path) ? [{ name: path }] : [])),
        read: jest.fn(async (path) => data.get(path)),
        write: jest.fn(async (path, content) => { const buf = Buffer.isBuffer(content) ? content : Buffer.from(content); data.set(path, buf); return buf.length }),
        delete: jest.fn(async (path) => { data.delete(path); return [] })
    }))
    jest.resetModules()
})

const bridge = require('../lib/auth/oauthBridge')

describe('PKCE helpers', () => {
    test('challengeFor is deterministic and matches a known RFC 7636 test vector', () => {
        // RFC 7636 Appendix B example verifier/challenge pair.
        const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
        expect(bridge.challengeFor(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
    })
    test('randomVerifier produces distinct, URL-safe values', () => {
        const a = bridge.randomVerifier(); const b = bridge.randomVerifier()
        expect(a).not.toBe(b)
        expect(a).not.toMatch(/[+/=]/)
    })
})

describe('transaction lifecycle (/authorize <-> /callback leg)', () => {
    test('beginTransaction stores the mcp-remote request + a fresh upstream PKCE pair', async () => {
        const { txnId, upstreamVerifier, upstreamChallenge } = await bridge.beginTransaction({
            redirectUri: 'http://localhost:3769/oauth/callback', state: 'mcp-state', codeChallenge: 'mcp-challenge', codeChallengeMethod: 'S256'
        })
        expect(txnId).toMatch(/^txn_/)
        expect(bridge.challengeFor(upstreamVerifier)).toBe(upstreamChallenge)
    })

    test('consumeTransaction returns the stored data exactly once (single-use)', async () => {
        const { txnId } = await bridge.beginTransaction({ redirectUri: 'http://localhost:1/x', state: 's', codeChallenge: 'c', codeChallengeMethod: 'S256' })
        const first = await bridge.consumeTransaction(txnId)
        expect(first.mcp.redirectUri).toBe('http://localhost:1/x')
        const second = await bridge.consumeTransaction(txnId)
        expect(second).toBeNull()
    })

    test('consumeTransaction returns null for an unknown id', async () => {
        expect(await bridge.consumeTransaction('txn_does-not-exist')).toBeNull()
    })
})

describe('grant lifecycle (/callback -> /token leg)', () => {
    test('redeemGrant succeeds when the code_verifier matches the stored challenge', async () => {
        const verifier = bridge.randomVerifier()
        const code = await bridge.issueGrant({ accessToken: 'ACCESS', tokenType: 'Bearer', expiresIn: 3600, mcpCodeChallenge: bridge.challengeFor(verifier), mcpCodeChallengeMethod: 'S256' })
        const result = await bridge.redeemGrant(code, verifier)
        expect(result).toEqual({ ok: true, accessToken: 'ACCESS', tokenType: 'Bearer', expiresIn: 3600 })
    })

    test('redeemGrant is rejected when the code_verifier does NOT match (PKCE enforcement)', async () => {
        const code = await bridge.issueGrant({ accessToken: 'ACCESS', mcpCodeChallenge: bridge.challengeFor(bridge.randomVerifier()), mcpCodeChallengeMethod: 'S256' })
        const result = await bridge.redeemGrant(code, 'wrong-verifier')
        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/PKCE/i)
    })

    test('redeemGrant is single-use - a second redemption with the correct verifier fails', async () => {
        const verifier = bridge.randomVerifier()
        const code = await bridge.issueGrant({ accessToken: 'A', mcpCodeChallenge: bridge.challengeFor(verifier), mcpCodeChallengeMethod: 'S256' })
        expect((await bridge.redeemGrant(code, verifier)).ok).toBe(true)
        expect((await bridge.redeemGrant(code, verifier)).ok).toBe(false)
    })

    test('redeemGrant rejects an unsupported code_challenge_method', async () => {
        const code = await bridge.issueGrant({ accessToken: 'A', mcpCodeChallenge: 'x', mcpCodeChallengeMethod: 'plain' })
        const result = await bridge.redeemGrant(code, 'x')
        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/S256/)
    })

    test('redeemGrant rejects an unknown code', async () => {
        const result = await bridge.redeemGrant('tpc_code_nope', 'anything')
        expect(result.ok).toBe(false)
    })
})

describe('registerClient (trivial DCR responder)', () => {
    test('issues a public ("none" auth) client id and echoes declared redirect_uris', () => {
        const res = bridge.registerClient({ redirect_uris: ['http://localhost:3769/oauth/callback'], client_name: 'mcp-remote' })
        expect(res.client_id).toMatch(/^tpc_/)
        expect(res.token_endpoint_auth_method).toBe('none')
        expect(res.redirect_uris).toEqual(['http://localhost:3769/oauth/callback'])
        expect(res.grant_types).toContain('authorization_code')
    })

    test('tolerates a missing redirect_uris field', () => {
        expect(bridge.registerClient({}).redirect_uris).toEqual([])
        expect(bridge.registerClient().redirect_uris).toEqual([])
    })

    test('issues a distinct client id per call', () => {
        expect(bridge.registerClient({}).client_id).not.toBe(bridge.registerClient({}).client_id)
    })
})
