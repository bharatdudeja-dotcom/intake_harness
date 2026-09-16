#!/usr/bin/env node
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
 * Dogfood ingest (Increment 7, D33/D34): loads this engagement's own knowledge
 * into the deployed connector as recipes - the connector documents itself.
 *
 * Sources -> recipes:
 *   knowledge/DECISION-LOG.md   -> one `decision` per "### Dnn —" section
 *   knowledge/*.md (others)     -> one `architecture-doc` per document
 *   playbooks/*.yaml            -> `playbook` (yaml)
 *   prompts/*.md                -> `playbook` (md, tagged "prompt")
 *   runner/src/*                -> `code-snippet` (fenced)
 *
 * Idempotent: deterministic id per source (+anchor); scripts/ingest-manifest.json
 * maps id -> content hash. Re-runs create new, update changed, skip unchanged -
 * never duplicate. Incremental: unchanged items make no API call at all.
 *
 * Run locally: node scripts/ingest-knowledge.mjs
 * Talks to the deployed connector via x-api-key (SERVICE_API_KEY + MCP_RESOURCE_URL
 * from connector/.env). Respects the policy: auto-approve kinds land "active",
 * human-gated kinds land "pending".
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    EPIC, parseDecisionLog, storyForDecision, storyForSource,
    stableId, contentHash, titleFromMarkdown, planFromManifest
} from './ingest-lib.cjs'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const CONNECTOR_ROOT = join(SCRIPTS_DIR, '..')
const TPL_ROOT = join(CONNECTOR_ROOT, '..') // tap-portability-layer/
const REPO_ROOT = join(TPL_ROOT, '..') // workspace root (has knowledge/)
const MANIFEST_PATH = join(SCRIPTS_DIR, 'ingest-manifest.json')

/** Minimal .env parser - avoids a dotenv dependency for a local script. */
function loadEnv (path) {
    const env = {}
    if (!existsSync(path)) return env
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
        if (m) env[m[1]] = m[2]
    }
    return env
}

/** @returns {object[]} every recipe item to ingest, with id/hash precomputed */
function collectItems () {
    const items = []

    // 1. Decision log -> one decision recipe per ### Dnn — section
    const decisionLogPath = join(REPO_ROOT, 'knowledge', 'DECISION-LOG.md')
    const decisionLog = readFileSync(decisionLogPath, 'utf8')
    for (const d of parseDecisionLog(decisionLog)) {
        items.push({
            id: stableId('decision', 'knowledge/DECISION-LOG.md', d.anchor),
            type: 'decision',
            format: 'md',
            title: d.title,
            content: d.content,
            story: storyForDecision(d.number),
            tags: ['decision', 'decision-log', d.anchor.toLowerCase()],
            source: 'knowledge/DECISION-LOG.md',
            anchor: d.anchor
        })
    }

    // 2. Other knowledge docs -> architecture-doc (one per document)
    for (const name of readdirSync(join(REPO_ROOT, 'knowledge'))) {
        if (!name.endsWith('.md') || name === 'DECISION-LOG.md') continue
        const rel = `knowledge/${name}`
        const content = readFileSync(join(REPO_ROOT, 'knowledge', name), 'utf8')
        items.push({
            id: stableId('architecture-doc', rel),
            type: 'architecture-doc',
            format: 'md',
            title: titleFromMarkdown(content, name.replace(/\.md$/, '')),
            content,
            story: storyForSource(rel),
            tags: ['architecture', 'knowledge-doc'],
            source: rel
        })
    }

    // 3. Playbooks -> playbook (yaml)
    const playbooksDir = join(TPL_ROOT, 'playbooks')
    if (existsSync(playbooksDir)) {
        for (const name of readdirSync(playbooksDir)) {
            if (!name.endsWith('.yaml') && !name.endsWith('.yml')) continue
            const rel = `playbooks/${name}`
            items.push({
                id: stableId('playbook', rel),
                type: 'playbook',
                format: 'yaml',
                title: `Playbook: ${name.replace(/\.ya?ml$/, '')}`,
                content: readFileSync(join(playbooksDir, name), 'utf8'),
                story: storyForSource(rel),
                tags: ['playbook'],
                source: rel
            })
        }
    }

    // 4. Prompts -> playbook (md) tagged "prompt"
    const promptsDir = join(TPL_ROOT, 'prompts')
    if (existsSync(promptsDir)) {
        for (const name of readdirSync(promptsDir)) {
            if (!name.endsWith('.md')) continue
            const rel = `prompts/${name}`
            const content = readFileSync(join(promptsDir, name), 'utf8')
            items.push({
                id: stableId('playbook', rel),
                type: 'playbook',
                format: 'md',
                title: titleFromMarkdown(content, `Prompt: ${name.replace(/\.md$/, '')}`),
                content,
                story: storyForSource(rel),
                tags: ['playbook', 'prompt'],
                source: rel
            })
        }
    }

    // 5. Runner sources -> code-snippet (fenced)
    const runnerSrcDir = join(TPL_ROOT, 'runner', 'src')
    if (existsSync(runnerSrcDir)) {
        for (const name of readdirSync(runnerSrcDir)) {
            const rel = `runner/src/${name}`
            const lang = name.endsWith('.ts') ? 'ts' : name.endsWith('.js') ? 'js' : ''
            const raw = readFileSync(join(runnerSrcDir, name), 'utf8')
            items.push({
                id: stableId('code-snippet', rel),
                type: 'code-snippet',
                format: 'md',
                title: `Runner source: ${basename(name)}`,
                content: `Playbook runner source file \`${rel}\` (host-agnostic playbook execution).\n\n\`\`\`${lang}\n${raw}\n\`\`\`\n`,
                story: storyForSource(rel),
                tags: ['code', 'runner'],
                source: rel
            })
        }
    }

    for (const item of items) item.hash = contentHash(item.content)
    return items
}

