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
 * Portability check (D21/D34): fails if infra-/IdP-/AI-vendor coupling leaks
 * into core logic. Core logic = lib/** plus the MCP tool logic
 * (actions/mcp-server/tools.js). Coupling is allowed ONLY in the designated
 * adapter files:
 *   - actions/<action>/index.js host wrappers (own the transport's request shape)
 *   - lib/store.js               (the storage adapter - // SWAP POINT)
 *   - lib/auth/config.js         (the IdP adapter - reads provider config)
 *
 * Run: node scripts/portability-check.mjs   (exit 0 = clean, 1 = coupling found)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONNECTOR_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Banned coupling markers (case-insensitive). Each is a hard dependency smell. */
const BANNED = [
    '__ow_', // OpenWhisk request shape
    'aio-lib-files', // storage vendor
    'adobeioruntime', // host domain
    'adobelogin', // IdP domain
    'ims-na1', // IdP host
    'auth0', // IdP vendor
    '@adobe/aio-sdk', // host SDK
    'claude', // AI vendor
    'anthropic', // AI vendor
    '110557' // this org's id
]

/** Files where coupling is the point - the adapters (relative, forward slashes). */
const ALLOWED_ADAPTERS = new Set([
    'lib/store.js',
    'lib/auth/config.js',
    'lib/skills/vendor-adapters.js', // per-vendor skill export formats (D31)
    // The storage drivers. lib/store.js used to name its vendor directly; now it
    // names an interface, and the vendors live here - one file per backend. This
    // is the same boundary, drawn one level lower, so that the app can run on
    // local disk, S3, GCS or Adobe I/O without lib/** knowing which.
    'lib/storage/index.js',
    'lib/storage/aio.js',
    'lib/storage/fs.js',
    'lib/storage/s3.js',
    'lib/storage/gcs.js',
    // The host logger. Replaces the host SDK's logger with structured stdout,
    // which every container platform collects without configuration.
    'lib/logger.js'
])

/** @returns {string[]} all .js files under dir, recursively */
function walk (dir) {
    const out = []
    for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) out.push(...walk(full))
        else if (name.endsWith('.js')) out.push(full)
    }
    return out
}

const targets = [
    ...walk(join(CONNECTOR_ROOT, 'lib')),
    join(CONNECTOR_ROOT, 'actions', 'mcp-server', 'tools.js') // tool logic is core, not a host wrapper
]

const violations = []
for (const file of targets) {
    const rel = relative(CONNECTOR_ROOT, file).replace(/\\/g, '/')
    if (ALLOWED_ADAPTERS.has(rel)) continue

    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => {
        const lower = line.toLowerCase()
        for (const marker of BANNED) {
            if (lower.includes(marker)) {
                violations.push({ file: rel, line: i + 1, marker, text: line.trim().slice(0, 100) })
            }
        }
    })
}

if (violations.length) {
    console.error(`✗ Portability check FAILED - ${violations.length} coupling marker(s) outside the allowed adapters:\n`)
    for (const v of violations) {
        console.error(`  ${v.file}:${v.line}  [${v.marker}]  ${v.text}`)
    }
    console.error('\nAllowed adapter files: actions/*/index.js (host wrappers), lib/store.js, lib/auth/config.js')
    process.exit(1)
}

console.log(`✓ Portability check passed - ${targets.length - ALLOWED_ADAPTERS.size} core files scanned, 0 coupling markers found.`)
console.log('  Core logic is free of host/storage/IdP/AI-vendor coupling (D21/D34).')
