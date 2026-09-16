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
 * Faithful re-capture of the Tap Portability Layer engagement (D51/D52) onto the CORRECTED
 * model: a real project record "Tap Portability Layer" holding a handful of EXPERIMENTAL
 * recipes (one per increment/theme), each an ORDERED, source-tagged set of ingredients:
 *
 *   claude-desktop     -> the Cowork planning: knowledge/*.md decisions & docs + the
 *                         prompts/*.md handoff prompts (kinds: doc / decision / handoff)
 *   vscode-claude-code -> the build outcomes ("Increment N built…" decisions) + key
 *                         connector/** source files (kinds: decision / code)
 *
 * Everything is experimental (Bharat curates in the dashboard). Provenance marks each
 * ingredient as a one-time historical backfill (session "recapture"); real capture from
 * here on is live via the Claude Desktop Local-MCP connection (D50). A final composite
 * recipe links the per-increment recipes in order — the complete followable story.
 *
 * Idempotent: scripts/recapture-manifest.json records the recipe id per theme; a re-run
 * skips any theme already captured (0 duplicates). reset-data.mjs clears the manifest.
 *
 * Run: node scripts/recapture-engagement.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDecisionLog } from './ingest-lib.cjs'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const CONNECTOR_ROOT = join(SCRIPTS_DIR, '..')
const TPL_ROOT = join(CONNECTOR_ROOT, '..')
const REPO_ROOT = join(TPL_ROOT, '..')
const MANIFEST_PATH = join(SCRIPTS_DIR, 'recapture-manifest.json')
const PROJECT = 'Tap Portability Layer'
const MAX_INGREDIENT = 12000 // cap a single ingredient's content so payloads stay sane

const DESKTOP = 'claude-desktop'
const VSCODE = 'vscode-claude-code'

function loadEnv (path) {
    const env = {}
    if (!existsSync(path)) return env
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
        if (m) env[m[1]] = m[2]
    }
    return env
}
function readIf (relPath) {
    const p = join(REPO_ROOT, relPath)
    if (!existsSync(p)) return null
    let text = readFileSync(p, 'utf8')
    if (text.length > MAX_INGREDIENT) text = text.slice(0, MAX_INGREDIENT) + `\n\n…(truncated — full file is ${text.length} bytes at ${relPath})`
    return text
}
function langFor (path) { return path.endsWith('.ts') ? 'typescript' : path.endsWith('.js') ? 'javascript' : path.endsWith('.json') ? 'json' : path.endsWith('.html') ? 'html' : path.endsWith('.yaml') || path.endsWith('.yml') ? 'yaml' : '' }

async function callTool (mcpUrl, apiKey, name, args) {
    const res = await fetch(mcpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'x-api-key': apiKey },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    })
    const body = await res.json()
    if (res.status !== 200 || body.error) throw new Error(body.error?.message || `HTTP ${res.status}`)
    const text = body.result?.content?.[0]?.text || ''
    if (body.result?.isError) throw new Error(text)
    try { return JSON.parse(text) } catch (e) { return text }
}

/**
 * The engagement, one theme per recipe. `desktopDocs`/`desktopPrompts` are repo-relative
 * paths; `desktopDecisions`/`vscodeDecisions` are decision-log anchors; `vscodeCode` are
 * connector-relative source paths. `model` (where known from the prompt files) tags the
 * vscode build ingredients.
 */
