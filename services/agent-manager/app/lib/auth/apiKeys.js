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
 * Multi-key -> owner mapping (D55): the quick self-serve path to a second user's own
 * identity without a full OAuth login. The default `SERVICE_API_KEY` always resolves to
 * the shared `service-account` owner (unchanged); ADDITIONAL keys map to a distinct owner
 * label so a second user, given their own key, gets their own isolated identity.
 *
 * The mapping is supplied via the `API_KEY_OWNERS` env var - a JSON object of
 * `{ "<api-key>": "<owner-label>" }` - injected the same way as SERVICE_API_KEY ($VAR in
 * app.config.yaml, real values only ever in .env, never a committed file). This module is
 * pure lookup logic; it never reads env/params directly (lib/auth/config.js, the
 * designated adapter, does that and passes the raw string in).
 */

/**
 * Parse the key map. Two entry shapes are accepted (D79):
 *   "<key>": "<owner-label>"                                  - the original D55 shape
 *   "<key>": { userId?, email?, roles?: string[] }             - richer per-entity identity
 * The richer shape lets one key stand for a real person (stable id + human-readable email) and
 * carry SEED roles, so a fresh deployment has working roles before any admin edits them. Seed
 * roles are additive only - `settings.user_roles` (admin-editable via set_user_roles) remains the
 * authoritative store, so granting/revoking through the UI still works and is not overwritten.
 *
 * @param {string} [raw] the API_KEY_OWNERS env value, a JSON object string
 * @returns {Record<string, {owner: string, userId: string, email: string, roles: string[]}>}
 *   key -> identity (empty object if unset/malformed). Malformed individual entries are skipped
 *   rather than failing the whole map, so one bad entry can't lock everyone out.
 */
function parseKeyOwners (raw) {
    if (!raw) return {}
    let parsed
    try {
        parsed = JSON.parse(raw)
    } catch (e) {
        return {}
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const out = {}
    for (const [key, value] of Object.entries(parsed)) {
        if (typeof key !== 'string' || !key) continue

        if (typeof value === 'string' && value) {
            out[key] = { owner: value, userId: value, email: '', roles: [] }
            continue
        }
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const email = typeof value.email === 'string' ? value.email.trim() : ''
            const userId = typeof value.userId === 'string' ? value.userId.trim() : ''
            // Owner identity prefers email, matching how the OIDC path resolves a principal
            // (resolvePrincipal: email -> username -> user_id -> sub), so the SAME person has the
            // same owner string whether they arrive by key or by a real OAuth login.
            const owner = email || userId
            if (!owner) continue
            const roles = Array.isArray(value.roles)
                ? value.roles.filter(r => typeof r === 'string' && r.trim()).map(r => r.trim())
                : []
            out[key] = { owner, userId: userId || owner, email, roles }
        }
    }
    return out
}

/**
 * Resolve which entity an x-api-key belongs to.
 * @param {string} apiKey the presented key
 * @param {{serviceApiKey: string, apiKeyOwnersRaw?: string}} config
 * @returns {{ok: true, owner: string|null, userId?: string, email?: string, roles?: string[]}|{ok: false}}
 *   `owner` is null for the default service key (caller applies the service-account fallback);
 *   ok:false means the key is unrecognized.
 */
function resolveApiKeyOwner (apiKey, config) {
    if (config.serviceApiKey && apiKey === config.serviceApiKey) return { ok: true, owner: null }
    const entities = parseKeyOwners(config.apiKeyOwnersRaw)
    const entity = entities[apiKey]
    if (entity) {
        return { ok: true, owner: entity.owner, userId: entity.userId, email: entity.email, roles: entity.roles }
    }
    return { ok: false }
}

module.exports = { parseKeyOwners, resolveApiKeyOwner }
