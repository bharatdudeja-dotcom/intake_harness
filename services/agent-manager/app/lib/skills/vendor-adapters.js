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
 * VENDOR EXPORT ADAPTERS (D31) - the one place AI-vendor-specific skill
 * formats are allowed to live. lib/skills/index.js merges these into its
 * format registry; scripts/portability-check.mjs allowlists exactly this
 * file, so vendor names here don't count as core coupling (same rule as
 * lib/store.js for storage and lib/auth/config.js for the IdP).
 *
 * To support a new AI vendor's skill format, add an entry here - no core change.
 */

/**
 * @param {string} value
 * @returns {string} skill-safe slug (lowercase, alnum + hyphens, <=64 chars)
 */
function skillSlug (value) {
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || 'recipe'
}

/**
 * Claude Skill (SKILL.md) - Anthropic's portable skill bundle format: YAML
 * frontmatter (name, description) + a markdown body the model loads when the
 * skill is invoked. One self-contained SKILL.md; recipes have no separate
 * asset files today, so the bundle is the single file.
 * @param {object} resource full approved recipe
 * @returns {{filename: string, mimeType: string, content: string}}
 */
function buildClaudeSkill (resource) {
    const f = resource.fields || {}
    const work = [resource.epic, resource.story, resource.task].filter(Boolean).join(' > ')
    const description = `Certified company recipe (${resource.type})${work ? ` from "${work}"` : ''}: ${resource.title}. Use when this captured know-how applies to the task.`

    const content = [
        '---',
        `name: ${skillSlug(resource.title)}`,
        `description: ${description.replace(/\n/g, ' ').slice(0, 1024)}`,
        '---',
        '',
        `# ${resource.title}`,
        '',
        `> Certified house recipe from the company cookbook (kind: ${resource.type}).`,
        `> URI: resource://company/${resource.type}/${resource.id}`,
        work ? `> Work item: ${work}` : null,
        f.source ? `> Source: ${f.source}${f.anchor ? `#${f.anchor}` : ''}` : null,
        '',
        'Apply this captured company know-how when relevant:',
        '',
        resource.content,
        ''
    ].filter(line => line !== null).join('\n')

    return { filename: 'SKILL.md', mimeType: 'text/markdown', content }
}

module.exports = [
    {
        format: 'claude-skill',
        description: 'Claude Skill bundle - SKILL.md with name/description frontmatter and the recipe as its body',
        build: buildClaudeSkill
    }
]
