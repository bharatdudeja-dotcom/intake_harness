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
 * Recipe approval status - canonical names + backward-compatible aliases (D38/D42).
 *
 * Increment 9 renamed the two statuses to match the cookbook/consent vocabulary:
 *   experimental  (was "pending")  - captured, not yet consented/approved
 *   approved      (was "active")   - a human has certified it into the cookbook
 *
 * The OLD values keep working as aliases so nothing already stored or already
 * deployed breaks: the 50 migrated recipes stay "active", the deployed Increment-8
 * dashboard still filters on "active"/"pending", and MCP Resources exposure still
 * asks for "active". `canonical()` collapses each pair to one value so a filter for
 * either spelling matches data written in either spelling.
 */

const EXPERIMENTAL = 'experimental'
const APPROVED = 'approved'

/**
 * Collapse any status spelling (new or legacy) to its canonical value.
 * Undefined/unknown is treated as approved, matching the legacy `status || 'active'`
 * default the store and dashboard used before this increment.
 * @param {string} [status]
 * @returns {'experimental'|'approved'}
 */
function canonical (status) {
    if (status === EXPERIMENTAL || status === 'pending') return EXPERIMENTAL
    if (status === APPROVED || status === 'active') return APPROVED
    return APPROVED
}

/** @returns {boolean} true if the two statuses mean the same thing across spellings */
function statusMatches (a, b) {
    return canonical(a) === canonical(b)
}

/** @param {string} [status] @returns {boolean} */
function isApproved (status) {
    return canonical(status) === APPROVED
}

/** @param {string} [status] @returns {boolean} */
function isExperimental (status) {
    return canonical(status) === EXPERIMENTAL
}

module.exports = { EXPERIMENTAL, APPROVED, canonical, statusMatches, isApproved, isExperimental }
