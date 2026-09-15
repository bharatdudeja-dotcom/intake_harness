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
 * lib/segmentation config loading + validation (D39). Uses the same
 * isolateModules + virtual doMock pattern as policy.test.js to inject a
 * malformed config without touching the real file.
 */

describe('lib/segmentation - the real config/segmentation.json', () => {
    test('loads the default Project -> Epic -> Story levels', () => {
        const seg = require('../lib/segmentation')
        expect(seg.levelKeys()).toEqual(['project', 'epic', 'story'])
        expect(seg.listLevels()[0]).toEqual({ key: 'project', label: 'Project' })
    })
})

describe('lib/segmentation - validation of a malformed config (isolated module)', () => {
    function loadWithMock (mockConfig) {
        let seg
        jest.isolateModules(() => {
            jest.doMock('../config/segmentation.json', () => mockConfig, { virtual: true })
            seg = require('../lib/segmentation')
        })
        return seg
    }

    test('throws when levels is empty', () => {
        const seg = loadWithMock({ levels: [] })
        expect(() => seg.getConfig()).toThrow(/non-empty array/)
    })

    test('throws when a level is missing key/label', () => {
        const seg = loadWithMock({ levels: [{ key: 'project', label: 'Project' }, { key: 'epic' }] })
        expect(() => seg.getConfig()).toThrow(/missing "label"/)
    })

    test('throws when the required "project" level is absent', () => {
        const seg = loadWithMock({ levels: [{ key: 'workstream', label: 'Workstream' }] })
        expect(() => seg.getConfig()).toThrow(/must include a level with key "project"/)
    })

    test('accepts a renamed project label and reduced level set', () => {
        const seg = loadWithMock({ levels: [{ key: 'project', label: 'Engagement' }] })
        expect(seg.levelKeys()).toEqual(['project'])
        expect(seg.listLevels()[0].label).toBe('Engagement')
    })
})
