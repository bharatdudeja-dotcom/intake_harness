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
 * Connector-wide settings (D44/D45/D48) - data, not code.
 *
 * config/settings.json is the bundled DEFAULT (retention window). On top of it sits an
 * editable OVERRIDE persisted in the swappable store (lib/store.js), edited via the
 * update_settings tool and the dashboard's Settings panel: `retention_days`,
 * `segmentation_labels` (level key -> label), and `kind_labels` (kind id -> title). The
 * override is loaded into a small in-memory cache once per request (refresh(), called by
 * the mcp-server host wrapper) so synchronous readers - lib/steps.computeExpiry, the
 * get_segmentation_config / get_resource_policy tools - see the current values without
 * threading async through every call site.
 *
 * Internal keys (level keys, kind ids) never change - only their labels - so relabeling in
 * the UI never breaks stored data or filters (same principle as D39/D43).
 */

const rawSettings = require('../config/settings.json')
const store = require('./store')

const DEFAULT_RETENTION_DAYS = 30

/**
 * The role vocabulary. chef = default worker; head-chef = CX-graph gatekeeper; admin = manage
 * roles + admin views + settings/reset. A user may hold several.
 *
 * `viewer` (D79) is the one EXCLUSIVE role: a read-only guest/demo identity. It is not additive
 * with chef - a viewer may read everything their scope allows but is blocked from every
 * state-changing tool at a single choke point (see tools.js WRITE_TOOLS). Kept last so the
 * canonical ordering in rolesFor() reads chef -> head-chef -> admin -> viewer.
 */
const VALID_ROLES = ['chef', 'head-chef', 'admin', 'viewer']

/** @type {object} the effective override loaded from the store (empty until refresh()). */
let cache = {}

/** @type {string[]} bootstrap admin/head-chef identities from env (BOOTSTRAP_ADMINS), set per
 * request by the host wrapper so the role UI is reachable on day one (D66). */
let bootstrapAdmins = []

/**
 * Parse the BOOTSTRAP_ADMINS env value: either a JSON array string or a comma-separated list.
 * @param {string} raw
 * @returns {string[]}
 */
function parseBootstrapAdmins (raw) {
    const s = (raw && String(raw).trim()) || ''
    if (!s) return []
    let list = []
    if (s.startsWith('[')) { try { list = JSON.parse(s) } catch (e) { list = [] } } else { list = s.split(',') }
    return [...new Set(list.map(v => String(v).trim()).filter(Boolean))]
}

/** Set the bootstrap admin identities for this request (host wrapper calls this). */
function setBootstrapAdmins (rawOrList) {
    bootstrapAdmins = Array.isArray(rawOrList) ? rawOrList : parseBootstrapAdmins(rawOrList)
}

/** @returns {string[]} the current bootstrap admin identities */
function getBootstrapAdmins () {
    return bootstrapAdmins.slice()
}

/**
 * Reload the override from the store into the cache. Called once per request by the host
 * wrapper. Safe to call anywhere; falls back to {} on any read error.
 * @returns {Promise<object>} the loaded override
 */
async function refresh () {
    try {
        cache = (await store.getSettingsOverride()) || {}
    } catch (e) {
        cache = {}
    }
    return cache
}

/** For tests: set the override cache directly without a store round-trip. */
function _setCache (obj) {
    cache = obj || {}
}

/** @returns {number} days an experimental step lives before the retention purge removes it */
function getRetentionDays () {
    const override = cache && cache.retention_days
    const days = Number(override != null ? override : rawSettings.retention_days)
    return Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS
}

/** @returns {Record<string,string>} level key -> overridden label (may be empty) */
function segmentationLabelOverrides () {
    return (cache && cache.segmentation_labels) || {}
}

/** @returns {Record<string,string>} kind id -> overridden title (may be empty) */
function kindLabelOverrides () {
    return (cache && cache.kind_labels) || {}
}

