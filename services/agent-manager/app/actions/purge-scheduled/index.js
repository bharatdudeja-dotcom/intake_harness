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
 * Daily retention purge (D44/D45) - a non-web action invoked by an App Builder alarm
 * trigger (see app.config.yaml's daily-purge-trigger/rule), not by HTTP. It shares its
 * implementation with the on-demand `purge_expired` MCP tool (lib/retention.js) - one
 * purge, two triggers - so there is nothing purge-specific to test here beyond wiring.
 */

const { Core } = require('@adobe/aio-sdk')
const { purgeExpired } = require('../../lib/retention')

/**
 * @param {Record<string, any>} params Adobe I/O Runtime action params
 * @returns {Promise<{statusCode: number, body: object}>}
 */
async function main (params) {
    const logger = Core.Logger('purge-scheduled', { level: params.LOG_LEVEL || 'info' })
    try {
        const result = await purgeExpired()
        logger.info(`Retention purge complete: checked ${result.checked}, purged ${result.purged_steps} step(s), removed ${result.purged_recipes} empty recipe(s)`)
        return { statusCode: 200, body: result }
    } catch (error) {
        logger.error('Retention purge failed:', error)
        return { statusCode: 500, body: { error: error.message } }
    }
}

module.exports = { main }
