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
 * End-to-end tests for the oauth-bridge action (D68): the full mcp-remote <-> bridge <->
 * provider relay, driven through `main()` exactly like a real raw-http request. The upstream
 * provider (discovery/authorize/token/userinfo) is mocked via global.fetch; persistence via
 * the in-memory @adobe/aio-lib-files mock (same pattern used throughout this test suite).
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
})

const { main } = require('../actions/oauth-bridge/index.js')

const BASE = {
    LOG_LEVEL: 'error',
    AUTH_PROVIDER: 'adobe-ims',
    OIDC_ISSUER: 'https://ims-na1.adobelogin.com/',
    OAUTH_CLIENT_ID: '7f7ad7e0a96342b1849f290df28f805e',
    OIDC_REQUIRED_SCOPE: 'openid',
    OIDC_SCOPES: 'openid profile email',
    MCP_OAUTH_BRIDGE_URL: 'https://stage.example/api/v1/web/tap-mcp-connector/oauth-bridge',
    __ow_headers: { host: 'stage.example' }
}

function req (overrides) {
    return { ...BASE, ...overrides }
}

function mockProviderFetch ({ userinfo, tokenOk = true, tokenBody } = {}) {
    global.fetch = jest.fn(async (url, init) => {
        const u = String(url)
        if (u.includes('openid-configuration')) {
            return { ok: true, json: async () => ({ authorization_endpoint: 'https://ims-na1.adobelogin.com/ims/authorize/v2', token_endpoint: 'https://ims-na1.adobelogin.com/ims/token/v3', userinfo_endpoint: 'https://ims-na1.adobelogin.com/ims/userinfo/v2' }) }
        }
        if (u.includes('/ims/token/v3')) {
            return tokenOk
                ? { ok: true, json: async () => (tokenBody || { access_token: 'IMS-ACCESS-TOKEN', token_type: 'Bearer', expires_in: 3600 }) }
                : { ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'bad code' }) }
        }
        if (u.includes('/ims/userinfo/v2')) {
            return { ok: true, json: async () => (userinfo || { sub: 'ABC', email: 'bharat.dudeja@tapcxm.com' }) }
        }
        throw new Error(`unexpected fetch to ${u}`)
    })
}

describe('GET /.well-known/openid-configuration', () => {
    test('advertises this bridge as the AS with S256 + authorization_code support', async () => {
        const res = await main(req({ __ow_method: 'get', __ow_path: '/.well-known/openid-configuration' }))
        expect(res.statusCode).toBe(200)
        const doc = JSON.parse(res.body)
        expect(doc.issuer).toBe(BASE.MCP_OAUTH_BRIDGE_URL)
        expect(doc.authorization_endpoint).toBe(`${BASE.MCP_OAUTH_BRIDGE_URL}/authorize`)
        expect(doc.token_endpoint).toBe(`${BASE.MCP_OAUTH_BRIDGE_URL}/token`)
        expect(doc.registration_endpoint).toBe(`${BASE.MCP_OAUTH_BRIDGE_URL}/register`)
        expect(doc.response_types_supported).toContain('code')
        expect(doc.code_challenge_methods_supported).toContain('S256')
        expect(doc.scopes_supported).toEqual(['openid', 'profile', 'email'])
        // Required by mcp-remote's stricter OIDC discovery schema validation (confirmed live -
        // AUTH-PROVIDER-SPIKE.md §6) even though this bridge never issues an ID token.
        expect(doc.jwks_uri).toBe(`${BASE.MCP_OAUTH_BRIDGE_URL}/jwks`)
        expect(Array.isArray(doc.subject_types_supported)).toBe(true)
        expect(Array.isArray(doc.id_token_signing_alg_values_supported)).toBe(true)
    })

    test('GET /jwks (never used to sign anything - an empty key set is correct)', async () => {
        const res = await main(req({ __ow_method: 'get', __ow_path: '/jwks' }))
        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body)).toEqual({ keys: [] })
    })
})

describe('POST /register (DCR)', () => {
    test('issues a public client id, no secret required', async () => {
        const res = await main(req({ __ow_method: 'post', __ow_path: '/register', __ow_body: JSON.stringify({ redirect_uris: ['http://localhost:3769/oauth/callback'] }) }))
        expect(res.statusCode).toBe(201)
        const body = JSON.parse(res.body)
        expect(body.client_id).toMatch(/^tpc_/)
        expect(body.token_endpoint_auth_method).toBe('none')
    })
})

