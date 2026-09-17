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
 * Segmentation config (D39) - how jobs are organized by the unit of work.
 * Data, not code: config/segmentation.json declares an ordered list of levels
 * ({ key, label }); the default is Project -> Epic -> Story, and a company can
 * rename or reduce them. Internal `key`s stay stable so relabeling the UI never
 * breaks stored data or filters; only `label`s are cosmetic.
 *
 * `project` is the required top level (everything scopes by project), so a valid
 * config must include a level with key "project".
 *
 * Loaded via require() so webpack inlines it into the deployed bundle (same
 * pattern as lib/policy.js).
 */

const rawConfig = require('../config/segmentation.json')

const PROJECT_KEY = 'project'

/**
 * @param {object} config raw parsed segmentation.json
 * @returns {{levels: Array<{key: string, label: string}>}} validated config
 * @throws {Error} if the config is structurally invalid
 */
function validate (config) {
    if (!config || !Array.isArray(config.levels) || config.levels.length === 0) {
        throw new Error('Invalid segmentation.json: "levels" must be a non-empty array')
    }
    const errors = []
    const seen = new Set()
    config.levels.forEach((level, i) => {
        if (!level || typeof level.key !== 'string' || !level.key) errors.push(`levels[${i}]: missing "key"`)
        if (!level || typeof level.label !== 'string' || !level.label) errors.push(`levels[${i}]: missing "label"`)
        if (level && level.key) {
            if (seen.has(level.key)) errors.push(`levels[${i}]: duplicate key "${level.key}"`)
            seen.add(level.key)
        }
    })
    if (!seen.has(PROJECT_KEY)) {
        errors.push(`segmentation.json must include a level with key "${PROJECT_KEY}" - project is the required scoping level`)
    }
    if (errors.length) {
        throw new Error(`Invalid segmentation.json:\n${errors.join('\n')}`)
    }
    return { levels: config.levels.map(l => ({ key: l.key, label: l.label })) }
}

let validated = null

/** @returns {{levels: Array<{key: string, label: string}>}} */
function getConfig () {
    if (!validated) validated = validate(rawConfig)
    return validated
}

/** @returns {Array<{key: string, label: string}>} */
function listLevels () {
    return getConfig().levels
}

/** @returns {string[]} the ordered level keys, e.g. ['project','epic','story'] */
function levelKeys () {
    return getConfig().levels.map(l => l.key)
}

module.exports = { getConfig, listLevels, levelKeys, PROJECT_KEY }
