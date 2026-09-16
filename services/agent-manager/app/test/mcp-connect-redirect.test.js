/**
 * Where the OAuth provider sends the person back to.
 *
 * This broke a real sign-in. The redirect URI was derived from
 * MCP_RESOURCE_URL, which inside a container is the CONTAINER's own address -
 * http://127.0.0.1:8080/mcp. So Adobe sent the browser to port 8080, nothing on
 * the user's machine was listening there, and an authorization that had
 * completely succeeded ended on "not found" with the token never collected.
 *
 * The rule: use the address the BROWSER actually used, because that is the only
 * address the browser can be sent back to. An explicit setting still wins, for
 * proxies and custom domains.
 *
 * It also has to be byte-identical at registration, /authorize and /token -
 * providers compare it literally - which is why it is derived in exactly one
 * place and stored on the transaction.
 */

const { _redirectUri: redirectUri } = require('../actions/mcp-connect/index.js')

describe('the OAuth redirect URI', () => {
    test('uses the host the browser asked for, not the container port', () => {
        expect(redirectUri({
            __ow_headers: { host: '127.0.0.1:3000' },
            MCP_RESOURCE_URL: 'http://127.0.0.1:8080/mcp'
        })).toBe('http://127.0.0.1:3000/mcp-connect/callback')
    })

    test('localhost and 127.0.0.1 both stay http - https would fail to connect', () => {
        expect(redirectUri({ __ow_headers: { host: 'localhost:3000' } }))
            .toBe('http://localhost:3000/mcp-connect/callback')
        expect(redirectUri({ __ow_headers: { host: '127.0.0.1:9999' } }))
            .toBe('http://127.0.0.1:9999/mcp-connect/callback')
    })

    test('a real hostname gets https, because a provider will refuse plain http', () => {
        expect(redirectUri({ __ow_headers: { host: 'agents.tapcxm.com' } }))
            .toBe('https://agents.tapcxm.com/mcp-connect/callback')
    })

    test('honours a proxy: x-forwarded-host and -proto win over host', () => {
        expect(redirectUri({
            __ow_headers: {
                host: 'internal:8080',
                'x-forwarded-host': 'agents.tapcxm.com',
                'x-forwarded-proto': 'https'
            }
        })).toBe('https://agents.tapcxm.com/mcp-connect/callback')
    })

    test('an explicit setting beats everything, for the cases we cannot infer', () => {
        expect(redirectUri({
            MCP_CONNECT_REDIRECT_URI: 'https://fixed.example/cb',
            __ow_headers: { host: '127.0.0.1:3000' }
        })).toBe('https://fixed.example/cb')
    })

    test('with no Host at all it falls back rather than throwing', () => {
        // A callback URL that is merely wrong can be diagnosed. A crash during
        // sign-in cannot.
        expect(redirectUri({ MCP_RESOURCE_URL: 'http://example.test:8080/mcp' }))
            .toBe('http://example.test:8080/mcp-connect/callback')
        expect(redirectUri({})).toContain('/mcp-connect/callback')
    })
})
