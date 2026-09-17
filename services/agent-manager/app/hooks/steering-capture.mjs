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
 * Steering-capture hook for the coding-agent tier of D47's no-loss capture design.
 *
 * The user's yes / no / correction click lives in the AI client's own UI - the MCP
 * connector never sees it directly (D41: capture is cooperative, we do not intercept host
 * UI). This hook closes that gap DETERMINISTICALLY for the one client that exposes a hook
 * API: it is wired to PreToolUse / PostToolUse / Notification, fires on every such event,
 * and POSTs it to the connector as an ordered `append_step(kind:"steering")` on the active
 * job - so no steering decision is dropped on the coding-agent side.
 *
 *   permission allow / approve  -> signal "affirm"  (green in the Work Log)
 *   permission deny / block     -> signal "reject"  (red)
 *   input edited / updated       -> signal "correct" (amber - prime capture)
 *
 * Config, in priority order (D62 / @tap/cookbook-connect):
 *   1. Env vars, if set:
 *      TAP_MCP_URL   - the mcp-server endpoint
 *      TAP_API_KEY   - x-api-key for the headless-agent auth path
 *      TAP_JOB_ID - the task-thread job to append to (skips get_active_job)
 *      TAP_PROJECT   - project to resolve the active job for
 *      TAP_SOURCE    - free-text source label for the step
 *      TAP_MODEL     - free-text model label for the step (optional)
 *   2. ~/.tap-cookbook/config.json (written by `npx @tap/cookbook-connect`), for any of the
 *      above left unset: { mcpUrl, apiKey, source, project? }.
 *   3. If no project is configured either way, derive one from the current working
 *      directory's folder name - so every folder a session runs in auto-tags its own project,
 *      forward-only, with no per-folder setup.
 *
 * This is a CLIENT-SIDE integration kit, intentionally outside lib/** and tools.js - it is
 * not core connector logic and is not scanned by scripts/portability-check.mjs. It never
 * blocks the host: any failure is swallowed and it exits 0.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

/**
 * Reads ~/.tap-cookbook/config.json, if present. Never throws - a missing/malformed
 * config just means "nothing configured", same as unset env vars.
 * @returns {{mcpUrl?: string, apiKey?: string, source?: string, project?: string}}
 */
function readFileConfig () {
    try {
        return JSON.parse(readFileSync(join(homedir(), '.tap-cookbook', 'config.json'), 'utf8'))
    } catch (e) {
        return {}
    }
}

/**
 * Resolves hook config from env first, falling back to the installed config file, then
 * deriving a project from the cwd folder name as a last resort (D62).
 * @returns {{url: ?string, apiKey: ?string, jobId: ?string, project: ?string, source: string, model: ?string}}
 */
function resolveConfig () {
    const fileConfig = readFileConfig()
    const project = process.env.TAP_PROJECT || fileConfig.project || basename(process.cwd())
    return {
        url: process.env.TAP_MCP_URL || fileConfig.mcpUrl || null,
        apiKey: process.env.TAP_API_KEY || fileConfig.apiKey || null,
        jobId: process.env.TAP_JOB_ID || null,
        project,
        source: process.env.TAP_SOURCE || fileConfig.source || 'cli-agent',
        model: process.env.TAP_MODEL || undefined
    }
}

function readStdin () {
    return new Promise((resolve) => {
        let data = ''
        process.stdin.setEncoding('utf8')
        process.stdin.on('data', (chunk) => { data += chunk })
        process.stdin.on('end', () => resolve(data))
        // If nothing is piped in, don't hang.
        setTimeout(() => resolve(data), 250)
    })
}

/**
 * Map a Claude Code hook event to a steering signal (best-effort, field-tolerant across
 * hook-schema versions).
 * @param {object} ev parsed hook input
 * @returns {{signal: 'affirm'|'reject'|'correct', label: string}}
 */
function classify (ev) {
    const name = ev.hook_event_name || ev.hookEventName || ''
    const tool = ev.tool_name || ev.toolName || ''
    const resp = ev.tool_response || ev.toolResponse || {}
    const decision = String(
        ev.permission_decision || ev.permissionDecision || resp.permissionDecision || resp.decision || ev.decision || ''
    ).toLowerCase()
    const input = ev.tool_input || ev.toolInput
    const updated = resp.updatedInput || resp.updated_input || ev.updatedInput

    let signal = 'affirm'
    if (decision.includes('deny') || decision.includes('block') || decision.includes('reject')) {
        signal = 'reject'
    } else if (updated && input && JSON.stringify(updated) !== JSON.stringify(input)) {
        signal = 'correct'
    } else if (decision.includes('allow') || decision.includes('approve')) {
        signal = 'affirm'
    }

    const label = `${name || 'event'}${tool ? `: ${tool}` : ''} → ${signal}`
    return { signal, label }
}

async function callTool (url, apiKey, name, args) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'x-api-key': apiKey, Connection: 'close' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    })
    const body = await res.json()
    const text = body.result?.content?.[0]?.text || ''
    try { return JSON.parse(text) } catch (e) { return text }
}

async function resolveJobId (url, apiKey, config) {
    if (config.jobId) return config.jobId
    if (!config.project) return null
    const res = await callTool(url, apiKey, 'get_active_job', { project: config.project })
    return res && res.active_job ? res.active_job.id : null
}

async function main () {
    const config = resolveConfig()
    if (!config.url || !config.apiKey) return // not configured - no-op, never block the host

    const raw = await readStdin()
    let ev = {}
    try { ev = raw ? JSON.parse(raw) : {} } catch (e) { ev = {} }

    const jobId = await resolveJobId(config.url, config.apiKey, config)
    if (!jobId) return // no active task thread to append to - nothing to do

    const { signal, label } = classify(ev)
    await callTool(config.url, config.apiKey, 'append_step', {
        job_id: jobId,
        kind: 'steering',
        signal,
        content: label,
        source: config.source,
        model: config.model,
        provenance: { hook_event: ev.hook_event_name || ev.hookEventName, tool: ev.tool_name || ev.toolName, session: ev.session_id }
    })
}

main().catch(() => { /* never block the host on a capture failure (D41) */ }).finally(() => {
    // setImmediate (not a synchronous process.exit) lets any in-flight fetch/keep-alive
    // socket finish closing first - forcing exit mid-close crashes Node on Windows
    // (libuv assertion: "!(handle->flags & UV_HANDLE_CLOSING)").
    setImmediate(() => process.exit(0))
})