/**
 * The Head Chef roster (D64): owner identities allowed to gate recipes into the Company CX
 * Graph. Config-driven for now (an editable override on top of the bundled default) - real
 * per-user enforcement needs the OAuth/RBAC org rollout. The override, when present, REPLACES
 * the default (a roster is a full list, not additive labels). Everyone not on it is a plain
 * "chef".
 * @returns {string[]} owner identities that hold the head-chef role
 */
function headChefs () {
    const override = cache && cache.head_chefs
    const raw = Array.isArray(override) ? override : rawSettings.head_chefs
    return Array.isArray(raw) ? raw.filter(v => typeof v === 'string' && v.trim()) : []
}

/**
 * The multi-role user->roles map (D66). Editable override on top of the bundled default. Each
 * value is a subset of VALID_ROLES; anyone absent is a plain ["chef"].
 * @returns {Record<string,string[]>}
 */
function userRolesMap () {
    const override = cache && cache.user_roles
    const raw = (override && typeof override === 'object') ? override : rawSettings.user_roles
    return (raw && typeof raw === 'object') ? raw : {}
}

/**
 * Effective roles for an owner identity (D66): stored roles + always chef, plus head-chef/admin
 * from the bootstrap seed and (back-compat) head-chef from the legacy head_chefs roster.
 * @param {string} owner
 * @returns {string[]}
 */
function rolesFor (owner, seedRoles = []) {
    const roles = new Set()
    const stored = userRolesMap()[owner]
    if (Array.isArray(stored)) stored.forEach(r => { if (VALID_ROLES.includes(r)) roles.add(r) })
    // Seed roles (D79) come from the caller's credential (e.g. an API key's mapped identity) and
    // are ADDITIVE - settings.user_roles above stays authoritative and admin-editable, so a role
    // granted in the UI is never clobbered by a seed and vice versa.
    if (Array.isArray(seedRoles)) seedRoles.forEach(r => { if (VALID_ROLES.includes(r)) roles.add(r) })

    // `viewer` is exclusive and read-only: it must NOT be widened into chef, or a guest identity
    // would silently gain authoring rights. Return it alone (D79).
    if (roles.has('viewer')) return ['viewer']

    roles.add('chef') // everyone else is a chef
    // The shared x-api-key path resolves to "service-account" - the trusted operator credential,
    // so it is always admin (keeps operator settings/role management working on day one, D66).
    // NOTE: admin only, NOT head-chef - head-chef stays roster-driven so it can be revoked.
    if (owner === 'service-account') roles.add('admin')
    // Bootstrap seed identities get admin+head-chef so a real human operator can act day one (D66).
    if (owner && bootstrapAdmins.includes(owner)) { roles.add('admin'); roles.add('head-chef') }
    if (owner && headChefs().includes(owner)) roles.add('head-chef') // roster (D64)
    return VALID_ROLES.filter(r => roles.has(r)) // stable canonical order
}

/** @param {string} owner @param {string} role @param {string[]} [seedRoles] @returns {boolean} */
function hasRole (owner, role, seedRoles = []) {
    return rolesFor(owner, seedRoles).includes(role)
}

/**
 * PRACTICE / CAPABILITY GROUPS (D79). A consultancy delivers across several disciplines - AEM,
 * AEP, Braze, Adobe Campaign - and a consultant in one practice mostly wants that practice's
 * knowledge. Practices are DATA, not code: editable via set_practices, so adding "Analytics" or
 * "Target" later is a settings change, never a deploy.
 *
 * Deliberately a flat, single-value label on each recipe (not a hierarchy and not overloaded onto
 * `tags`, which stay free-form): it has to be reliably filterable and it answers exactly one
 * question - "which discipline owns this knowledge?".
 * @returns {Array<{id: string, label: string}>}
 */
function practices () {
    const override = cache && cache.practices
    const raw = Array.isArray(override) ? override : rawSettings.practices
    if (!Array.isArray(raw)) return []
    return raw
        .map(p => (typeof p === 'string')
            ? { id: p.trim(), label: p.trim() }
            : (p && typeof p === 'object' && typeof p.id === 'string' && p.id.trim())
                ? { id: p.id.trim(), label: (typeof p.label === 'string' && p.label.trim()) || p.id.trim() }
                : null)
        .filter(Boolean)
}

