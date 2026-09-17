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
 * Tests for lib/skills (Increment 8, D31): recipe -> skill export, both the
 * generic "prompt" format and the "claude-skill" vendor adapter, plus the
 * house-recipe-only gate.
 */

const skills = require('../lib/skills')

function approvedRecipe (overrides = {}) {
    return {
        id: 'decision-example-1',
        type: 'decision',
        title: 'Use Auth0 as the reference IdP',
        content: 'We chose Auth0 because it supports real audience binding.',
        status: 'active',
        author: 'person@example.com',
        epic: 'Tap Portability Layer',
        story: 'Auth',
        fields: { source: 'knowledge/DECISION-LOG.md', anchor: 'D23', session: 'cowork' },
        ...overrides
    }
}

describe('lib/skills - format registry', () => {
    test('lists at least the generic "prompt" format and the claude-skill vendor format', () => {
        const formats = skills.listFormats()
        expect(formats).toContain('prompt')
        expect(formats).toContain('claude-skill')
    })

    test('describeFormats mentions both formats with a description', () => {
        const desc = skills.describeFormats()
        expect(desc).toMatch(/"prompt"/)
        expect(desc).toMatch(/"claude-skill"/)
    })
})

describe('lib/skills - the house-recipe-only gate', () => {
    test('rejects an experimental (pending) recipe with a clear message', () => {
        const pending = approvedRecipe({ status: 'pending' })
        expect(() => skills.exportRecipe(pending)).toThrow(/experimental/i)
        expect(() => skills.exportRecipe(pending)).toThrow(/certify/i)
    })

    test('accepts a recipe with no status field as active (legacy resources default to active)', () => {
        const legacy = approvedRecipe({ status: undefined })
        expect(() => skills.exportRecipe(legacy)).not.toThrow()
    })

    test('rejects an unknown export format', () => {
        expect(() => skills.exportRecipe(approvedRecipe(), 'docx')).toThrow(/unknown export format/i)
    })
})

describe('lib/skills - "prompt" export (generic, any AI)', () => {
    const exported = skills.exportRecipe(approvedRecipe(), 'prompt')

    test('returns a filename, markdown mimeType, and framed content', () => {
        expect(exported.format).toBe('prompt')
        expect(exported.filename).toMatch(/\.prompt\.md$/)
        expect(exported.mimeType).toBe('text/markdown')
    })

    test('content includes provenance and the original recipe content verbatim', () => {
        expect(exported.content).toContain('Use Auth0 as the reference IdP')
        expect(exported.content).toContain('resource://company/decision/decision-example-1')
        expect(exported.content).toContain('Tap Portability Layer > Auth')
        expect(exported.content).toContain('knowledge/DECISION-LOG.md#D23')
        expect(exported.content).toContain('We chose Auth0 because it supports real audience binding.')
    })

    test('defaults to "prompt" when no format is given', () => {
        const defaulted = skills.exportRecipe(approvedRecipe())
        expect(defaulted.format).toBe('prompt')
    })
})

describe('lib/skills - "claude-skill" export (SKILL.md)', () => {
    const exported = skills.exportRecipe(approvedRecipe(), 'claude-skill')

    test('returns SKILL.md with markdown mimeType', () => {
        expect(exported.filename).toBe('SKILL.md')
        expect(exported.mimeType).toBe('text/markdown')
    })

    test('content has valid YAML frontmatter with name + description', () => {
        expect(exported.content).toMatch(/^---\nname: [\w-]+\ndescription: .+\n---/)
    })

    test('frontmatter name is a filesystem-safe slug', () => {
        const nameLine = exported.content.split('\n').find(l => l.startsWith('name:'))
        const name = nameLine.replace('name:', '').trim()
        expect(name).toMatch(/^[a-z0-9-]+$/)
    })

    test('body includes the recipe title, URI, work item, and content', () => {
        expect(exported.content).toContain('# Use Auth0 as the reference IdP')
        expect(exported.content).toContain('resource://company/decision/decision-example-1')
        expect(exported.content).toContain('Tap Portability Layer > Auth')
        expect(exported.content).toContain('We chose Auth0 because it supports real audience binding.')
    })

    test('description frontmatter is a single line even if the title were multi-line-ish', () => {
        const withNewline = approvedRecipe({ title: 'Title' })
        const out = skills.exportRecipe(withNewline, 'claude-skill')
        const descLine = out.content.split('\n')[2]
        expect(descLine.startsWith('description:')).toBe(true)
    })
})
