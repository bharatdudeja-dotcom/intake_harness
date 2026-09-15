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
 * Company CX Knowledge Graph compiler (D40/D53): the cross-owner, APPROVED-ONLY view of
 * the cookbook. Consent (certify/bake) is the gate - experimental content is a personal,
 * owner-scoped thing and never enters this graph.
 *
 * D64 (two-tier flow): baking is no longer sufficient. A baked recipe is only a CANDIDATE;
 * it enters this graph ONLY once a Head Chef admits it (cx_approved === true). Ingredients
 * shown are still approved-only. So the graph is the intersection of "consented recipe" and
 * "Head Chef-admitted" - never a recipe a chef merely baked for themselves.
 *
 * Nodes: approved recipes (+ their approved ingredients) and any handoff-prompt that
 * produced one of them. Edges: recipe→ingredient (composition), handoff→produced-recipe
 * (lineage), and recipe↔recipe links inferred from shared tag / shared segment (e.g.
 * project) / shared kind. `generated_at` stamps the compile. Compiled on demand
 * (rebuild_cx_graph) and daily (the scheduled action); the result is cached in the store
 * (get_cx_graph reads it) so the read path is cheap.
 *
 * Pure of infra/IdP/AI-vendor coupling (D21) - it only touches the storage adapter + the
 * step/status helpers.
 */

const store = require('./store')
const statusLib = require('./status')
const stepsLib = require('./steps')

/** @param {string[]} ids @returns {Array<[string,string]>} unique unordered pairs */
function pairs (ids) {
    const out = []
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) out.push([ids[i], ids[j]])
    return out
}

function projectOf (r) {
    if (r.segments && r.segments.project !== undefined) return r.segments.project
    return r.project
}

/**
 * Compile the approved-only cross-owner CX graph.
 * @param {string} [now] ISO timestamp to stamp (pass explicitly; Date is avoided elsewhere for testability)
 * @returns {Promise<object>} the graph document
 */
async function buildCxGraph (now = new Date().toISOString()) {
    // Cross-owner: NO visibleTo filter - approved is the consented, shareable layer. D64: on
    // top of consent, a Head Chef must have admitted the recipe (cx_approved === true) - baking
    // alone no longer admits it.
    const approved = (await store.listResources({ status: 'approved' }))
        .filter(r => r.type !== 'handoff-prompt' && r.cx_approved === true)

    const nodes = []
    const edges = []
    const owners = new Set()
    const projects = new Set()
    // Practices present in the graph (D84), so the CX filter can offer domains that actually
    // exist in it rather than every configured practice - a filter that returns nothing is worse
    // than no filter.
    const practices = new Set()
    const byTag = {}
    const bySegment = {}
    const byKind = {}

    for (const r of approved) {
        const project = projectOf(r)
        if (r.owner) owners.add(r.owner)
        if (project) projects.add(project)
        if (r.practice) practices.add(r.practice)
        nodes.push({
            id: r.id, node: 'recipe', label: r.title, kind: r.type,
            project, owner: r.owner || null, tags: r.tags || [],
            practice: r.practice || null,
            models: r.models_used || [], version: r.version || 1,
            // Token cost of the admitted work, so the graph can show what the knowledge cost to
            // produce. Absent (not zero) when the capturing client never reported it.
            tokens_used: typeof r.tokens_used === 'number' ? r.tokens_used : null
        })

        // Approved ingredients as child nodes (approved recipes are few - reading is bounded).
        let ingredients = []
        try { ingredients = stepsLib.ensureSteps(await store.getResource(r.id)) } catch (e) { ingredients = [] }
        for (const s of ingredients) {
            if (s.status === 'discarded' || !statusLib.isApproved(s.status)) continue
            nodes.push({ id: s.id, node: 'ingredient', label: `${r.title} · #${s.order} ${s.kind}`, recipe: r.id, kind: s.kind, signal: s.signal || null, source: s.source || null, owner: r.owner || null })
            edges.push({ from: r.id, to: s.id, rel: 'ingredient' })
        }

        for (const t of (r.tags || [])) (byTag[t] = byTag[t] || []).push(r.id)
        if (project) (bySegment[project] = bySegment[project] || []).push(r.id)
        ;(byKind[r.type] = byKind[r.type] || []).push(r.id)
    }

    const relEdges = (index, rel, keyName) => {
        for (const [key, ids] of Object.entries(index)) {
            const uniq = [...new Set(ids)]
            if (uniq.length < 2) continue
            for (const [a, b] of pairs(uniq)) edges.push({ from: a, to: b, rel, [keyName]: key })
        }
    }
    relEdges(byTag, 'shared-tag', 'tag')
    relEdges(bySegment, 'shared-segment', 'segment')
    relEdges(byKind, 'shared-kind', 'kind')

    // Lineage: handoff-prompts -> the recipe(s) they produced (D54). A handoff auto-approves
    // on capture (policy approval:"none") - it is not consented cookbook content, so it
    // never counts toward recipe_count; it is shown only as a structural provenance link
    // when it points at a recipe that IS in the approved, consented set.
    const approvedIds = new Set(approved.map(r => r.id))
    const handoffs = await store.listResources({ type: 'handoff-prompt' })
    for (const h of handoffs) {
        const deps = (h.linked_recipes || []).filter(id => approvedIds.has(id))
        if (!deps.length) continue
        nodes.push({ id: h.id, node: 'handoff', label: h.title, project: projectOf(h), owner: h.owner || null })
        for (const dep of deps) edges.push({ from: h.id, to: dep, rel: 'lineage' })
    }

    return {
        generated_at: now,
        approved_only: true,
        cross_owner: true,
        owners: [...owners],
        projects: [...projects],
        practices: [...practices],
        recipe_count: approved.length,
        node_count: nodes.length,
        edge_count: edges.length,
        nodes,
        edges
    }
}

/**
 * Rebuild + persist the CX graph (the write path for rebuild_cx_graph and the daily job).
 * @param {string} [now]
 * @returns {Promise<object>}
 */
async function rebuildAndStore (now) {
    const graph = await buildCxGraph(now)
    await store.saveCxGraph(graph)
    return graph
}

module.exports = { buildCxGraph, rebuildAndStore }
