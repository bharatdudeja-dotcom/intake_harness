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
 * The ordered Step/Job model (D45) - pure, portable helpers shared by the MCP tools
 * (actions/mcp-server/tools.js) and the retention purge (lib/retention.js).
 *
 * The key idea: a Job is an ORDERED container of Steps. The experimental job is
 * the full ordered step log as captured; the cookbook (approved) view is just the
 * approved steps, in their original order - a standalone, followable how-to. A job's
 * legacy flat fields (content/status/tokens_used/...), kept for back-compat with every
 * tool and the dashboard built before this increment, are a COMPOSED PROJECTION of its
 * steps - computed here, not stored as independent truth.
 *
 * Back-compat: a job saved before this increment (or via the save_resource wrapper,
 * which always targets step order 0) has no `steps` array on disk. ensureSteps()
 * synthesizes a single wrapped step from its legacy flat fields so every step-model tool
 * works uniformly whether or not the migration script (scripts/migrate-to-steps.mjs) has
 * run yet.
 */

const statusLib = require('./status')
const { getRetentionDays } = require('./settings')

const STEP_SEPARATOR = '\n\n---\n\n'

/** Policy `type` -> default step `kind`, for wrapping legacy flat jobs (D45 migration). */
const TYPE_TO_KIND = {
    'architecture-diagram': 'diagram',
    decision: 'decision',
    'architecture-doc': 'doc',
    playbook: 'doc',
    configuration: 'config',
    'meeting-notes': 'doc',
    'code-snippet': 'code',
    'handoff-prompt': 'handoff'
}

/** @param {string} [type] a resource-policy type id @returns {string} the step kind to infer for it */
function kindForType (type) {
    return TYPE_TO_KIND[type] || 'message'
}

/** @param {string} jobId @param {number} order @returns {string} a stable, parseable step id */
function makeStepId (jobId, order) {
    return `${jobId}::s${order}`
}

/**
 * @param {string} stepId as returned by makeStepId
 * @returns {{jobId: string, order: number}|null} null if not a well-formed step id
 */
function parseStepId (stepId) {
    const marker = '::s'
    const idx = String(stepId || '').lastIndexOf(marker)
    if (idx === -1) return null
    const jobId = stepId.slice(0, idx)
    const order = Number(stepId.slice(idx + marker.length))
    if (!jobId || !Number.isInteger(order) || order < 0) return null
    return { jobId, order }
}

