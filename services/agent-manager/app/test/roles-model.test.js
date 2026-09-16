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
 * Tests for the multi-role model (D66/Phase 3): rolesFor / hasRole / bootstrap seeding.
 * Pure - drives the in-memory settings cache directly (no store round-trip).
 */

const settings = require('../lib/settings')

afterEach(() => { settings._setCache({}); settings.setBootstrapAdmins([]) })

describe('rolesFor / hasRole (D66)', () => {
    test('an unlisted owner is a plain chef', () => {
        settings._setCache({ head_chefs: [], user_roles: {} })
        expect(settings.rolesFor('nobody@example.com')).toEqual(['chef'])
        expect(settings.hasRole('nobody@example.com', 'admin')).toBe(false)
        expect(settings.hasRole('nobody@example.com', 'head-chef')).toBe(false)
    })

    test('stored multi-role assignment is honored, chef always included, canonical order', () => {
        settings._setCache({ head_chefs: [], user_roles: { 'bharat@tap': ['admin', 'head-chef'] } })
        expect(settings.rolesFor('bharat@tap')).toEqual(['chef', 'head-chef', 'admin'])
        expect(settings.hasRole('bharat@tap', 'admin')).toBe(true)
        expect(settings.hasRole('bharat@tap', 'head-chef')).toBe(true)
    })

    test('invalid stored role names are ignored', () => {
        settings._setCache({ head_chefs: [], user_roles: { x: ['superuser', 'admin'] } })
        expect(settings.rolesFor('x')).toEqual(['chef', 'admin'])
    })

    test('bootstrap admins get admin + head-chef', () => {
        settings._setCache({ head_chefs: [], user_roles: {} })
        settings.setBootstrapAdmins(['boss@tap'])
        expect(settings.rolesFor('boss@tap')).toEqual(['chef', 'head-chef', 'admin'])
    })

    test('service-account is implicitly admin (operator credential) but NOT implicitly head-chef', () => {
        settings._setCache({ head_chefs: [], user_roles: {} }) // roster does NOT include service-account
        expect(settings.rolesFor('service-account')).toEqual(['chef', 'admin'])
        expect(settings.hasRole('service-account', 'admin')).toBe(true)
        expect(settings.hasRole('service-account', 'head-chef')).toBe(false)
    })

    test('legacy head_chefs roster still grants head-chef (D64 back-compat)', () => {
        settings._setCache({ head_chefs: ['chef1@tap'], user_roles: {} })
        expect(settings.hasRole('chef1@tap', 'head-chef')).toBe(true)
        expect(settings.rolesFor('chef1@tap')).toEqual(['chef', 'head-chef'])
    })

    test('isHeadChef delegates to hasRole', () => {
        settings._setCache({ head_chefs: ['h@tap'], user_roles: {} })
        expect(settings.isHeadChef('h@tap')).toBe(true)
        expect(settings.isHeadChef('other@tap')).toBe(false)
    })
})

describe('parseBootstrapAdmins (D66)', () => {
    test('comma-separated list', () => {
        expect(settings.parseBootstrapAdmins('a@x, b@y ,c@z')).toEqual(['a@x', 'b@y', 'c@z'])
    })
    test('JSON array', () => {
        expect(settings.parseBootstrapAdmins('["a@x","b@y"]')).toEqual(['a@x', 'b@y'])
    })
    test('blank/garbage -> empty', () => {
        expect(settings.parseBootstrapAdmins('')).toEqual([])
        expect(settings.parseBootstrapAdmins(undefined)).toEqual([])
        expect(settings.parseBootstrapAdmins('[bad json')).toEqual([])
    })
})
