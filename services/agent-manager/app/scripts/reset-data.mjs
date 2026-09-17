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
 * Reset the connector to a blank slate (D51/D52): delete all jobs/ingredients, the
 * catalog index, all project records, the work-context, and stored assets from the store,
 * plus the LOCAL ingest/recapture manifests - leaving tools/model/config intact.
 *
 * The actual store wipe happens server-side via the guarded admin_reset_data tool (the
 * store's aio-lib-files creds only exist inside the action); this script is the CLI that
 * calls it over HTTP with x-api-key, and clears the local manifests so a subsequent
 * re-capture starts clean.
 *
 * GUARDED: requires an explicit --confirm flag.
 * Run: node scripts/reset-data.mjs --confirm
 */

import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const CONNECTOR_ROOT = join(SCRIPTS_DIR, '..')
const LOCAL_MANIFESTS = ['ingest-manifest.json', 'recapture-manifest.json']

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
    if (!process.argv.includes('--confirm')) {
        console.error('✗ Refusing to reset. This deletes ALL jobs, ingredients, and project records.')
        console.error('  Re-run with --confirm to proceed:  node scripts/reset-data.mjs --confirm')
        process.exit(1)
    }
    const env = loadEnv(join(CONNECTOR_ROOT, '.env'))
    const apiKey = env.SERVICE_API_KEY
    const mcpUrl = env.MCP_RESOURCE_URL
    if (!apiKey || !mcpUrl) {
        console.error('✗ SERVICE_API_KEY / MCP_RESOURCE_URL not found in connector/.env')
        process.exit(1)
    }

    console.log(`Resetting ${mcpUrl} …`)
    const result = await callTool(mcpUrl, apiKey, 'admin_reset_data', { confirm: true })
    console.log(`  store: deleted ${result.deleted} file(s) (${result.jobs} job/index/project, ${result.assets} asset). Settings/config preserved.`)

    for (const name of LOCAL_MANIFESTS) {
        const p = join(SCRIPTS_DIR, name)
        if (existsSync(p)) { unlinkSync(p); console.log(`  local: removed ${name}`) }
    }

    // Verify blank slate
    const jobs = await callTool(mcpUrl, apiKey, 'list_jobs', {})
    const projects = await callTool(mcpUrl, apiKey, 'list_projects', {})
    console.log(`\n=== Verify ===\nlist_jobs: ${jobs.length}   list_projects: ${projects.length}`)
    if (jobs.length !== 0 || projects.length !== 0) { console.error('✗ Not empty after reset'); process.exit(1) }
    console.log('✓ Blank slate.')
}

main().catch(e => { console.error('✗ Reset failed:', e); process.exit(1) })
