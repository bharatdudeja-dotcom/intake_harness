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
 * Tests for the pure ingest logic (scripts/ingest-lib.cjs): decision-log
 * parsing, story mapping, deterministic ids, hashing, and the idempotent
 * create/update/skip plan.
 */

const {
    STORIES, parseDecisionLog, storyForDecision, storyForSource,
    stableId, contentHash, titleFromMarkdown, planFromManifest
} = require('../scripts/ingest-lib.cjs')

const SAMPLE_LOG = `# Decision Log

Some preamble.

## Decisions

### D1 — First decision here
- **Status:** done
- Body of one.

### D2 — Second decision, with — punctuation
Multi-line
body of two.

### D3 — Third decision
Body of three.

## Storage map — where resources live
| not | a | decision |

## Reusable facts captured this engagement
- fact one
`

describe('parseDecisionLog', () => {
    const decisions = parseDecisionLog(SAMPLE_LOG)

    test('finds one item per ### Dnn — heading, none for other sections', () => {
        expect(decisions).toHaveLength(3)
        expect(decisions.map(d => d.anchor)).toEqual(['D1', 'D2', 'D3'])
        expect(decisions.map(d => d.number)).toEqual([1, 2, 3])
    })

    test('titles carry the anchor and heading text', () => {
        expect(decisions[0].title).toBe('D1 — First decision here')
        expect(decisions[1].title).toBe('D2 — Second decision, with — punctuation')
    })

    test('content spans from its heading to the next decision', () => {
        expect(decisions[0].content).toContain('### D1')
        expect(decisions[0].content).toContain('Body of one.')
        expect(decisions[0].content).not.toContain('D2')
    })

    test('the last decision stops at the next ## section (no Storage map bleed)', () => {
        expect(decisions[2].content).toContain('Body of three.')
        expect(decisions[2].content).not.toContain('Storage map')
        expect(decisions[2].content).not.toContain('Reusable facts')
    })

    // Reads the UPSTREAM monorepo's knowledge/DECISION-LOG.md, which sits outside this
    // fork. Skipped when absent rather than deleted, so it still runs for anyone working
    // in the original repo layout - and so the gap is visible instead of silently dropped.
    const REAL_LOG = require('path').join(__dirname, '..', '..', '..', 'knowledge', 'DECISION-LOG.md')
    const hasRealLog = require('fs').existsSync(REAL_LOG)
    ;(hasRealLog ? test : test.skip)('parses the real DECISION-LOG.md: every decision found once, no duplicates', () => {
        const fs = require('fs')
        const real = fs.readFileSync(REAL_LOG, 'utf8')
        const parsed = parseDecisionLog(real)
        expect(parsed.length).toBeGreaterThanOrEqual(33)
        expect(parsed[0].anchor).toBe('D1')
        const anchors = parsed.map(d => d.anchor)
        expect(new Set(anchors).size).toBe(anchors.length) // unique - one recipe per decision
        expect(anchors).toContain('D28')
        expect(anchors).toContain('D33')
    })
})