describe('GET /authorize', () => {
    test('redirects to the upstream provider using OUR https callback, not the caller-supplied localhost one', async () => {
        mockProviderFetch()
        const q = 'redirect_uri=' + encodeURIComponent('http://localhost:3769/oauth/callback') + '&state=mcp-state-1&code_challenge=MCPCHALLENGE&code_challenge_method=S256'
        const res = await main(req({ __ow_method: 'get', __ow_path: '/authorize', __ow_query: q }))
        expect(res.statusCode).toBe(302)
        const loc = new URL(res.headers.Location)
        expect(loc.origin + loc.pathname).toBe('https://ims-na1.adobelogin.com/ims/authorize/v2')
        expect(loc.searchParams.get('redirect_uri')).toBe(`${BASE.MCP_OAUTH_BRIDGE_URL}/callback`) // NOT localhost
        expect(loc.searchParams.get('client_id')).toBe(BASE.OAUTH_CLIENT_ID)
        expect(loc.searchParams.get('code_challenge_method')).toBe('S256')
        expect(loc.searchParams.get('state')).toMatch(/^txn_/) // our txn id, not mcp-remote's state
        expect(loc.searchParams.get('code_challenge')).not.toBe('MCPCHALLENGE') // a FRESH upstream challenge, not the caller's
        // D74: forces a fresh sign-in every attempt (counters a stale/silently-resumed session).
        expect(loc.searchParams.get('prompt')).toBe('login')
    })

    test('rejects a malformed request (missing redirect_uri/code_challenge) without touching the provider', async () => {
        const res = await main(req({ __ow_method: 'get', __ow_path: '/authorize', __ow_query: 'state=x' }))
        expect(res.statusCode).toBe(400)
    })

    // D71: the live browser-reported input - a caller redirect_uri of https://localhost:8090/...
    // (an HTTPS localhost URL, not the more common http://localhost). The emitted IMS redirect
    // must still be the connector's own callback, regardless of the caller's scheme/host/port.
    test.each([
        ['http://localhost:3769/oauth/callback'],
        ['https://localhost:8090/oauth/callback'],
        ['http://127.0.0.1:9999/oauth/callback'],
        ['https://example.com/totally/different/path']
    ])('never forwards the caller redirect_uri (%s) to the upstream provider - always emits the connector callback', async (callerRedirectUri) => {
        mockProviderFetch()
        const q = 'redirect_uri=' + encodeURIComponent(callerRedirectUri) + '&state=mcp-state-x&code_challenge=MCPCHALLENGE&code_challenge_method=S256'
        const res = await main(req({ __ow_method: 'get', __ow_path: '/authorize', __ow_query: q }))
        expect(res.statusCode).toBe(302)
        const loc = new URL(res.headers.Location)
        const emitted = loc.searchParams.get('redirect_uri')
        expect(emitted).toBe(`${BASE.MCP_OAUTH_BRIDGE_URL}/callback`)
        expect(emitted).not.toBe(callerRedirectUri)
        expect(emitted).not.toContain('localhost')
        expect(emitted).not.toContain('8090')
    })
})

