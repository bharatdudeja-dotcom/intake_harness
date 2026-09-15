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
 * Resource Policy (D26) - "tell the AI what resources the company wants and
 * where they go." Data, not code: config/resource-policy.json declares the
 * resource types this connector accepts; this module loads, validates, and
 * queries it. An admin edits the JSON; the AI reads it via get_resource_policy;
 * the connector enforces it in save_resource (actions/mcp-server/tools.js).
 *
 * Loaded via `require()` (not fs.readFileSync) so webpack inlines the JSON into
 * the deployed action bundle - no filesystem access needed at runtime.
 */

const rawPolicy = require('../config/resource-policy.json')

const VALID_FORMATS = ['md', 'json', 'yaml', 'svg', 'png', 'mermaid', 'binary']
const VALID_APPROVALS = ['none', 'human-gate']

const MIME_TYPES = {
    md: 'text/markdown',
    json: 'application/json',
    yaml: 'application/yaml',
    svg: 'image/svg+xml',
    png: 'image/png',
    mermaid: 'text/plain',
    binary: 'application/octet-stream'
}

/**
 * @param {object} entry
 * @param {number} index
 * @returns {string[]} validation error messages (empty if the entry is valid)
 */
function validateResourceType (entry, index) {
    const errors = []
    const label = `resource-policy[${index}]${entry && entry.type ? ` (${entry.type})` : ''}`

    if (!entry || typeof entry !== 'object') {
        return [`${label}: must be an object`]
    }
    if (!entry.type || typeof entry.type !== 'string') errors.push(`${label}: missing "type"`)
    if (!entry.title || typeof entry.title !== 'string') errors.push(`${label}: missing "title"`)
    if (!entry.schema || !Array.isArray(entry.schema.fields)) errors.push(`${label}: missing "schema.fields" array`)
    if (!entry.schema || !Array.isArray(entry.schema.required)) errors.push(`${label}: missing "schema.required" array`)

    const formats = Array.isArray(entry.format) ? entry.format : [entry.format]
    if (!formats.length || formats.some(f => !VALID_FORMATS.includes(f))) {
        errors.push(`${label}: "format" must be one or more of ${VALID_FORMATS.join(', ')}`)
    }

    if (!entry.storage || typeof entry.storage !== 'string') errors.push(`${label}: missing "storage"`)
    if (!VALID_APPROVALS.includes(entry.approval)) errors.push(`${label}: "approval" must be one of ${VALID_APPROVALS.join(', ')}`)

    return errors
}

/**
 * @param {object[]} policy raw parsed resource-policy.json
 * @returns {object[]} normalized policy (format always an array)
 * @throws {Error} if the policy is structurally invalid
 */
function validateAndNormalize (policy) {
    if (!Array.isArray(policy)) {
        throw new Error('Invalid resource-policy.json: must be a JSON array of resource types')
    }

    const errors = []
    const seenTypes = new Set()
    policy.forEach((entry, index) => {
        errors.push(...validateResourceType(entry, index))
        if (entry && entry.type) {
            if (seenTypes.has(entry.type)) errors.push(`resource-policy[${index}]: duplicate type "${entry.type}"`)
            seenTypes.add(entry.type)
        }
    })

    if (errors.length) {
        throw new Error(`Invalid resource-policy.json:\n${errors.join('\n')}`)
    }

    return policy.map(entry => ({
        ...entry,
        format: Array.isArray(entry.format) ? entry.format : [entry.format]
    }))
}

let validatedPolicy = null

/** @returns {object[]} the validated, normalized resource policy (loaded + validated once) */
function loadPolicy () {
    if (!validatedPolicy) {
        validatedPolicy = validateAndNormalize(rawPolicy)
    }
    return validatedPolicy
}

/** @returns {object[]} all resource types in the policy */
function listResourceTypes () {
    return loadPolicy()
}

/** @returns {string[]} just the type ids, e.g. for building a Zod enum */
function listTypeIds () {
    return loadPolicy().map(entry => entry.type)
}

/**
 * @param {string} type
 * @returns {object|null} the policy entry for this type, or null if unknown
 */
function getResourceType (type) {
    return loadPolicy().find(entry => entry.type === type) || null
}

/**
 * @param {string} format one of VALID_FORMATS
 * @returns {string} the MIME type to advertise for this format
 */
function mimeTypeForFormat (format) {
    return MIME_TYPES[format] || 'text/plain'
}

module.exports = {
    loadPolicy,
    listResourceTypes,
    listTypeIds,
    getResourceType,
    mimeTypeForFormat,
    VALID_FORMATS,
    VALID_APPROVALS
}