/**
 * MCP server overrides (Workfront, AEM, AEP, ...). Settings wins over the
 * seeded config, by id, so an admin can point at a new Adobe MCP without a
 * deploy. Returns [] when nothing has been overridden.
 * @returns {object[]}
 */
function mcpServers () {
    const override = cache && cache.mcp_servers
    return Array.isArray(override) ? override : []
}

/**
 * Agent-system overrides.
 *
 * config/agent-systems.json said it was "editable from Settings" and it was
 * not: there was no override list and no setter, so wiring a second harness -
 * an agentic AEP one, say - meant editing a file inside the image and
 * redeploying. Same shape as mcpServers: the file is the seed, this is what an
 * admin changed, merged by id.
 * @returns {object[]}
 */
function agentSystems () {
    const override = cache && cache.agent_systems
    return Array.isArray(override) ? override : []
}

/** @returns {string[]} the valid practice ids */
function practiceIds () {
    return practices().map(p => p.id)
}

/**
 * The owner -> practices map (D79): which discipline(s) a consultant works in. Editable by a
 * head-chef/admin via set_user_practices. Used to DEFAULT a new recipe's practice so capture
 * stays zero-effort - an AEM consultant's work lands in AEM without them tagging anything.
 * @returns {Record<string,string[]>}
 */
function userPracticesMap () {
    const override = cache && cache.user_practices
    const raw = (override && typeof override === 'object') ? override : rawSettings.user_practices
    return (raw && typeof raw === 'object') ? raw : {}
}

/**
 * @param {string} owner
 * @returns {string[]} this owner's practices (only ids that still exist in the practice list)
 */
function practicesForOwner (owner) {
    const valid = new Set(practiceIds())
    const raw = userPracticesMap()[owner]
    return Array.isArray(raw) ? raw.filter(p => valid.has(p)) : []
}

/**
 * @param {string} owner
 * @returns {string|null} the practice a new recipe by this owner defaults to (their first), or
 *   null when they have none configured - in which case the recipe simply has no practice, which
 *   is valid (it just won't show up in a practice-filtered view).
 */
function defaultPracticeFor (owner) {
    const mine = practicesForOwner(owner)
    // Only inherit when the answer is unambiguous (D84). Picking the first of several silently
    // mislabels work: a consultant in both braze and aem had their AEM architecture filed under
    // braze, which then pollutes the practice filter that the whole feature exists to serve.
    // With more than one practice the caller passes `practice` explicitly, or it stays unset.
    return mine.length === 1 ? mine[0] : null
}

/** @param {string} owner @returns {boolean} true if this owner identity holds the head-chef role */
function isHeadChef (owner) {
    return hasRole(owner, 'head-chef')
}

/** @returns {{retention_days:number, segmentation_labels:object, kind_labels:object, head_chefs:string[]}} effective settings */
function effectiveSettings () {
    return {
        retention_days: getRetentionDays(),
        segmentation_labels: segmentationLabelOverrides(),
        kind_labels: kindLabelOverrides(),
        head_chefs: headChefs(),
        user_roles: userRolesMap(),
        practices: practices(),
        user_practices: userPracticesMap()
    }
}

module.exports = {
    refresh,
    _setCache,
    getRetentionDays,
    segmentationLabelOverrides,
    kindLabelOverrides,
    headChefs,
    isHeadChef,
    userRolesMap,
    rolesFor,
    practices,
    practiceIds,
    mcpServers,
    agentSystems,
    userPracticesMap,
    practicesForOwner,
    defaultPracticeFor,
    hasRole,
    setBootstrapAdmins,
    getBootstrapAdmins,
    parseBootstrapAdmins,
    effectiveSettings,
    VALID_ROLES,
    DEFAULT_RETENTION_DAYS
}
