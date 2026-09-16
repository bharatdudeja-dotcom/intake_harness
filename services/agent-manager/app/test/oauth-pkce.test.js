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
 * Unit tests for the dashboard's PKCE OAuth helpers (D65) - the pure, deterministic pieces
 * of the per-user IMS login flow. The browser-only crypto (verifier/challenge) is not tested
 * here (no Web Crypto in jsdom-less node); the URL/body/expiry logic is.
 */

const pkce = require('../web-src/oauth-pkce.js')

describe('base64UrlEncode', () => {
    test('is URL-safe and unpadded', () => {
        const out = pkce.base64UrlEncode(new Uint8Array([251, 255, 191, 0]))
        expect(out).not.toMatch(/[+/=]/)
        expect(out).toBe('-_-_AA')
    })
})

describe('buildAuthorizeUrl', () => {
    test('builds an Authorization Code + PKCE (S256) request with all required params', () => {
        const url = pkce.buildAuthorizeUrl('https://ims-na1.adobelogin.com/ims/authorize/v2', {
            clientId: 'abc', redirectUri: 'https://app.example/index.html', scope: 'openid email', state: 'xyz', codeChallenge: 'chal'
        })
        const u = new URL(url)
        expect(u.origin + u.pathname).toBe('https://ims-na1.adobelogin.com/ims/authorize/v2')
        expect(u.searchParams.get('client_id')).toBe('abc')
        expect(u.searchParams.get('redirect_uri')).toBe('https://app.example/index.html')
        expect(u.searchParams.get('response_type')).toBe('code')
        expect(u.searchParams.get('scope')).toBe('openid email')
        expect(u.searchParams.get('state')).toBe('xyz')
        expect(u.searchParams.get('code_challenge')).toBe('chal')
        expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    })
})

describe('parseCallbackParams', () => {
    test('extracts code + state from a success callback', () => {
        expect(pkce.parseCallbackParams('?code=AUTHCODE&state=ST')).toEqual({ code: 'AUTHCODE', state: 'ST' })
    })
    test('extracts error + description from an error callback', () => {
        const out = pkce.parseCallbackParams('?error=access_denied&error_description=nope')
        expect(out.error).toBe('access_denied')
        expect(out.errorDescription).toBe('nope')
    })
    test('empty/absent search yields an empty object', () => {
        expect(pkce.parseCallbackParams('')).toEqual({})
        expect(pkce.parseCallbackParams(undefined)).toEqual({})
    })
})

describe('buildTokenRequestBody', () => {
    test('is a public-client authorization_code exchange with code_verifier and NO secret', () => {
        const body = pkce.buildTokenRequestBody({ clientId: 'abc', code: 'C', redirectUri: 'https://app/x', codeVerifier: 'V' })
        const p = new URLSearchParams(body)
        expect(p.get('grant_type')).toBe('authorization_code')
        expect(p.get('client_id')).toBe('abc')
        expect(p.get('code')).toBe('C')
        expect(p.get('redirect_uri')).toBe('https://app/x')
        expect(p.get('code_verifier')).toBe('V')
        expect(body).not.toMatch(/client_secret/)
    })
})

describe('computeExpiresAt / isExpired', () => {
    test('subtracts a safety skew from the raw expires_in', () => {
        expect(pkce.computeExpiresAt(3600, 1_000_000, 60000)).toBe(1_000_000 + 3600_000 - 60000)
    })
    test('a non-positive or bad expires_in is treated as already stale', () => {
        expect(pkce.computeExpiresAt(0, 1000)).toBe(1000)
        expect(pkce.computeExpiresAt('nope', 1000)).toBe(1000)
    })
    test('isExpired is true at/after expiry and when unset', () => {
        expect(pkce.isExpired(0, 5)).toBe(true)
        expect(pkce.isExpired(undefined, 5)).toBe(true)
        expect(pkce.isExpired(10, 10)).toBe(true)
        expect(pkce.isExpired(10, 9)).toBe(false)
    })
})
