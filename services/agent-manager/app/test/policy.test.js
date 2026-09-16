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

describe('lib/policy - loading the real config/resource-policy.json', () => {
    test('loads and validates without throwing', () => {
        const policy = require('../lib/policy')
        expect(() => policy.loadPolicy()).not.toThrow()
    })

    test('exposes the six seed types with normalized array formats', () => {
        const policy = require('../lib/policy')
        const types = policy.listTypeIds()
        expect(types).toEqual(expect.arrayContaining([
            'architecture-diagram', 'decision', 'playbook', 'configuration', 'meeting-notes', 'code-snippet'
        ]))
        for (const entry of policy.listResourceTypes()) {
            expect(Array.isArray(entry.format)).toBe(true)
        }
    })

    test('getResourceType returns null for an unknown type', () => {
        const policy = require('../lib/policy')
        expect(policy.getResourceType('no-such-type')).toBeNull()
    })

    test('cookbook kinds are human-gate (experimental-by-default, D38); handoff-prompt is exempt', () => {
        const policy = require('../lib/policy')
        expect(policy.getResourceType('architecture-diagram').approval).toBe('human-gate')
        expect(policy.getResourceType('decision').approval).toBe('human-gate')
        expect(policy.getResourceType('configuration').approval).toBe('human-gate')
        // handoff-prompt never enters the cookbook, so it is not approval-gated
        expect(policy.getResourceType('handoff-prompt').approval).toBe('none')
    })

    test('mimeTypeForFormat maps known formats and falls back for unknown ones', () => {
        const policy = require('../lib/policy')
        expect(policy.mimeTypeForFormat('md')).toBe('text/markdown')
        expect(policy.mimeTypeForFormat('svg')).toBe('image/svg+xml')
        expect(policy.mimeTypeForFormat('json')).toBe('application/json')
        expect(policy.mimeTypeForFormat('totally-unknown')).toBe('text/plain')
    })
})

describe('lib/policy - validation of a malformed policy (isolated module instance)', () => {
    function loadWithMockPolicy (mockPolicy) {
        let policy
        jest.isolateModules(() => {
            jest.doMock('../config/resource-policy.json', () => mockPolicy, { virtual: true })
            policy = require('../lib/policy')
        })
        return policy
    }

    test('throws when the policy is not an array', () => {
        const policy = loadWithMockPolicy({ not: 'an array' })
        expect(() => policy.loadPolicy()).toThrow(/must be a JSON array/)
    })

    test('throws when a type is missing required top-level fields', () => {
        const policy = loadWithMockPolicy([{ type: 'x' }])
        expect(() => policy.loadPolicy()).toThrow(/missing "title"/)
    })

    test('throws when format is invalid', () => {
        const policy = loadWithMockPolicy([{
            type: 'x', title: 'X', schema: { fields: ['title'], required: [] },
            format: 'not-a-real-format', storage: 'X/', approval: 'none'
        }])
        expect(() => policy.loadPolicy()).toThrow(/format.*must be one or more of/)
    })

    test('throws when approval is invalid', () => {
        const policy = loadWithMockPolicy([{
            type: 'x', title: 'X', schema: { fields: ['title'], required: [] },
            format: 'md', storage: 'X/', approval: 'sometimes'
        }])
        expect(() => policy.loadPolicy()).toThrow(/approval.*must be one of/)
    })

    test('throws on duplicate type ids', () => {
        const entry = { type: 'x', title: 'X', schema: { fields: ['title'], required: [] }, format: 'md', storage: 'X/', approval: 'none' }
        const policy = loadWithMockPolicy([entry, { ...entry }])
        expect(() => policy.loadPolicy()).toThrow(/duplicate type/)
    })

    test('accepts a single-string format and normalizes it to an array', () => {
        const policy = loadWithMockPolicy([{
            type: 'x', title: 'X', schema: { fields: ['title'], required: [] },
            format: 'md', storage: 'X/', approval: 'none'
        }])
        expect(policy.getResourceType('x').format).toEqual(['md'])
    })
})
