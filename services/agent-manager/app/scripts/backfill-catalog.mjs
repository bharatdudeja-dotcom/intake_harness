/**
 * Re-derive the metadata catalog from the resource documents.
 *
 * WHY THIS IS NEEDED
 *
 * The catalog (resources/index.json) is a projection, written once per save.
 * Adding a field to that projection - `agents`, `agent_faults`, `upstream` -
 * does nothing for records already on disk: they keep the shape they had when
 * they were last written. So every list view went on seeing genuine agent runs
 * as indistinguishable from hand-captured documents, and every progress bar read
 * zero, while the underlying resources held the answer all along.
 *
 * This reloads each resource, re-runs the same rollup the save path runs, and
 * re-saves. Nothing is invented: every value is derived from the steps that are
 * already there.
 *
 * Idempotent. Safe to run twice. Run it after any change to projectJob or
 * toMetadata, which is exactly the kind of change that looks harmless and is
 * silently retroactive-by-omission.
 *
 *   node scripts/backfill-catalog.mjs          # report only
 *   node scripts/backfill-catalog.mjs --write  # actually re-save
 */

import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const store = require('../lib/store')
const stepsLib = require('../lib/steps')

const WRITE = process.argv.includes('--write')

/**
 * The same rollup the save path performs. Imported rather than reimplemented
 * would be better, but projectJob is not exported - so this mirrors it for
 * the two fields that matter here, and says so.
 */
function agentRollup (steps) {
    const seen = []
    const faulted = new Set()
    for (const s of steps) {
        if (s.status === 'discarded') continue
        const tags = s.tags || []
        const at = tags.indexOf('agent')
        if (at === -1) continue
        const id = tags[at + 1]
        if (!id || id === 'silent-failure') continue
        if (!seen.includes(id)) seen.push(id)
        if (tags.includes('silent-failure')) faulted.add(id)
    }
    return { agents: seen, faults: [...faulted] }
}

const entries = await store.listResources({})
console.log(`${entries.length} catalog entr${entries.length === 1 ? 'y' : 'ies'}\n`)

let changed = 0
for (const entry of entries) {
    const full = await store.getResource(entry.id)
    if (!full) { console.log(`  ?  ${entry.id} - no document behind the catalog entry`); continue }

    const steps = stepsLib.ensureSteps(full)
    const { agents, faults } = agentRollup(steps)

    const before = {
        agents: (entry.agents || []).join(','),
        faults: (entry.agent_faults || []).join(','),
        upstream: !!entry.upstream
    }
    const after = {
        agents: agents.join(','),
        faults: faults.join(','),
        upstream: !!full.upstream
    }
    const differs = before.agents !== after.agents || before.faults !== after.faults || before.upstream !== after.upstream
    if (!differs) { console.log(`  =  ${(full.title || entry.id).slice(0, 52)}`); continue }

    changed++
    console.log(`  ${WRITE ? '+' : '~'}  ${(full.title || entry.id).slice(0, 52)}`)
    console.log(`       agents   ${before.agents || '(none)'}  ->  ${after.agents || '(none)'}`)
    if (after.faults) console.log(`       faulted  ${before.faults || '(none)'}  ->  ${after.faults}`)
    if (before.upstream !== after.upstream) console.log(`       upstream ${before.upstream}  ->  ${after.upstream}`)

    if (WRITE) {
        full.agents = agents.length ? agents : undefined
        full.agent_faults = faults.length ? faults : undefined
        // saveResource re-projects the whole entry through toMetadata, so every
        // other newly-added field comes along too.
        await store.saveResource(full)
    }
}

console.log(`\n${changed} entr${changed === 1 ? 'y' : 'ies'} ${WRITE ? 'rewritten' : 'would change'}.`)
if (!WRITE && changed) console.log('Re-run with --write to apply.')
