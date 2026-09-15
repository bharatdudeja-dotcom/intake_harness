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
 * lib/auth/urls takes a plain `{ host, packageName }` request shape (D34
 * portability tidy-up) - the host wrapper extracts these from its transport;
 * no platform request format reaches this module.
 */

const { resolveResourceUrl, resolvePrmUrl } = require('../lib/auth/urls')

describe('lib/auth/urls', () => {
    test('derives both URLs from the plain host value when no override is configured', () => {
        const request = { host: '110557-tapmcpconnector-stage.adobeioruntime.net' }
        const config = { resourceUrl: '', prmUrl: '' }

        expect(resolveResourceUrl(request, config)).toBe(
            'https://110557-tapmcpconnector-stage.adobeioruntime.net/api/v1/web/tap-mcp-connector/mcp-server'
        )
        expect(resolvePrmUrl(request, config)).toBe(
            'https://110557-tapmcpconnector-stage.adobeioruntime.net/api/v1/web/tap-mcp-connector/well-known'
        )
    })

    test('respects an explicit packageName override', () => {
        const request = { host: 'ns.example-host.net', packageName: 'custom-pkg' }
        const config = { resourceUrl: '', prmUrl: '' }

        expect(resolveResourceUrl(request, config)).toBe('https://ns.example-host.net/api/v1/web/custom-pkg/mcp-server')
    })

    test('explicit URL overrides win over derivation (needed to re-host elsewhere)', () => {
        const request = {}
        const config = { resourceUrl: 'https://custom.example.com/mcp', prmUrl: 'https://custom.example.com/prm' }

        expect(resolveResourceUrl(request, config)).toBe('https://custom.example.com/mcp')
        expect(resolvePrmUrl(request, config)).toBe('https://custom.example.com/prm')
    })

    test('returns an empty string when there is no host and no override', () => {
        const request = {}
        const config = { resourceUrl: '', prmUrl: '' }

        expect(resolveResourceUrl(request, config)).toBe('')
        expect(resolvePrmUrl(request, config)).toBe('')
    })
})