const THEMES = [
    {
        key: 'investigation', title: 'Investigation & Architecture',
        desktopDocs: ['knowledge/ARCHITECTURE.md', 'knowledge/PORTAL-VISION.md', 'knowledge/ENTERPRISE-VALUE.md'],
        desktopDecisions: ['D12', 'D14', 'D16', 'D21'], desktopPrompts: [],
        vscodeDecisions: [], vscodeCode: []
    },
    {
        key: 'connector', title: 'Connector standup (MCP on App Builder)',
        desktopDocs: ['knowledge/AEM-MCP-SETUP-AND-FLOW.md'],
        desktopDecisions: ['D18', 'D19'], desktopPrompts: ['tap-portability-layer/prompts/claude-code-01-standup-connector.md'],
        vscodeDecisions: [], vscodeCode: ['actions/mcp-server/index.js']
    },
    {
        key: 'auth', title: 'Auth — OAuth / OIDC (Auth0 + M2M)',
        desktopDocs: ['knowledge/OAUTH-SPIKE.md'],
        desktopDecisions: ['D23', 'D24'], desktopPrompts: ['tap-portability-layer/prompts/claude-code-02-oauth-connector.md', 'tap-portability-layer/prompts/claude-code-02b-auth0-provider.md', 'tap-portability-layer/prompts/claude-code-evidence-m2m.md'],
        vscodeDecisions: [], vscodeCode: ['lib/auth/oidc.js', 'lib/auth/jwks.js']
    },
    {
        key: 'control-plane', title: 'Resource Control Plane (the cookbook loop)',
        desktopDocs: ['knowledge/RESOURCE-CONTROL-PLANE.md'],
        desktopDecisions: ['D26', 'D33', 'D34'], desktopPrompts: ['tap-portability-layer/prompts/claude-code-03-resource-control-plane.md'],
        vscodeDecisions: [], vscodeCode: ['lib/store.js', 'lib/policy.js']
    },
    {
        key: 'dashboard', title: 'Dashboard & Cookbook',
        desktopDocs: ['knowledge/COOKBOOK-VISION.md'],
        desktopDecisions: ['D29', 'D30'], desktopPrompts: ['tap-portability-layer/prompts/claude-code-06-control-plane-dashboard.md', 'tap-portability-layer/prompts/claude-code-07-dogfood-ingest.md', 'tap-portability-layer/prompts/claude-code-08-prompts-and-skills.md'],
        vscodeDecisions: ['D43'], vscodeCode: ['actions/dashboard-api/index.js']
    },
    {
        key: 'model-flow', title: 'Model & Flow Refinements (segmentation → ordered ingredients → daily-driver)',
        desktopDocs: ['knowledge/SEGMENTATION-AND-CX-GRAPH.md', 'knowledge/PRODUCT-BLUEPRINT.md', 'knowledge/PRODUCT-FLOW.md'],
        desktopDecisions: ['D45', 'D49'], desktopPrompts: ['tap-portability-layer/prompts/claude-code-09-segmentation-model.md', 'tap-portability-layer/prompts/claude-code-11-ordered-step-model.md', 'tap-portability-layer/prompts/claude-code-12-daily-driver.md', 'tap-portability-layer/prompts/claude-code-14-flow-fixes.md'],
        vscodeDecisions: ['D42', 'D46', 'D48'], vscodeCode: ['lib/steps.js', 'lib/retention.js', 'lib/settings.js'], model: 'fable-5'
    },
    {
        key: 'multitenant-cx', title: 'Multi-tenant isolation & Company CX Knowledge Graph',
        desktopDocs: ['knowledge/SEGMENTATION-AND-CX-GRAPH.md'],
        desktopDecisions: ['D40', 'D50', 'D51'], desktopPrompts: ['tap-portability-layer/prompts/claude-code-13-cx-knowledge-graph.md', 'tap-portability-layer/prompts/claude-code-14-reset-fix-recapture-cx.md'],
        vscodeDecisions: [], vscodeCode: [], model: 'fable-5'
    }
]

