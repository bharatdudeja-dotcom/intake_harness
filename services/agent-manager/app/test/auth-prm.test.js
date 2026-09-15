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

const { buildProtectedResourceMetadata, buildWwwAuthenticateHeader } = require('../lib/auth/prm')

describe('lib/auth/prm', () => {
    test('builds a valid RFC 9728 Protected Resource Metadata document', () => {
        const doc = buildProtectedResourceMetadata({
            resourceUrl: 'https://ns.adobeioruntime.net/api/v1/web/tap-mcp-connector/mcp-server',
            issuer: 'https://ims-na1.adobelogin.com',
            requiredScope: 'openid'
        })

        expect(doc).toEqual({
            resource: 'https://ns.adobeioruntime.net/api/v1/web/tap-mcp-connector/mcp-server',
            authorization_servers: ['https://ims-na1.adobelogin.com'],
            scopes_supported: ['openid'],
            bearer_methods_supported: ['header']
        })
    })

    test('handles a missing issuer/scope gracefully (empty arrays, not crashes)', () => {
        const doc = buildProtectedResourceMetadata({ resourceUrl: 'https://x/mcp-server', issuer: '', requiredScope: '' })
        expect(doc.authorization_servers).toEqual([])
        expect(doc.scopes_supported).toEqual([])
    })

    test('WWW-Authenticate header has the exact RFC 9728 resource_metadata format', () => {
        const header = buildWwwAuthenticateHeader('https://x/api/v1/web/tap-mcp-connector/.well-known')
        expect(header).toBe('Bearer resource_metadata="https://x/api/v1/web/tap-mcp-connector/.well-known"')
    })
})