describe('story mapping', () => {
    test('decisions map to engagement phases by number', () => {
        expect(storyForDecision(1)).toBe(STORIES.INVESTIGATION)
        expect(storyForDecision(17)).toBe(STORIES.INVESTIGATION)
        expect(storyForDecision(18)).toBe(STORIES.CONNECTOR)
        expect(storyForDecision(19)).toBe(STORIES.AUTH)
        expect(storyForDecision(25)).toBe(STORIES.AUTH)
        expect(storyForDecision(26)).toBe(STORIES.CONTROL_PLANE)
        expect(storyForDecision(28)).toBe(STORIES.CONTROL_PLANE)
        expect(storyForDecision(29)).toBe(STORIES.DASHBOARD)
        expect(storyForDecision(30)).toBe(STORIES.COOKBOOK)
        expect(storyForDecision(34)).toBe(STORIES.COOKBOOK)
    })

    test('source files map to stories by path/name', () => {
        expect(storyForSource('knowledge/OAUTH-SPIKE.md')).toBe(STORIES.AUTH)
        expect(storyForSource('knowledge/RESOURCE-CONTROL-PLANE.md')).toBe(STORIES.CONTROL_PLANE)
        expect(storyForSource('knowledge/COOKBOOK-VISION.md')).toBe(STORIES.COOKBOOK)
        expect(storyForSource('knowledge/ARCHITECTURE.md')).toBe(STORIES.INVESTIGATION)
        expect(storyForSource('prompts/claude-code-02b-auth0-provider.md')).toBe(STORIES.AUTH)
        expect(storyForSource('prompts/claude-code-06-control-plane-dashboard.md')).toBe(STORIES.DASHBOARD)
        expect(storyForSource('prompts/claude-code-07-dogfood-ingest.md')).toBe(STORIES.COOKBOOK)
        expect(storyForSource('prompts/claude-code-01-standup-connector.md')).toBe(STORIES.CONNECTOR)
        expect(storyForSource('playbooks/aem-read-page.yaml')).toBe(STORIES.INVESTIGATION)
        expect(storyForSource('runner/src/playbook.ts')).toBe(STORIES.INVESTIGATION)
    })
})

describe('stableId + contentHash', () => {
    test('ids are deterministic, readable, and valid for save_resource', () => {
        const id = stableId('decision', 'knowledge/DECISION-LOG.md', 'D28')
        expect(id).toBe('decision-knowledge-decision-log-md-d28')
        expect(stableId('decision', 'knowledge/DECISION-LOG.md', 'D28')).toBe(id) // deterministic
        expect(id).toMatch(/^[a-z0-9][a-z0-9._-]{2,160}$/i) // matches the tool's id schema
    })

    test('id does NOT change when content changes (hash lives in the manifest, not the id)', () => {
        const a = stableId('architecture-doc', 'knowledge/ARCHITECTURE.md')
        const b = stableId('architecture-doc', 'knowledge/ARCHITECTURE.md')
        expect(a).toBe(b)
    })

    test('contentHash changes with content, stable for same content', () => {
        expect(contentHash('hello')).toBe(contentHash('hello'))
        expect(contentHash('hello')).not.toBe(contentHash('hello!'))
        expect(contentHash('x')).toMatch(/^[0-9a-f]{16}$/)
    })
})

describe('titleFromMarkdown', () => {
    test('uses the first # heading, falls back otherwise', () => {
        expect(titleFromMarkdown('# The Cookbook — vision\ntext', 'fb')).toBe('The Cookbook — vision')
        expect(titleFromMarkdown('no heading here', 'fallback-name')).toBe('fallback-name')
    })
})

describe('planFromManifest (idempotency core)', () => {
    const items = [
        { id: 'a', hash: 'h1' },
        { id: 'b', hash: 'h2' },
        { id: 'c', hash: 'h3' }
    ]

    test('empty manifest -> everything is a create', () => {
        const plan = planFromManifest(items, {})
        expect(plan.create.map(i => i.id)).toEqual(['a', 'b', 'c'])
        expect(plan.update).toHaveLength(0)
        expect(plan.skip).toHaveLength(0)
    })

    test('unchanged manifest -> everything is a skip (re-run makes zero API calls)', () => {
        const manifest = { a: 'h1', b: 'h2', c: 'h3' }
        const plan = planFromManifest(items, manifest)
        expect(plan.skip.map(i => i.id)).toEqual(['a', 'b', 'c'])
        expect(plan.create).toHaveLength(0)
        expect(plan.update).toHaveLength(0)
    })

    test('changed hash -> update; new id -> create; rest skip - never a duplicate', () => {
        const manifest = { a: 'h1', b: 'OLD' }
        const plan = planFromManifest(items, manifest)
        expect(plan.skip.map(i => i.id)).toEqual(['a'])
        expect(plan.update.map(i => i.id)).toEqual(['b'])
        expect(plan.create.map(i => i.id)).toEqual(['c'])
    })
})
