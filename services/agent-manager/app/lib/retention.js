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
 * Retention purge (D44/D45): experimental steps expire after the configured retention
 * window (lib/settings.js); a daily job deletes expired experimental steps, and any
 * job left with no approved/active steps as a result. Approved content is never
 * touched - a step is only ever purged while it is still `experimental` AND past its
 * `expires_at`.
 *
 * Shared by the purge_expired MCP tool (on-demand) and the scheduled purge action
 * (actions/purge-scheduled, daily via App Builder cron) - one implementation, two
 * triggers. Idempotent: re-running finds nothing left to purge and is a no-op.
 */

const store = require('./store')
const statusLib = require('./status')
const { ensureSteps, composeContent, jobStatusFromSteps, aggregateTokens, aggregateModels, earliestExpiry } = require('./steps')

/**
 * @param {string} [now] ISO timestamp to purge as-of (defaults to the real current time)
 * @returns {Promise<{checked: number, purged_steps: number, purged_jobs: number}>}
 */
async function purgeExpired (now = new Date().toISOString()) {
    const catalog = await store.listResources({})
    let purgedSteps = 0
    let purgedJobs = 0
    let checked = 0

    for (const entry of catalog) {
        checked++
        const resource = await store.getResource(entry.id)
        if (!resource) continue // already gone - fine, purge is idempotent

        const steps = ensureSteps(resource)
        const kept = []
        for (const step of steps) {
            const expired = statusLib.isExperimental(step.status) && step.expires_at && step.expires_at <= now
            if (!expired) {
                kept.push(step)
                continue
            }
            purgedSteps++
            if (step.asset && step.asset.path) {
                await store.deleteAsset(step.asset.path)
            }
        }

        // "no approved/active steps" = nothing left worth keeping - discarded steps don't count either.
        const remaining = kept.filter(s => s.status !== 'discarded')
        if (remaining.length === 0) {
            await store.deleteResource(resource.id)
            purgedJobs++
            continue
        }

        if (kept.length !== steps.length) {
            resource.steps = kept
            // A baked job stays baked even if a stray experimental step expired (D47).
            resource.status = resource.baked ? 'baked' : jobStatusFromSteps(kept)
            resource.content = composeContent(kept)
            const tokens = aggregateTokens(kept)
            resource.tokens_used = tokens.total
            resource.tokens_last = tokens.last
            resource.models_used = aggregateModels(kept)
            resource.step_count = kept.filter(s => s.status !== 'discarded').length
            resource.expires_at = earliestExpiry(kept)
            resource.updated_at = now
            await store.saveResource(resource)
        }
    }

    return { checked, purged_steps: purgedSteps, purged_jobs: purgedJobs }
}

module.exports = { purgeExpired }