/** @param {string} fromIso @returns {string} fromIso + the configured retention window */
function computeExpiry (fromIso) {
    return new Date(new Date(fromIso).getTime() + getRetentionDays() * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * Synthesize the single step a pre-Increment-11 flat job implicitly has, from its
 * legacy top-level fields. Source is unknown - the flat model never tracked it.
 * @param {object} resource a full job as read from the store
 * @returns {object} a step object at order 0
 */
function wrapLegacyStep (resource) {
    return {
        id: makeStepId(resource.id, 0),
        job_id: resource.id,
        order: 0,
        source: 'unknown',
        model: resource.model,
        kind: kindForType(resource.type),
        content: resource.content,
        format: resource.format,
        owner: resource.owner || resource.author,
        tokens_used: resource.tokens_used,
        tokens_last: resource.tokens_last,
        provenance: resource.fields,
        created: resource.created,
        updated: resource.updated_at || resource.updated || resource.created,
        status: resource.status,
        approved_by: resource.approved_by,
        approved_at: resource.approved_at,
        approval_note: resource.approval_note,
        tags: resource.tags
    }
}

/**
 * @param {object} resource a full job as read from the store
 * @returns {object[]} its steps - real ones if present (even an empty array, e.g. a
 *   freshly start_job'd container), else a synthesized single legacy step
 */
function ensureSteps (resource) {
    if (Array.isArray(resource.steps)) return resource.steps
    return [wrapLegacyStep(resource)]
}

/** @param {object[]} steps @returns {number} the next append order (max existing + 1, or 0) */
function nextOrder (steps) {
    return steps.length ? Math.max(...steps.map(s => s.order)) + 1 : 0
}

/**
 * The composed, followable content of a job: its non-discarded steps' content,
 * in order. Pass approvedOnly to get just the cookbook (certified) view.
 * @param {object[]} steps
 * @param {{approvedOnly?: boolean}} [opts]
 * @returns {string}
 */
function composeContent (steps, opts = {}) {
    const filtered = steps
        .filter(s => s.status !== 'discarded')
        .filter(s => !opts.approvedOnly || statusLib.isApproved(s.status))
        .slice()
        .sort((a, b) => a.order - b.order)
    return filtered.map(s => s.content).filter(c => c !== undefined && c !== null).join(STEP_SEPARATOR)
}

/**
 * A job is in the Cookbook once it has at least one approved step (D45).
 * @param {object[]} steps
 * @returns {'experimental'|'approved'}
 */
function jobStatusFromSteps (steps) {
    return steps.some(s => statusLib.isApproved(s.status)) ? statusLib.APPROVED : statusLib.EXPERIMENTAL
}

/**
 * @param {object[]} steps
 * @returns {{total: number|undefined, last: number|undefined}} tokens_used summed across
 *   steps (in order), and the most recent step's tokens_last delta
 */
function aggregateTokens (steps) {
    let total = 0
    let last
    let sawAny = false
    const ordered = steps.slice().sort((a, b) => a.order - b.order)
    for (const s of ordered) {
        if (s.tokens_used != null) { total += Number(s.tokens_used) || 0; sawAny = true }
        if (s.tokens_last != null) last = s.tokens_last
    }
    return { total: sawAny ? total : undefined, last }
}

/**
 * Distinct model names used across a job's steps, in first-appearance order (D47) -
 * stored on the job projection so the dashboard's Home summary can show "which models"
 * without fetching every step. Model is free text (vendor-neutral, D21).
 * @param {object[]} steps
 * @returns {string[]|undefined} undefined if no step declared a model
 */
function aggregateModels (steps) {
    const seen = []
    for (const s of steps.slice().sort((a, b) => a.order - b.order)) {
        if (s.model && !seen.includes(s.model)) seen.push(s.model)
    }
    return seen.length ? seen : undefined
}

/**
 * The earliest upcoming expiry among a job's still-experimental steps (D48) - surfaced
 * on the job projection so the dashboard's Home/Work Log "expiring soon" lens works off
 * list metadata without fetching every step.
 * @param {object[]} steps
 * @returns {string|undefined} ISO timestamp, or undefined if nothing is expiring
 */
function earliestExpiry (steps) {
    const expiries = steps
        .filter(s => statusLib.isExperimental(s.status) && s.expires_at)
        .map(s => s.expires_at)
        .sort()
    return expiries[0]
}

/** Human labels for the replay walkthrough header of each step. */
const KIND_LABEL = {
    message: 'Prompt / message',
    code: 'Code',
    diagram: 'Diagram',
    image: 'Image',
    decision: 'Decision',
    doc: 'Doc',
    handoff: 'Handoff',
    config: 'Config',
    steering: 'Steering',
    other: 'Step'
}

/**
 * Compose the end-to-end "replay" walkthrough of a job (D47): its steps in order,
 * each with a heading carrying kind/source/model, code fenced by language, asset steps
 * referenced (bytes aren't inlined into a prompt). This is the source-of-truth an AI can
 * follow to redo the task. Pass approvedOnly for the certified how-to (the export path).
 * @param {object[]} steps
 * @param {{approvedOnly?: boolean}} [opts]
 * @returns {string}
 */
function composeReplay (steps, opts = {}) {
    const ordered = steps
        .filter(s => s.status !== 'discarded')
        .filter(s => !opts.approvedOnly || statusLib.isApproved(s.status))
        .slice()
        .sort((a, b) => a.order - b.order)

    const blocks = ordered.map((s, i) => {
        const label = KIND_LABEL[s.kind] || 'Step'
        const meta = [
            s.source && s.source !== 'unknown' ? `source: ${s.source}` : null,
            s.model ? `model: ${s.model}` : null,
            s.kind === 'steering' && s.signal ? `signal: ${s.signal}` : null
        ].filter(Boolean).join(', ')
        const heading = `## Step ${i + 1}. ${label}${meta ? ` (${meta})` : ''}`

        let body
        if (s.kind === 'code') {
            body = '```' + (s.language || '') + '\n' + (s.content || '') + '\n```'
            if (s.diff) body += '\n\nDiff:\n```diff\n' + s.diff + '\n```'
        } else if (s.asset && !s.content) {
            body = `_[${s.asset.mime_type || 'binary'} asset: ${s.asset.path}]_`
        } else {
            body = s.content || ''
            if (s.asset) body += `\n\n_[rendered ${s.asset.mime_type || 'binary'} asset: ${s.asset.path}]_`
        }
        return `${heading}\n\n${body}`
    })
    return blocks.join('\n\n')
}

module.exports = {
    kindForType,
    makeStepId,
    parseStepId,
    computeExpiry,
    wrapLegacyStep,
    ensureSteps,
    nextOrder,
    composeContent,
    composeReplay,
    jobStatusFromSteps,
    aggregateTokens,
    aggregateModels,
    earliestExpiry
}