/** POST one save_resource tools/call to the deployed connector. */
async function saveRecipe (item, { mcpUrl, apiKey }) {
    const rpc = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
            name: 'save_resource',
            arguments: {
                id: item.id,
                type: item.type,
                format: item.format,
                title: item.title,
                content: item.content,
                epic: EPIC,
                story: item.story,
                tags: item.tags,
                fields: {
                    source: item.source,
                    ...(item.anchor ? { anchor: item.anchor } : {}),
                    session: 'cowork',
                    ingestedAt: new Date().toISOString(),
                    contentHash: item.hash
                }
            }
        }
    }
    const res = await fetch(mcpUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'x-api-key': apiKey
        },
        body: JSON.stringify(rpc)
    })
    const body = await res.json()
    if (res.status !== 200 || body.error) {
        throw new Error(`HTTP ${res.status}: ${body.error?.message || JSON.stringify(body).slice(0, 200)}`)
    }
    const toolResult = body.result
    const text = toolResult?.content?.[0]?.text || ''
    if (toolResult?.isError) throw new Error(text)
    return JSON.parse(text)
}

async function main () {
    const env = loadEnv(join(CONNECTOR_ROOT, '.env'))
    const apiKey = env.SERVICE_API_KEY
    const mcpUrl = env.MCP_RESOURCE_URL
    if (!apiKey || !mcpUrl) {
        console.error('✗ SERVICE_API_KEY / MCP_RESOURCE_URL not found in connector/.env')
        process.exit(1)
    }

    const manifest = existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) : {}
    const items = collectItems()
    const plan = planFromManifest(items, manifest)

    console.log(`Ingesting into ${mcpUrl}`)
    console.log(`Sources: ${items.length} recipes | plan: ${plan.create.length} create, ${plan.update.length} update, ${plan.skip.length} skip (unchanged)\n`)

    const results = { created: [], updated: [], skipped: plan.skip.map(i => i.id), failed: [] }
    for (const [label, list] of [['create', plan.create], ['update', plan.update]]) {
        for (const item of list) {
            try {
                const saved = await saveRecipe(item, { mcpUrl, apiKey })
                manifest[item.id] = item.hash
                results[label === 'create' ? 'created' : 'updated'].push(item.id)
                console.log(`  ${label === 'create' ? '+' : '~'} ${item.id} [${item.story}] -> ${saved.status}`)
            } catch (e) {
                results.failed.push({ id: item.id, error: e.message })
                console.error(`  ✗ ${item.id}: ${e.message}`)
            }
        }
    }

    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

    // Summary by story and kind
    const byStory = {}
    const byKind = {}
    for (const item of items) {
        byStory[item.story] = (byStory[item.story] || 0) + 1
        byKind[item.type] = (byKind[item.type] || 0) + 1
    }
    console.log('\n=== Summary ===')
    console.log(`created: ${results.created.length}, updated: ${results.updated.length}, skipped: ${results.skipped.length}, failed: ${results.failed.length}`)
    console.log(`manifest: ${MANIFEST_PATH}`)
    console.log('\nBy story:')
    for (const [story, n] of Object.entries(byStory)) console.log(`  ${story}: ${n}`)
    console.log('By kind:')
    for (const [kind, n] of Object.entries(byKind)) console.log(`  ${kind}: ${n}`)

    if (results.failed.length) process.exit(1)
}

main().catch(e => { console.error('✗ Ingest failed:', e); process.exit(1) })
