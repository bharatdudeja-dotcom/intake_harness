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
 * Pure logic for the dogfood ingest (Increment 7, D33/D34): parsing sources
 * into recipe items, deterministic ids, content hashing, story mapping, and
 * the create/update/skip plan against the manifest. CommonJS so jest can test
 * it directly; scripts/ingest-knowledge.mjs imports it for the actual run.
 *
 * No I/O here - callers pass strings in and get plain objects back.
 */

const { createHash } = require('crypto')

const EPIC = 'Tap Portability Layer'

const STORIES = {
    INVESTIGATION: 'Investigation & Architecture',
    CONNECTOR: 'Connector',
    AUTH: 'Auth',
    CONTROL_PLANE: 'Resource Control Plane',
    DASHBOARD: 'Dashboard',
    COOKBOOK: 'Cookbook Vision'
}

/**
 * Split the decision log into one item per decision (### Dnn — heading).
 * @param {string} markdown full DECISION-LOG.md content
 * @returns {Array<{anchor: string, number: number, title: string, content: string}>}
 */
function parseDecisionLog (markdown) {
    const headingRe = /^### (D(\d+)) — (.+)$/gm
    const matches = []
    let m
    while ((m = headingRe.exec(markdown)) !== null) {
        matches.push({ anchor: m[1], number: parseInt(m[2], 10), title: m[3].trim(), start: m.index })
    }

    return matches.map((entry, i) => {
        // A decision section ends at the next decision heading, or at the next
        // top-level "## " section (Storage map / Reusable facts), whichever first.
        let end = i + 1 < matches.length ? matches[i + 1].start : markdown.length
        const nextSection = markdown.indexOf('\n## ', entry.start)
        if (nextSection !== -1 && nextSection < end) end = nextSection
        return {
            anchor: entry.anchor,
            number: entry.number,
            title: `${entry.anchor} — ${entry.title}`,
            content: markdown.slice(entry.start, end).trim()
        }
    })
}

/**
 * Which story a decision belongs to, by its number (the engagement's phases).
 * @param {number} n decision number
 * @returns {string}
 */
function storyForDecision (n) {
    if (n <= 17) return STORIES.INVESTIGATION
    if (n === 18) return STORIES.CONNECTOR
    if (n <= 25) return STORIES.AUTH
    if (n <= 28) return STORIES.CONTROL_PLANE
    if (n === 29) return STORIES.DASHBOARD
    return STORIES.COOKBOOK
}

/**
 * Which story a non-decision source file belongs to, by its repo-relative path
 * (forward slashes).
 * @param {string} relPath e.g. 'knowledge/OAUTH-SPIKE.md', 'prompts/claude-code-03-resource-control-plane.md'
 * @returns {string}
 */
function storyForSource (relPath) {
    const p = relPath.replace(/\\/g, '/').toLowerCase()

    if (p.startsWith('knowledge/')) {
        if (p.includes('oauth')) return STORIES.AUTH
        if (p.includes('resource-control-plane')) return STORIES.CONTROL_PLANE
        if (p.includes('cookbook')) return STORIES.COOKBOOK
        return STORIES.INVESTIGATION
    }
    if (p.startsWith('prompts/')) {
        if (p.includes('oauth') || p.includes('auth0') || p.includes('m2m')) return STORIES.AUTH
        if (p.includes('resource-control-plane')) return STORIES.CONTROL_PLANE
        if (p.includes('dashboard')) return STORIES.DASHBOARD
        if (p.includes('dogfood') || p.includes('cookbook')) return STORIES.COOKBOOK
        return STORIES.CONNECTOR
    }
    if (p.startsWith('playbooks/') || p.startsWith('runner/')) return STORIES.INVESTIGATION

    return STORIES.INVESTIGATION
}

/**
 * @param {string} value
 * @returns {string} lowercase slug, alnum + dashes
 */
function slug (value) {
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
}

/**
 * Deterministic, human-readable resource id from the source location. The id
 * carries NO content hash - the hash lives in the manifest, so a content change
 * updates the same id in place instead of minting a new resource (idempotent).
 * @param {string} type policy type
 * @param {string} sourceRelPath repo-relative source path
 * @param {string} [anchor] within-file anchor (e.g. 'D28')
 * @returns {string} matches save_resource's stable-id shape
 */
function stableId (type, sourceRelPath, anchor) {
    const base = `${type}-${slug(sourceRelPath)}${anchor ? `-${slug(anchor)}` : ''}`
    return base.slice(0, 160)
}

/**
 * @param {string} content
 * @returns {string} sha256 hex digest (16 chars is plenty for change detection)
 */
function contentHash (content) {
    return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16)
}

/**
 * @param {string} markdown
 * @param {string} fallback
 * @returns {string} first `# ` heading text, or the fallback
 */
function titleFromMarkdown (markdown, fallback) {
    const m = /^#\s+(.+)$/m.exec(markdown)
    return m ? m[1].trim() : fallback
}

/**
 * Decide create/update/skip for each item against the manifest (id -> hash).
 * @param {Array<{id: string, hash: string}>} items
 * @param {Record<string, string>} manifest previous run's id -> content hash
 * @returns {{create: object[], update: object[], skip: object[]}}
 */
function planFromManifest (items, manifest = {}) {
    const plan = { create: [], update: [], skip: [] }
    for (const item of items) {
        if (!(item.id in manifest)) plan.create.push(item)
        else if (manifest[item.id] !== item.hash) plan.update.push(item)
        else plan.skip.push(item)
    }
    return plan
}

module.exports = {
    EPIC,
    STORIES,
    parseDecisionLog,
    storyForDecision,
    storyForSource,
    slug,
    stableId,
    contentHash,
    titleFromMarkdown,
    planFromManifest
}