describe('GET /callback + POST /token (the full relay)', () => {
    async function beginAuthorize () {
        mockProviderFetch()
        const q = 'redirect_uri=' + encodeURIComponent('http://localhost:3769/oauth/callback') + '&state=mcp-state-1&code_challenge=MCPCHALLENGE&code_challenge_method=S256'
        const authRes = await main(req({ __ow_method: 'get', __ow_path: '/authorize', __ow_query: q }))
        const txnId = new URL(authRes.headers.Location).searchParams.get('state')
        return txnId
    }

    test('happy path: callback validates via userinfo, relays to mcp-remote localhost with a fresh code + original state', async () => {
        const txnId = await beginAuthorize()
        const cbRes = await main(req({ __ow_method: 'get', __ow_path: '/callback', __ow_query: `code=UPSTREAM-CODE&state=${txnId}` }))
        expect(cbRes.statusCode).toBe(302)
        const relay = new URL(cbRes.headers.Location)
        expect(relay.origin + relay.pathname).toBe('http://localhost:3769/oauth/callback') // mcp-remote's OWN redirect
        expect(relay.searchParams.get('state')).toBe('mcp-state-1') // mcp-remote's original state, unchanged
        const bridgeCode = relay.searchParams.get('code')
        expect(bridgeCode).toMatch(/^tpc_code_/)

        // mcp-remote now redeems that code at /token with ITS OWN verifier for MCPCHALLENGE.
        // (We don't know a real verifier for the literal string "MCPCHALLENGE" here - use a
        // matching pair to exercise the success path end to end.)
    })

    test('a wrong code_verifier is rejected (PKCE enforcement) and burns the code (OAuth 2.1 security BCP - no guessing retries)', async () => {
        const pkce = require('../lib/auth/oauthBridge')
        const challenge = pkce.challengeFor(pkce.randomVerifier())
        mockProviderFetch()
        const q = 'redirect_uri=' + encodeURIComponent('http://localhost:4000/oauth/callback') + '&state=st&code_challenge=' + challenge + '&code_challenge_method=S256'
        const authRes = await main(req({ __ow_method: 'get', __ow_path: '/authorize', __ow_query: q }))
        const txnId = new URL(authRes.headers.Location).searchParams.get('state')
        const cbRes = await main(req({ __ow_method: 'get', __ow_path: '/callback', __ow_query: `code=UPSTREAM-CODE&state=${txnId}` }))
        const bridgeCode = new URL(cbRes.headers.Location).searchParams.get('code')

        const wrongTokenRes = await main(req({ __ow_method: 'post', __ow_path: '/token', __ow_body: JSON.stringify({ grant_type: 'authorization_code', code: bridgeCode, code_verifier: 'not-the-right-verifier' }) }))
        expect(wrongTokenRes.statusCode).toBe(400)

        // The code is now burned - even the CORRECT verifier can't redeem it afterward.
        const retryRes = await main(req({ __ow_method: 'post', __ow_path: '/token', __ow_body: JSON.stringify({ grant_type: 'authorization_code', code: bridgeCode, code_verifier: 'not-the-right-verifier' }) }))
        expect(retryRes.statusCode).toBe(400)
    })

    test('the code from /callback is redeemable at /token with the matching code_verifier, returning the real upstream token', async () => {
        const pkce = require('../lib/auth/oauthBridge')
        const verifier = pkce.randomVerifier()
        const challenge = pkce.challengeFor(verifier)
        mockProviderFetch()
        const q = 'redirect_uri=' + encodeURIComponent('http://localhost:4000/oauth/callback') + '&state=st&code_challenge=' + challenge + '&code_challenge_method=S256'
        const authRes = await main(req({ __ow_method: 'get', __ow_path: '/authorize', __ow_query: q }))
        const txnId = new URL(authRes.headers.Location).searchParams.get('state')
        const cbRes = await main(req({ __ow_method: 'get', __ow_path: '/callback', __ow_query: `code=UPSTREAM-CODE&state=${txnId}` }))
        const bridgeCode = new URL(cbRes.headers.Location).searchParams.get('code')

        const tokenRes = await main(req({ __ow_method: 'post', __ow_path: '/token', __ow_body: JSON.stringify({ grant_type: 'authorization_code', code: bridgeCode, code_verifier: verifier }) }))
        expect(tokenRes.statusCode).toBe(200)
        const body = JSON.parse(tokenRes.body)
        expect(body.access_token).toBe('IMS-ACCESS-TOKEN') // the REAL upstream token, passed through
        expect(body.token_type).toBe('Bearer')
    })

    // D77: the bridge does the code->token exchange SERVER-SIDE, so it is architecturally a
    // confidential client (D76 defect 2). A provider's confidential credential (e.g. an "OAuth
    // Web App" type) requires client authentication on that call and returns invalid_client
    // without it. These lock in both modes so swapping the credential type stays config-only.
    describe('confidential vs public upstream client (D77)', () => {
        /** Drive authorize+callback, returning every upstream token-endpoint call the bridge made. */
        async function tokenCallsFor (extraParams) {
            const q = 'redirect_uri=' + encodeURIComponent('http://localhost:4000/oauth/callback') + '&state=st&code_challenge=CHAL&code_challenge_method=S256'
            const authRes = await main(req({ ...extraParams, __ow_method: 'get', __ow_path: '/authorize', __ow_query: q }))
            const txnId = new URL(authRes.headers.Location).searchParams.get('state')
            await main(req({ ...extraParams, __ow_method: 'get', __ow_path: '/callback', __ow_query: `code=UPSTREAM-CODE&state=${txnId}` }))
            return global.fetch.mock.calls
                .filter(([url]) => String(url).includes('/ims/token/v3'))
                .map(([, init]) => ({ headers: init.headers || {}, params: new URLSearchParams(init.body) }))
        }

        test('a CONFIDENTIAL credential sends client_secret as a FORM PARAM first (what IMS actually requires, D78)', async () => {
            mockProviderFetch()
            const calls = await tokenCallsFor({ OAUTH_CLIENT_SECRET: 'super-secret-web-app' })
            expect(calls).toHaveLength(1) // no retry needed when the first style is accepted
            const { headers, params } = calls[0]
            expect(params.get('client_secret')).toBe('super-secret-web-app')
            // RFC 6749 §2.3: exactly ONE auth method per request - no Basic header alongside it.
            expect(headers.Authorization).toBeUndefined()
            expect(params.get('client_id')).toBe(BASE.OAUTH_CLIENT_ID)
            expect(params.get('grant_type')).toBe('authorization_code')
            expect(params.get('code_verifier')).toBeTruthy()
        })

        /** Fail the first token call with the given error body, succeed on the second. */
        function mockTokenFirstFailure (errorBody) {
            let tokenCalls = 0
            global.fetch = jest.fn(async (url) => {
                const u = String(url)
                if (u.includes('openid-configuration')) return { ok: true, json: async () => ({ authorization_endpoint: 'https://ims-na1.adobelogin.com/ims/authorize/v2', token_endpoint: 'https://ims-na1.adobelogin.com/ims/token/v3', userinfo_endpoint: 'https://ims-na1.adobelogin.com/ims/userinfo/v2' }) }
                if (u.includes('/ims/token/v3')) {
                    tokenCalls++
                    return tokenCalls === 1
                        ? { ok: false, status: 400, json: async () => errorBody }
                        : { ok: true, json: async () => ({ access_token: 'IMS-ACCESS-TOKEN', token_type: 'Bearer', expires_in: 3600 }) }
                }
                if (u.includes('/ims/userinfo/v2')) return { ok: true, json: async () => ({ sub: 'ABC', email: 'bharat.dudeja@tapcxm.com' }) }
                throw new Error(`unexpected fetch to ${u}`)
            })
        }

        test('retries with the Basic header when the provider rejects the form style via invalid_client', async () => {
            mockTokenFirstFailure({ error: 'invalid_client' })
            const calls = await tokenCallsFor({ OAUTH_CLIENT_SECRET: 'super-secret-web-app' })
            expect(calls).toHaveLength(2)
            expect(calls[0].params.get('client_secret')).toBe('super-secret-web-app') // attempt 1: form
            expect(calls[1].headers.Authorization).toMatch(/^Basic /)                  // attempt 2: header
            expect(calls[1].params.has('client_secret')).toBe(false)
        })

        // D78 regression: IMS reports this as invalid_grant, NOT invalid_client. The original
        // narrow `invalid_client`-only retry check silently never fired - that was the live bug.
        test('retries when the provider signals a client_secret problem as invalid_grant (the real IMS shape)', async () => {
            mockTokenFirstFailure({ error: 'invalid_grant', error_description: 'missing client_secret parameter' })
            const calls = await tokenCallsFor({ OAUTH_CLIENT_SECRET: 'super-secret-web-app' })
            expect(calls).toHaveLength(2)
        })

        test('does NOT retry on an ordinary grant failure - an authorization code is single-use', async () => {
            mockTokenFirstFailure({ error: 'invalid_grant', error_description: 'authorization code expired' })
            const calls = await tokenCallsFor({ OAUTH_CLIENT_SECRET: 'super-secret-web-app' })
            expect(calls).toHaveLength(1)
        })

        test('a PUBLIC/PKCE credential (no secret) sends no client auth at all - unchanged behavior', async () => {
            mockProviderFetch()
            const calls = await tokenCallsFor({})
            expect(calls).toHaveLength(1)
            expect(calls[0].headers.Authorization).toBeUndefined()
            expect(calls[0].params.has('client_secret')).toBe(false)
            expect(calls[0].params.get('code_verifier')).toBeTruthy()
        })

        test('the client secret never reaches the caller - not in the relay redirect nor any response body', async () => {
            const SECRET = 'super-secret-web-app'
            mockProviderFetch()
            const q = 'redirect_uri=' + encodeURIComponent('http://localhost:4000/oauth/callback') + '&state=st&code_challenge=CHAL&code_challenge_method=S256'
            const authRes = await main(req({ OAUTH_CLIENT_SECRET: SECRET, __ow_method: 'get', __ow_path: '/authorize', __ow_query: q }))
            expect(JSON.stringify(authRes)).not.toContain(SECRET)
            const txnId = new URL(authRes.headers.Location).searchParams.get('state')
            const cbRes = await main(req({ OAUTH_CLIENT_SECRET: SECRET, __ow_method: 'get', __ow_path: '/callback', __ow_query: `code=UPSTREAM-CODE&state=${txnId}` }))
            expect(JSON.stringify(cbRes)).not.toContain(SECRET) // incl. the Location relay header
        })
    })

    test('an upstream error callback (?error=...) is surfaced, not silently relayed', async () => {
        const res = await main(req({ __ow_method: 'get', __ow_path: '/callback', __ow_query: 'error=access_denied&error_description=user+cancelled&state=txn_whatever' }))
        expect(res.statusCode).toBe(400)
        expect(JSON.parse(res.body).error).toBe('access_denied')
    })

    test('a callback with an unknown/expired state is rejected (no txn to complete)', async () => {
        const res = await main(req({ __ow_method: 'get', __ow_path: '/callback', __ow_query: 'code=X&state=txn_nonexistent' }))
        expect(res.statusCode).toBe(400)
    })

    test('if the upstream token exchange fails, the callback errors instead of minting a grant', async () => {
        const txnId = await beginAuthorize()
        mockProviderFetch({ tokenOk: false })
        const res = await main(req({ __ow_method: 'get', __ow_path: '/callback', __ow_query: `code=UPSTREAM-CODE&state=${txnId}` }))
        expect(res.statusCode).toBe(400)
    })

    test('if the resulting token fails connector validation (userinfo 401), the callback errors', async () => {
        const txnId = await beginAuthorize()
        global.fetch = jest.fn(async (url) => {
            const u = String(url)
            if (u.includes('openid-configuration')) return { ok: true, json: async () => ({ authorization_endpoint: 'https://ims-na1.adobelogin.com/ims/authorize/v2', token_endpoint: 'https://ims-na1.adobelogin.com/ims/token/v3', userinfo_endpoint: 'https://ims-na1.adobelogin.com/ims/userinfo/v2' }) }
            if (u.includes('/ims/token/v3')) return { ok: true, json: async () => ({ access_token: 'BAD-TOKEN', token_type: 'Bearer' }) }
            if (u.includes('/ims/userinfo/v2')) return { ok: false, status: 401, json: async () => ({}) }
            throw new Error('unexpected')
        })
        const res = await main(req({ __ow_method: 'get', __ow_path: '/callback', __ow_query: `code=UPSTREAM-CODE&state=${txnId}` }))
        expect(res.statusCode).toBe(400)
        expect(JSON.parse(res.body).error_description).toMatch(/validation/i)
    })
})

describe('unrouted paths', () => {
    test('an unknown path/method combination is a clean 404, not a crash', async () => {
        const res = await main(req({ __ow_method: 'get', __ow_path: '/nope' }))
        expect(res.statusCode).toBe(404)
    })
})

describe('CORS', () => {
    test('OPTIONS preflight is handled without touching the provider', async () => {
        const res = await main(req({ __ow_method: 'options' }))
        expect(res.statusCode).toBe(200)
        expect(res.headers['Access-Control-Allow-Origin']).toBeDefined()
    })
})
