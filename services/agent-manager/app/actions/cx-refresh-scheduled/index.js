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
 * Daily company CX Knowledge Graph refresh (D40/D53) - a non-web action invoked by an App
 * Builder alarm trigger (see app.config.yaml's cx-refresh-trigger/rule), not by HTTP. It
 * shares its implementation with the on-demand rebuild_cx_graph MCP tool (lib/cx-graph.js)
 * - one compile, two triggers - so there is nothing CX-specific to test here beyond wiring.
 */

const { Core } = require('@adobe/aio-sdk')
const { rebuildAndStore } = require('../../lib/cx-graph')

/**
 * @param {Record<string, any>} params Adobe I/O Runtime action params
 * @returns {Promise<{statusCode: number, body: object}>}
 */
async function main (params) {
    const logger = Core.Logger('cx-refresh-scheduled', { level: params.LOG_LEVEL || 'info' })
    try {
        const graph = await rebuildAndStore()
        logger.info(`CX graph refreshed: ${graph.recipe_count} approved recipe(s), ${graph.node_count} node(s), ${graph.edge_count} edge(s) across ${graph.owners.length} owner(s)`)
        return { statusCode: 200, body: { generated_at: graph.generated_at, recipe_count: graph.recipe_count, node_count: graph.node_count, edge_count: graph.edge_count } }
    } catch (error) {
        logger.error('CX graph refresh failed:', error)
        return { statusCode: 500, body: { error: error.message } }
    }
}

module.exports = { main }
