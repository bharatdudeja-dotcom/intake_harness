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
 * Migrate the already-ingested recipes into the Increment-9 model (D42):
 *   - segments.project = "Tap Portability Layer" (promotes the old top bucket to a Project)
 *   - map the existing epic/story into segments
 *   - set owner to the default (service) principal - set server-side on save
 *   - keep each recipe's current approval status
 *
 * Runs locally against the deployed connector via x-api-key (like the ingest script).
 *
 * Idempotent + no duplicates by construction: it re-saves each recipe under its OWN
 * stable id with its EXACT existing content, so save_resource takes the metadata-only
 * update path - no version bump, no re-approval, status preserved - and a second run
 * skips anything that already carries segments.project. (Idempotency comes from
 * skip-if-migrated + upsert-by-id; the ingest manifest isn't needed for that, so it is
 * intentionally not consulted here.)
 *
 * Run: node scripts/migrate-to-segmentation.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONNECTOR_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_PROJECT = 'Tap Portability Layer'

function loadEnv (path) {
    const env = {}
    if (!existsSync(path)) return env
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
        if (m) env[m[1]] = m[2]
    }
    return env
}

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

async function main () {
    const env = loadEnv(join(CONNECTOR_ROOT, '.env'))
    const apiKey = env.SERVICE_API_KEY
    const mcpUrl = env.MCP_RESOURCE_URL
    if (!apiKey || !mcpUrl) {
        console.error('✗ SERVICE_API_KEY / MCP_RESOURCE_URL not found in connector/.env')
        process.exit(1)
    }

    const catalog = await callTool(mcpUrl, apiKey, 'list_resources', {})
    const validTypes = new Set((await callTool(mcpUrl, apiKey, 'list_resource_types', {})).map(t => t.type))
    console.log(`Migrating into ${mcpUrl}`)
    console.log(`Catalog: ${catalog.length} recipes\n`)

    const result = { migrated: [], skipped: [], legacy: [], failed: [] }
    for (const entry of catalog) {
        const alreadyMigrated = entry.segments && entry.segments.project
        if (alreadyMigrated) {
            result.skipped.push(entry.id)
            continue
        }
        if (!validTypes.has(entry.type)) {
            // Pre-policy test artifacts (e.g. the old "note" kind from Increments 1-2)
            // can't be re-saved through the policy-validated save_resource and are not part
            // of the dogfood corpus - leave them inert rather than fail the migration.
            result.legacy.push(entry.id)
            console.log(`  - ${entry.id}  (legacy kind "${entry.type}" - left as-is)`)
            continue
        }
        try {
            const full = await callTool(mcpUrl, apiKey, 'get_resource', { id: entry.id })
            const project = full.epic || DEFAULT_PROJECT // old top bucket -> Project
            const args = {
                id: full.id,
                type: full.type,
                format: full.format,
                title: full.title,
                content: full.content, // EXACT same content -> metadata-only update (no version bump / no reapprove)
                project,
                tags: full.tags,
                fields: full.fields
            }
            if (full.epic !== undefined) args.epic = full.epic
            if (full.story !== undefined) args.story = full.story
            if (full.type === 'handoff-prompt') {
                args.target_agent = full.target_agent
                args.task_status = full.task_status
            }
            const saved = await callTool(mcpUrl, apiKey, 'save_resource', args)
            result.migrated.push({ id: saved.id, project, status: saved.status })
            console.log(`  ~ ${saved.id}  project="${project}"  status=${saved.status} v${saved.version}`)
        } catch (e) {
            result.failed.push({ id: entry.id, error: e.message })
            console.error(`  ✗ ${entry.id}: ${e.message}`)
        }
    }

    console.log('\n=== Summary ===')
    console.log(`migrated: ${result.migrated.length}, skipped (already migrated): ${result.skipped.length}, legacy (unknown kind, left as-is): ${result.legacy.length}, failed: ${result.failed.length}`)
    const byStatus = {}
    for (const m of result.migrated) byStatus[m.status] = (byStatus[m.status] || 0) + 1
    if (result.migrated.length) console.log('migrated by status:', JSON.stringify(byStatus))

    if (result.failed.length) process.exit(1)
}

main().catch(e => { console.error('✗ Migration failed:', e); process.exit(1) })
