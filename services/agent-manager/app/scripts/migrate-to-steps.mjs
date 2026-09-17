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
 * Wrap every already-ingested flat recipe as a single-step recipe (D45, Increment 11).
 *
 * save_resource now always keeps a recipe's step-0 in sync with its legacy flat fields
 * (actions/mcp-server/tools.js) - so re-saving a recipe with its OWN id and EXACT
 * existing content takes the metadata-only update path (no version bump, no re-approval,
 * status preserved) and, as a side effect, backfills its `steps` array. This script is
 * therefore just a driven re-save, same shape as scripts/migrate-to-segmentation.mjs.
 *
 * Idempotent + no duplicates by construction: a recipe that already has a `steps` array
 * (get_resource returns it) is skipped on a second run.
 *
 * Run: node scripts/migrate-to-steps.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONNECTOR_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

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
        if (entry.type === 'handoff-prompt' || !validTypes.has(entry.type)) {
            // handoff-prompts don't go through save_resource's policy path here and
            // pre-policy test artifacts (unknown kinds) can't be re-saved through it -
            // left as-is, same treatment as migrate-to-segmentation.mjs gave them.
            if (!validTypes.has(entry.type)) {
                result.legacy.push(entry.id)
                console.log(`  - ${entry.id}  (legacy kind "${entry.type}" - left as-is)`)
                continue
            }
        }
        try {
            const full = await callTool(mcpUrl, apiKey, 'get_resource', { id: entry.id })
            if (Array.isArray(full.steps)) {
                result.skipped.push(entry.id)
                continue
            }
            const args = {
                id: full.id,
                type: full.type,
                format: full.format,
                title: full.title,
                content: full.content, // EXACT same content -> metadata-only update, backfills steps as a side effect
                project: full.project,
                tags: full.tags,
                fields: full.fields
            }
            if (full.segments) args.segments = full.segments
            if (full.epic !== undefined) args.epic = full.epic
            if (full.story !== undefined) args.story = full.story
            if (full.type === 'handoff-prompt') {
                args.target_agent = full.target_agent
                args.task_status = full.task_status
            }
            const saved = await callTool(mcpUrl, apiKey, 'save_resource', args)
            result.migrated.push({ id: saved.id, status: saved.status })
            console.log(`  ~ ${saved.id}  status=${saved.status} v${saved.version}  (step 0 backfilled)`)
        } catch (e) {
            result.failed.push({ id: entry.id, error: e.message })
            console.error(`  ✗ ${entry.id}: ${e.message}`)
        }
    }

    console.log('\n=== Summary ===')
    console.log(`migrated: ${result.migrated.length}, skipped (already wrapped): ${result.skipped.length}, legacy (unknown kind, left as-is): ${result.legacy.length}, failed: ${result.failed.length}`)

    if (result.failed.length) process.exit(1)
}

main().catch(e => { console.error('✗ Migration failed:', e); process.exit(1) })
