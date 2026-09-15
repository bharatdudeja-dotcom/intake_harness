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
 * Tests for the dashboard's markdown-embedded-diagram detection (D57/D58): a fenced
 * ```mermaid or ```svg block inside a doc/message body should render as a picture,
 * not a code block.
 */

const { pickDiagramKind, extractMermaidSource, isRawDiagramFormat, wrapSvgScope, mermaidThemeVariables, SVG_SANITIZE_CONFIG } = require('../web-src/markdown-mermaid.js')

describe('pickDiagramKind', () => {
    test('detects a fenced mermaid block', () => {
        expect(pickDiagramKind('mermaid', 'graph TD; A-->B')).toBe('mermaid')
    })

    test('is case-insensitive on the language tag', () => {
        expect(pickDiagramKind('Mermaid', 'graph TD; A-->B')).toBe('mermaid')
        expect(pickDiagramKind('MERMAID', 'graph TD; A-->B')).toBe('mermaid')
    })

    test('detects a fenced svg block whose content actually starts with <svg', () => {
        expect(pickDiagramKind('svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')).toBe('svg')
    })

    test('does not treat a svg-tagged block as a diagram if the content is not actually SVG markup', () => {
        expect(pickDiagramKind('svg', 'not really svg')).toBeNull()
    })

    test('falls back to null (plain code block) for any other language', () => {
        expect(pickDiagramKind('js', 'console.log(1)')).toBeNull()
        expect(pickDiagramKind('json', '{}')).toBeNull()
        expect(pickDiagramKind('', 'plain text')).toBeNull()
        expect(pickDiagramKind(undefined, 'plain text')).toBeNull()
    })

    test('falls back to null on empty/whitespace-only content even with a matching language', () => {
        expect(pickDiagramKind('mermaid', '   ')).toBeNull()
        expect(pickDiagramKind('mermaid', '')).toBeNull()
    })
})

/**
 * D60/D61: captured SVGs reference CSS vars (--surface-0/-1/-2, --text-primary/-secondary/
 * -muted/-accent, --border*, --font-*) that don't exist in the dashboard, so fills default to
 * black and text is invisible. These cover the scope wrapper and mermaid contrast fix.
 */
describe('wrapSvgScope', () => {
    test('wraps sanitized SVG markup in a .svg-scope container', () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="var(--surface-1)"/></svg>'
        expect(wrapSvgScope(svg)).toBe(`<div class="svg-scope">${svg}</div>`)
    })

    test('does not mutate or strip the wrapped markup', () => {
        const svg = '<svg><style>.a{fill:var(--text-primary)}</style><text class="a">hi</text></svg>'
        expect(wrapSvgScope(svg)).toContain(svg)
    })
})

describe('SVG_SANITIZE_CONFIG', () => {
    test('extends (not replaces) DOMPurify defaults to keep <style> tags/attrs', () => {
        expect(SVG_SANITIZE_CONFIG.ADD_TAGS).toEqual(expect.arrayContaining(['style']))
        expect(SVG_SANITIZE_CONFIG.ADD_ATTR).toEqual(expect.arrayContaining(['style']))
    })
})

describe('mermaidThemeVariables', () => {
    test('returns distinct, legible text/background pairs for light theme', () => {
        const v = mermaidThemeVariables('light')
        expect(v.primaryTextColor).not.toBe(v.primaryColor)
        expect(v.textColor).not.toBe(v.background)
    })

    test('returns distinct, legible text/background pairs for dark theme', () => {
        const v = mermaidThemeVariables('dark')
        expect(v.primaryTextColor).not.toBe(v.primaryColor)
        expect(v.textColor).not.toBe(v.background)
    })

    test('light and dark produce different palettes', () => {
        expect(mermaidThemeVariables('light')).not.toEqual(mermaidThemeVariables('dark'))
    })

    test('defaults to light palette for an unrecognized theme', () => {
        expect(mermaidThemeVariables('sepia')).toEqual(mermaidThemeVariables('light'))
    })
})

describe('extractMermaidSource (D63)', () => {
    test('strips leading prose paragraphs before the first diagram keyword', () => {
        const content = 'Canonical AEM to AEP data flow.\n\nFlow: A -> B -> C.\n\nflowchart TB\n    A --> B'
        expect(extractMermaidSource(content)).toBe('flowchart TB\n    A --> B')
    })

    test('returns diagram-only content unchanged (trimmed)', () => {
        expect(extractMermaidSource('graph TD\n  A-->B')).toBe('graph TD\n  A-->B')
    })

    test('recognizes a range of mermaid diagram types', () => {
        expect(extractMermaidSource('note\nsequenceDiagram\n  A->>B: hi')).toBe('sequenceDiagram\n  A->>B: hi')
        expect(extractMermaidSource('x\nstateDiagram-v2\n  [*] --> S')).toBe('stateDiagram-v2\n  [*] --> S')
        expect(extractMermaidSource('x\npie title Pets\n  "a": 1')).toBe('pie title Pets\n  "a": 1')
    })

    test('does not match a keyword that only appears mid-word or mid-line', () => {
        // "graphics" starts with "graph" but is not the token; no real diagram line -> unchanged
        const content = 'This paragraph mentions graphics and flowcharting in prose.'
        expect(extractMermaidSource(content)).toBe(content)
    })

    test('returns trimmed input when no diagram keyword is present', () => {
        expect(extractMermaidSource('  just prose, no diagram  ')).toBe('just prose, no diagram')
    })

    test('handles empty/nullish content', () => {
        expect(extractMermaidSource('')).toBe('')
        expect(extractMermaidSource(undefined)).toBe('')
    })

    test('normalizes CRLF line endings', () => {
        expect(extractMermaidSource('prose\r\n\r\nflowchart TB\r\n  A-->B')).toBe('flowchart TB\n  A-->B')
    })
})

describe('isRawDiagramFormat (D63)', () => {
    test('true for svg and mermaid (any case)', () => {
        expect(isRawDiagramFormat('svg')).toBe(true)
        expect(isRawDiagramFormat('mermaid')).toBe(true)
        expect(isRawDiagramFormat('SVG')).toBe(true)
        expect(isRawDiagramFormat('Mermaid')).toBe(true)
    })

    test('false for prose/other formats and nullish', () => {
        expect(isRawDiagramFormat('md')).toBe(false)
        expect(isRawDiagramFormat('json')).toBe(false)
        expect(isRawDiagramFormat('')).toBe(false)
        expect(isRawDiagramFormat(undefined)).toBe(false)
    })
})
