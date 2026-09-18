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
 * stepsLib.make - the step skeleton every capture path depends on.
 *
 * WHY THIS FILE EXISTS
 *
 * Five call sites did `stepsLib.make({...})` and there was no `make` in
 * lib/steps.js. Every one of them threw TypeError inside a try/catch whose own
 * comment says "failing to ALSO write it down must not read as the work having
 * failed" - so the work happened, the pipeline advanced, and not one stage was
 * ever recorded on the answer, gate or continue paths. No narration, no
 * duration, no model, no tokens. That is why the token figure was never
 * reported: nothing was ever written to report it from.
 *
 * The lesson is not "add the function". It is that a swallowed capture is
 * indistinguishable from a run that had nothing to capture, which is the exact
 * confusion this product exists to remove - so the skeleton is pinned here, and
 * the source of a step is asserted rather than assumed.
 */

const steps = require('../lib/steps.js')

describe('stepsLib.make', () => {

    test('every field the rest of the system addresses a step by', () => {
        const s = steps.make('job-7', 3, { kind: 'doc', content: 'what Agent 2 did' })
        // Without an id the approval flow cannot address it; without an order
        // the Work Log cannot sequence it; without expires_at the retention
        // sweep cannot ever remove it.
        expect(s.id).toBe(steps.makeStepId('job-7', 3))
        expect(s.job_id).toBe('job-7')
        expect(s.order).toBe(3)
        expect(s.status).toBe('experimental')
        expect(typeof s.created).toBe('string')
        expect(typeof s.expires_at).toBe('string')
        expect(new Date(s.expires_at).getTime()).toBeGreaterThan(new Date(s.created).getTime())
    })

    test('a step defaults to agent-manager, and says otherwise when it knows better', () => {
        expect(steps.make('j', 0, {}).source).toBe('agent-manager')
        // The capture paths set this to the AGENT that did the work, not the
        // thing that wrote it down. "Who did this" is the point of the record.
        expect(steps.make('j', 0, { source: 'audience_creation' }).source).toBe('audience_creation')
    })

    test('carries what a stage cost, including the three states of not knowing', () => {
        expect(steps.make('j', 0, { tokens_used: 1200, model: 'claude-opus-5' }).tokens_used).toBe(1200)
        // false means the harness called no model on this stage - there is
        // nothing to report and never will be.
        expect(steps.make('j', 0, { model_called: false }).model_called).toBe(false)
        // undefined means nobody said. Different fact, different chip.
        expect(steps.make('j', 0, {}).model_called).toBeUndefined()
        expect(steps.make('j', 0, {}).tokens_used).toBeUndefined()
    })

    test('provenance survives, because the narration is a reading and this is the evidence', () => {
        const prov = { upstream_task_run_id: 'tr-9', duration_ms: 812 }
        expect(steps.make('j', 0, { provenance: prov }).provenance).toEqual(prov)
    })

    test('nextOrder then make gives a step that lands after the ones already there', () => {
        const job = { steps: [steps.make('j', 0, {}), steps.make('j', 1, {})] }
        const next = steps.make('j', steps.nextOrder(job.steps), { kind: 'doc' })
        expect(next.order).toBe(2)
        expect(next.id).toBe('j::s2')
        // Ids must be distinct, or a capture overwrites the stage before it and
        // a run silently loses a step it did run.
        const ids = [...job.steps, next].map(s => s.id)
        expect(new Set(ids).size).toBe(3)
    })

    test('is callable with no fields at all', () => {
        // The capture paths run inside a catch that hides throws. A signature
        // that needs more than it declares would fail there in silence again.
        expect(() => steps.make('j', 0)).not.toThrow()
    })
})