async function main () {
    const env = loadEnv(join(CONNECTOR_ROOT, '.env'))
    const apiKey = env.SERVICE_API_KEY
    const mcpUrl = env.MCP_RESOURCE_URL
    if (!apiKey || !mcpUrl) { console.error('✗ SERVICE_API_KEY / MCP_RESOURCE_URL not found in connector/.env'); process.exit(1) }
    const call = (n, a) => callTool(mcpUrl, apiKey, n, a)

    const manifest = existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) : { themes: {}, composite: null }
    manifest.themes = manifest.themes || {}

    // Decisions from the log, by anchor
    const decisions = {}
    for (const d of parseDecisionLog(readFileSync(join(REPO_ROOT, 'knowledge', 'DECISION-LOG.md'), 'utf8'))) decisions[d.anchor] = d

    console.log(`Re-capturing "${PROJECT}" into ${mcpUrl}\n`)
    await call('start_project', { name: PROJECT, note: 'Faithful historical re-capture of the engagement (D51).' })

    const prov = (file) => ({ session: 'recapture', backfill: true, historical: true, file })
    let created = 0; let skipped = 0; let ingredientCount = 0

    async function ingr (recipeId, source, kind, title, content, opts = {}) {
        if (!content) return
        await call('append_step', {
            recipe_id: recipeId, source, kind,
            content: `# ${title}\n\n${content}`,
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.language ? { language: opts.language } : {}),
            tags: ['recapture', kind],
            provenance: prov(opts.file)
        })
        ingredientCount++
    }

    for (const theme of THEMES) {
        if (manifest.themes[theme.key]) { console.log(`  = ${theme.title}  (already captured — skip)`); skipped++; continue }
        const rec = await call('start_recipe', { project: PROJECT, title: theme.title })
        // Desktop planning: docs → decisions → handoff prompts
        for (const rel of theme.desktopDocs) await ingr(rec.id, DESKTOP, 'doc', rel.split('/').pop(), readIf(rel), { file: rel })
        for (const anc of theme.desktopDecisions) if (decisions[anc]) await ingr(rec.id, DESKTOP, 'decision', decisions[anc].title, decisions[anc].content, { file: `knowledge/DECISION-LOG.md#${anc}` })
        for (const rel of theme.desktopPrompts) await ingr(rec.id, DESKTOP, 'handoff', rel.split('/').pop(), readIf(rel), { file: rel })
        // VS Code build: outcome decisions → source files
        for (const anc of theme.vscodeDecisions) if (decisions[anc]) await ingr(rec.id, VSCODE, 'decision', decisions[anc].title, decisions[anc].content, { file: `knowledge/DECISION-LOG.md#${anc}`, model: theme.model })
        for (const rel of theme.vscodeCode) { const c = readIf(`tap-portability-layer/connector/${rel}`); await ingr(rec.id, VSCODE, 'code', rel, c ? '```' + langFor(rel) + '\n' + c + '\n```' : null, { file: `connector/${rel}`, language: langFor(rel), model: theme.model }) }

        manifest.themes[theme.key] = rec.id
        created++
        console.log(`  + ${theme.title}  -> ${rec.id}`)
    }

    // Composite end-to-end recipe (links the per-increment recipes in order)
    if (!manifest.composite) {
        const comp = await call('start_recipe', { project: PROJECT, title: 'Building the Tap Portability Layer (end-to-end)' })
        let n = 0
        for (const theme of THEMES) {
            n++
            const rid = manifest.themes[theme.key] || '(this run)'
            await call('append_step', {
                recipe_id: comp.id, source: DESKTOP, kind: 'doc',
                content: `# Chapter ${n} — ${theme.title}\n\nRecipe: \`${rid}\`\n\nThe ${theme.title.toLowerCase()} phase of building the Tap Portability Layer. Open that recipe for its ordered ingredients (planning on Claude Desktop → build in VS Code / Claude Code).`,
                tags: ['recapture', 'composite'], provenance: { session: 'recapture', backfill: true, composite: true, links: manifest.themes[theme.key] }
            })
        }
        manifest.composite = comp.id
        console.log(`  + Composite end-to-end recipe -> ${comp.id}`)
    } else { console.log('  = Composite recipe (already captured — skip)') }

    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    console.log(`\n=== Summary ===\ncreated: ${created} theme recipe(s) + ${manifest.composite ? 1 : 0} composite; skipped: ${skipped}; ingredients appended: ${ingredientCount}`)
    console.log(`manifest: ${MANIFEST_PATH}`)
}

main().catch(e => { console.error('✗ Re-capture failed:', e); process.exit(1) })
