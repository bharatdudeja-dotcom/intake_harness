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
 * Resource store for CX Agent Manager's run record
 * (save_resource / list_resources / search_resources / get_resource).
 *
 * Increment 1 persists each resource at resources/<id>.json and maintains a
 * lightweight metadata catalog at resources/index.json, both via
 * @adobe/aio-lib-files (App Builder-native blob storage, no external creds).
 *
 * SWAP POINT: replace this module's implementation with SharePoint via
 * Microsoft Graph in increment 2 (D13/D17). Callers only depend on the four
 * functions exported below (saveResource, getResource, listResources,
 * searchResources) plus their input/output shapes, so the swap is isolated
 * to this file.
 */

const { getStorage } = require('./storage')
const { statusMatches } = require('./status')

const RESOURCES_DIR = 'resources'
const CATALOG_PATH = `${RESOURCES_DIR}/index.json`
const WORK_CONTEXT_PATH = `${RESOURCES_DIR}/work-context.json`
const PROJECTS_PATH = `${RESOURCES_DIR}/projects.json`
const SETTINGS_PATH = `${RESOURCES_DIR}/settings.json`
const CX_GRAPH_PATH = `${RESOURCES_DIR}/cx-graph.json`
// User accounts (D81). Its own document so a settings write can never clobber credentials.
const USERS_PATH = `${RESOURCES_DIR}/users.json`
const ASSETS_DIR = 'assets'

/** MIME type -> file extension, for readable asset blob paths. Falls back to .bin. */
const EXT_FOR_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp'
}

/**
 * A segment value for a level key, tolerant of the pre-segmentation shape:
 * prefer the structured `segments` map, fall back to the legacy top-level field
 * (epic/story/project) so filters keep working across the D42 migration.
 * @param {object} entry
 * @param {string} key
 * @returns {*}
 */
function segmentValue (entry, key) {
  if (entry.segments && entry.segments[key] !== undefined) return entry.segments[key]
  return entry[key]
}

/** @returns {Promise<import('@adobe/aio-lib-files').Files>} */
async function getFiles () {
  return getStorage()
}

/**
 * @param {import('@adobe/aio-lib-files').Files} files
 * @returns {Promise<object[]>} catalog entries (metadata only)
 */
async function readCatalog (files) {
  const entries = await files.list(CATALOG_PATH)
  if (!entries || entries.length === 0) return []
  const buf = await files.read(CATALOG_PATH)
  try {
    const parsed = JSON.parse(buf.toString('utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch (e) {
    return []
  }
}

/**
 * @param {import('@adobe/aio-lib-files').Files} files
 * @param {object[]} catalog
 */
async function writeCatalog (files, catalog) {
  await files.write(CATALOG_PATH, JSON.stringify(catalog, null, 2))
}

/**
 * @param {object} resource full resource object
 * @returns {object} metadata-only projection (no content)
 */
function toMetadata (resource) {
  const {
    id, title, type, format, project, tags, author, created, updated, status, approved,
    epic, story, task, target_agent: targetAgent, task_status: taskStatus, linked_jobs: linkedJobs,
    // Increment 9 (D42) model fields:
    segments, owner, version, updated_at: updatedAt,
    approved_by: approvedBy, approved_at: approvedAt, approval_note: approvalNote,
    tokens_used: tokensUsed, tokens_last: tokensLast,
    // Increment 11/12 (D45/D47/D48): step-model job-level projections + cross-tool linkage
    job_id: jobId, baked, baked_at: bakedAt, baked_by: bakedBy,
    models_used: modelsUsed, step_count: stepCount, expires_at: expiresAt,
    // Which agents touched the run, and which of them reported success while failing.
    // Rolled up by projectJob; projected here so every list view can draw the
    // journey without loading each job's steps.
    agents, agent_faults: agentFaults,
    // Every Workfront object the run created. Projected because a person
    // approves a ticket in Workfront and then refers to this run by the id on
    // THAT ticket - so approve_intake has to be able to find a run by one
    // without loading every document in the store.
    workfront_refs: workfrontRefs,
    // The marketer's own words, kept so runs can be compared on what was
    // actually asked for rather than on a truncated title.
    brief,
    // Set by start_intake and by nothing else. Its presence is what makes a
    // record an agent run rather than something a person captured by hand, and
    // without it in the catalog the two are indistinguishable in a list.
    upstream,
    // Increment 18 (D64): Head Chef CX-graph gate - a baked job is only a CANDIDATE for the
    // Company CX Graph; cx_approved flips true when a Head Chef admits it. Projected into the
    // catalog so list_cx_pending and the CX compiler can read it without loading every full doc.
    cx_approved: cxApproved, cx_approved_by: cxApprovedBy, cx_approved_at: cxApprovedAt,
    // Practice/capability group (D79) - projected so list/search can filter without loading docs.
    practice,
    // Who this job has been handed to on one of its ingredients (D86). Projected for the same
    // reason: visibility must be decidable without reading every document.
    assigned_to: assignedTo
  } = resource
  return {
    id, title, type, format, project, tags, author, created, updated, status, approved,
    epic, story, task, target_agent: targetAgent, task_status: taskStatus, linked_jobs: linkedJobs,
    segments, owner, version, updated_at: updatedAt,
    approved_by: approvedBy, approved_at: approvedAt, approval_note: approvalNote,
    tokens_used: tokensUsed, tokens_last: tokensLast,
    job_id: jobId, baked, baked_at: bakedAt, baked_by: bakedBy,
    models_used: modelsUsed, step_count: stepCount, expires_at: expiresAt,
    agents, agent_faults: agentFaults,
    workfront_refs: workfrontRefs,
    brief,
    upstream,
    cx_approved: cxApproved, cx_approved_by: cxApprovedBy, cx_approved_at: cxApprovedAt,
    practice,
    assigned_to: assignedTo
  }
}

/**
 * Persist a full resource and upsert its metadata into the catalog.
 * @param {object} resource - full resource (id, title, type, content, project?, tags?, author, created)
 * @returns {Promise<object>} the saved metadata entry
 */
async function saveResource (resource) {
  const files = await getFiles()
  await files.write(`${RESOURCES_DIR}/${resource.id}.json`, JSON.stringify(resource, null, 2))

  const catalog = await readCatalog(files)
  const metadata = toMetadata(resource)
  const idx = catalog.findIndex(entry => entry.id === resource.id)
  if (idx >= 0) {
    catalog[idx] = metadata
  } else {
    catalog.push(metadata)
  }
  await writeCatalog(files, catalog)

  return metadata
}

/**
 * Read a full resource by id.
 * @param {string} id
 * @returns {Promise<object|null>} the full resource, or null if it doesn't exist
 */
async function getResource (id) {
  const files = await getFiles()
  const path = `${RESOURCES_DIR}/${id}.json`
  const entries = await files.list(path)
  if (!entries || entries.length === 0) return null
  const buf = await files.read(path)
  return JSON.parse(buf.toString('utf8'))
}

/**
 * Delete a resource (its full JSON and its catalog entry) - used by the retention purge
 * (D45) to remove a job left with no approved/active steps. Never called on approved
 * content by design (callers check that first). Idempotent: deleting an already-gone id
 * is a silent no-op.
 * @param {string} id
 * @returns {Promise<void>}
 */
async function deleteResource (id) {
  const files = await getFiles()
  try {
    await files.delete(`${RESOURCES_DIR}/${id}.json`)
  } catch (e) {
    // already gone - fine, purge is idempotent
  }
  const catalog = await readCatalog(files)
  const next = catalog.filter(entry => entry.id !== id)
  if (next.length !== catalog.length) {
    await writeCatalog(files, next)
  }
}

/**
 * Store a binary step asset (image/diagram) as a blob, decoded from base64 (D45's
 * faithful-capture requirement). Returns a pointer to embed on the step, not the bytes.
 * @param {string} stepId
 * @param {string} base64Data
 * @param {string} [mimeType]
 * @returns {Promise<{path: string, mime_type: string, size: number}>}
 */
async function saveAsset (stepId, base64Data, mimeType) {
  const files = await getFiles()
  const type = mimeType || 'application/octet-stream'
  const ext = EXT_FOR_MIME[type] || 'bin'
  const path = `${ASSETS_DIR}/${stepId}.${ext}`
  const buf = Buffer.from(base64Data || '', 'base64')
  await files.write(path, buf)
  return { path, mime_type: type, size: buf.length }
}

/**
 * Read a stored asset blob back out as base64 - the read half of the round trip.
 * @param {string} path as returned by saveAsset
 * @returns {Promise<string|null>} base64 content, or null if the asset is gone
 */
async function readAssetBase64 (path) {
  const files = await getFiles()
  const entries = await files.list(path)
  if (!entries || entries.length === 0) return null
  const buf = await files.read(path)
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('base64')
}

/**
 * Delete a stored asset blob (companion to deleteResource / expired-step purge).
 * Idempotent - deleting an already-gone path is a silent no-op.
 * @param {string} path
 * @returns {Promise<void>}
 */
async function deleteAsset (path) {
  const files = await getFiles()
  try {
    await files.delete(path)
  } catch (e) {
    // already gone - fine
  }
}

/**
 * Does a catalog entry pass the given filter? Shared by list + search so both
 * apply the segmentation/owner/alias-aware-status rules identically.
 * @param {object} entry
 * @param {object} filter
 * @returns {boolean}
 */
function matchesFilter (entry, filter) {
  // project/epic/story are segment-aware (structured map or legacy top-level field)
  if (filter.project && segmentValue(entry, 'project') !== filter.project) return false
  if (filter.epic && segmentValue(entry, 'epic') !== filter.epic) return false
  if (filter.story && segmentValue(entry, 'story') !== filter.story) return false
  if (filter.segments) {
    for (const [key, value] of Object.entries(filter.segments)) {
      if (value !== undefined && segmentValue(entry, key) !== value) return false
    }
  }
  if (filter.type && entry.type !== filter.type) return false
  if (filter.tag && !(entry.tags || []).includes(filter.tag)) return false
  // Practice / capability group (D79): the delivery discipline this work belongs to (aem, aep,
  // braze, campaign...). Lets an AEM consultant find AEM knowledge without wading through every
  // other practice's work, while the job stays visible cross-practice when approved.
  if (filter.practice && entry.practice !== filter.practice) return false
  // status is alias-aware: "active"=="approved", "pending"=="experimental" (D42)
  if (filter.status && !statusMatches(entry.status, filter.status)) return false
  if (filter.owner && entry.owner !== filter.owner) return false
  /*
   * Multi-tenant isolation (D40/D53, tightened in D86).
   *
   * The old rule shared anything whose status canonicalised to "approved", and because approving a
   * single ingredient auto-promotes its job, a consultant's working draft became visible to the
   * whole company the moment they approved one ingredient of it. That is not what anyone
   * approving an ingredient believes they are doing.
   *
   * A personal view now shows exactly four things:
   *   1. your own work, at any stage;
   *   2. work a Head Chef has ADMITTED to the Company CX Graph (cx_approved) - the deliberate,
   *      reviewed act that makes something company knowledge;
   *   3. work SUBMITTED for review (baked), but only to Head Chefs and admins, who need to see a
   *      candidate in order to review it;
   *   4. work explicitly ASSIGNED to you on one of its ingredients - the only way one consultant
   *      hands another visibility of something unfinished.
   */
  if (filter.visibleTo) {
    const isMine = entry.owner === filter.visibleTo
    const isAdmitted = entry.cx_approved === true
    const isAssignedToMe = (entry.assigned_to || []).includes(filter.visibleTo)
    const isSubmitted = entry.baked === true
    const canReview = filter.visibleSubmitted === true
    if (!(isMine || isAdmitted || isAssignedToMe || (isSubmitted && canReview))) return false
  }
  if (filter.task_status && entry.task_status !== filter.task_status) return false
  return true
}

/**
 * List resource metadata (no content), optionally filtered.
 * @param {{ project?: string, type?: string, tag?: string, status?: string, epic?: string, story?: string, segments?: object, owner?: string, task_status?: string }} [filter]
 * @returns {Promise<object[]>}
 */
async function listResources (filter = {}) {
  const files = await getFiles()
  const catalog = await readCatalog(files)
  return catalog.filter(entry => matchesFilter(entry, filter))
}

/**
 * Words carrying no discriminating power in a knowledge base. Dropped from a query so that
 * "how do we handle the abandoned cart" searches for the three words that matter.
 */
const SEARCH_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'is', 'it', 'we', 'do', 'how',
  'with', 'our', 'this', 'that', 'from', 'by', 'at', 'as', 'be', 'are', 'was', 'i', 'you'
])

/**
 * Split a query into searchable terms: lowercased, punctuation-stripped, stopwords removed.
 * Punctuation matters here - a title reading "eligibility, ranking, capping" must be findable
 * by the query "eligibility ranking capping".
 * @param {string} query
 * @returns {string[]} terms, or [] if the query carries no searchable content
 */
function searchTerms (query) {
  const raw = String(query || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const meaningful = raw.filter(t => t.length > 1 && !SEARCH_STOPWORDS.has(t))
  // A query of nothing but stopwords/initials still deserves an attempt - fall back to the raw
  // words rather than silently returning everything or nothing.
  return meaningful.length ? meaningful : raw
}

/**
 * Does a term appear in the haystack, tolerating the plural/singular mismatch that dominates real
 * queries? Someone searching "abandoned carts" or "phishing templates" must find a job written
 * about a "cart" and a "template". Deliberately crude - a full stemmer is not worth the dependency
 * or the surprising matches it brings; this covers the -s/-es case that actually occurs.
 * @param {string} haystack lowercased searchable text
 * @param {string} term lowercased query term
 * @returns {boolean}
 */
function termMatches (haystack, term) {
  if (haystack.includes(term)) return true
  if (term.length > 3 && term.endsWith('es') && haystack.includes(term.slice(0, -2))) return true
  if (term.length > 2 && term.endsWith('s') && haystack.includes(term.slice(0, -1))) return true
  return false
}

/**
 * Case-insensitive search over title, tags, and full content, optionally
 * narrowed by type/status/segment/owner first (same filter rules as list).
 *
 * TERM-BASED, not phrase-based (D80). A resource matches when EVERY term appears somewhere in
 * its title, tags or content. The previous implementation tested the whole query as one literal
 * substring, so any natural multi-word query - which is exactly what the server instructions ask
 * a connected AI to send before starting work - returned nothing, and the agent concluded no
 * prior art existed and rebuilt it. Found by dogfooding, not by a unit test, because a
 * single-word test query passes under both implementations.
 *
 * Results are ranked most-relevant first: an exact phrase in the title beats all terms in the
 * title, which beats a tag hit, which beats a content-only hit; ties break on recency.
 * @param {string} query
 * @param {{ type?: string, status?: string, epic?: string, story?: string, project?: string, segments?: object, owner?: string }} [filter]
 * @returns {Promise<object[]>} matching metadata entries, best match first
 */
async function searchResources (query, filter = {}) {
  const phrase = String(query || '').toLowerCase().trim()
  if (!phrase) return []
  const terms = searchTerms(phrase)
  if (!terms.length) return []

  const files = await getFiles()
  const catalog = await readCatalog(files)
  const scored = []

  for (const entry of catalog) {
    if (!matchesFilter(entry, filter)) continue

    const title = (entry.title || '').toLowerCase()
    const tags = (entry.tags || []).join(' ').toLowerCase()
    const meta = `${title} ${tags}`

    // Only pay for reading the body when the cheap fields can't already satisfy every term.
    let body = ''
    if (!terms.every(t => termMatches(meta, t))) {
      const full = await getResource(entry.id)
      body = String(full?.content || '').toLowerCase()
    }
    const haystack = `${meta} ${body}`
    const coverage = terms.filter(t => termMatches(haystack, t)).length
    if (coverage === 0) continue

    let score = 0
    if (title.includes(phrase)) score += 100
    if (terms.every(t => termMatches(title, t))) score += 50
    if (terms.some(t => termMatches(tags, t))) score += 20
    score += terms.filter(t => termMatches(title, t)).length * 5
    scored.push({ entry, score, coverage, updated: entry.updated || entry.created || '' })
  }

  // Prefer precision: if anything matches EVERY term, only those are returned. Otherwise relax
  // to near-misses rather than returning nothing, because a real question like "how do we handle
  // the abandoned cart" carries incidental words ("handle") that appear in no job - and an
  // empty result tells the agent to rebuild work that exists. The floor stays high enough that a
  // single incidental overlap never counts as a match.
  const best = Math.max(...scored.map(s => s.coverage), 0)
  const floor = best === terms.length ? terms.length : Math.max(2, Math.ceil(terms.length * 0.6))
  const kept = scored.filter(s => s.coverage >= floor)

  kept.sort((a, b) =>
    (b.coverage - a.coverage) ||
    (b.score - a.score) ||
    String(b.updated).localeCompare(String(a.updated)))
  return kept.map(s => s.entry)
}

/**
 * Read the connector-wide default work context - the active project + segment
 * defaults applied to save_resource calls that don't declare their own
 * (D33/D34/D39). Stored in the same swappable backend as the resources.
 * @returns {Promise<{project?: string, segments?: object, epic?: string, story?: string, task?: string}>} empty object if unset
 */
async function getWorkContext () {
  const files = await getFiles()
  const entries = await files.list(WORK_CONTEXT_PATH)
  if (!entries || entries.length === 0) return {}
  try {
    const parsed = JSON.parse((await files.read(WORK_CONTEXT_PATH)).toString('utf8'))
    return (parsed && typeof parsed === 'object') ? parsed : {}
  } catch (e) {
    return {}
  }
}

/**
 * Replace the connector-wide default work context (full replace, not a merge -
 * predictable for the calling AI). Accepts a `segments` map plus the legacy
 * epic/story/task fields; a top-level `project` sets the active project.
 * @param {{project?: string, segments?: object, epic?: string, story?: string, task?: string}} context
 * @returns {Promise<object>} the stored context
 */
async function setWorkContext (context = {}) {
  const files = await getFiles()
  const segments = { ...(context.segments || {}) }
  if (context.project) segments.project = context.project
  if (context.epic !== undefined) segments.epic = context.epic
  if (context.story !== undefined) segments.story = context.story
  // Drop empty values so an unset level doesn't shadow a later default.
  for (const k of Object.keys(segments)) {
    if (segments[k] === undefined || segments[k] === '' || segments[k] === null) delete segments[k]
  }
  const stored = {
    project: segments.project || undefined,
    segments,
    epic: segments.epic || undefined,
    story: segments.story || undefined,
    task: context.task || undefined,
    updated: new Date().toISOString()
  }
  await files.write(WORK_CONTEXT_PATH, JSON.stringify(stored, null, 2))
  return stored
}

/**
 * @param {import('@adobe/aio-lib-files').Files} files
 * @returns {Promise<object[]>} the projects registry
 */
async function readProjects (files) {
  const entries = await files.list(PROJECTS_PATH)
  if (!entries || entries.length === 0) return []
  try {
    const parsed = JSON.parse((await files.read(PROJECTS_PATH)).toString('utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch (e) {
    return []
  }
}

/**
 * @param {{owner?: string}} [filter] owner scopes to that owner's project records (D53 isolation)
 * @returns {Promise<object[]>} projects (all, or the given owner's)
 */
async function listProjects (filter = {}) {
  const projects = await readProjects(await getFiles())
  if (filter.owner) return projects.filter(p => !p.owner || p.owner === filter.owner)
  return projects
}

/**
 * Create a project, or select the existing one with the same name (idempotent,
 * no duplicate projects) - the "start_project" primitive (D39).
 * @param {{name: string, note?: string, owner?: string}} input
 * @returns {Promise<{id: string, name: string, note?: string, owner?: string, created: string, existed: boolean}>}
 */
async function upsertProjectByName ({ name, note, owner }) {
  const files = await getFiles()
  const projects = await readProjects(files)
  /*
   * Match on the NAME, the ID, or either one's slug.
   *
   * start_project("Comcast Xfinity Campaigns") stores that name with the id
   * `project-comcast-xfinity-campaigns`. A caller then passed the ID to
   * start_intake, where this function expects a name - so nothing matched and a
   * SECOND project appeared, called "project-comcast-xfinity-campaigns", with
   * the real runs split across the two. The dashboard showed one project with
   * the right title and no runs, and one with an ugly title and all of them.
   *
   * The two fields look interchangeable to anyone reading a listing, so they
   * are now treated as interchangeable here rather than punished with a
   * duplicate.
   */
  const slugify = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  const wanted = slugify(name)
  const existing = projects.find(p => p.name === name) ||
    projects.find(p => p.id === name) ||
    projects.find(p => slugify(p.name) === wanted || p.id === `project-${wanted}`)
  if (existing) {
    // Selecting an existing project; fill in a note if one is newly provided.
    if (note && !existing.note) {
      existing.note = note
      await files.write(PROJECTS_PATH, JSON.stringify(projects, null, 2))
    }
    return { ...existing, existed: true }
  }
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project'
  const project = { id: `project-${slug}`, name, note: note || undefined, owner: owner || undefined, status: 'active', created: new Date().toISOString() }
  projects.push(project)
  await files.write(PROJECTS_PATH, JSON.stringify(projects, null, 2))
  return { ...project, existed: false }
}

/**
 * Set a Project's lifecycle status (D45): active (Test Kitchen) -> baked -> archived.
 * @param {string} name the project name, as passed to start_project
 * @param {string} status
 * @returns {Promise<object|null>} the updated project, or null if no project has that name
 */
async function setProjectStatus (name, status) {
  const files = await getFiles()
  const projects = await readProjects(files)
  const project = projects.find(p => p.name === name)
  if (!project) return null
  project.status = status
  project.updated = new Date().toISOString()
  await files.write(PROJECTS_PATH, JSON.stringify(projects, null, 2))
  return project
}

/**
 * Read the editable settings override (D48) - retention window, segmentation label
 * overrides, kind label overrides. Stored in the same swappable backend as resources; the
 * bundled config/*.json files remain the defaults this layers on top of.
 * @returns {Promise<object>} the stored override, or {} if unset
 */
async function getSettingsOverride () {
  const files = await getFiles()
  const entries = await files.list(SETTINGS_PATH)
  if (!entries || entries.length === 0) return {}
  try {
    const parsed = JSON.parse((await files.read(SETTINGS_PATH)).toString('utf8'))
    return (parsed && typeof parsed === 'object') ? parsed : {}
  } catch (e) {
    return {}
  }
}

/**
 * Persist the settings override (full replace of the override document).
 * @param {object} settings
 * @returns {Promise<object>} the stored override
 */
async function saveSettingsOverride (settings) {
  const files = await getFiles()
  const stored = { ...(settings || {}), updated: new Date().toISOString() }
  await files.write(SETTINGS_PATH, JSON.stringify(stored, null, 2))
  return stored
}

/**
 * Read the user-account list (D81). Records contain password HASHES, never plaintext - see
 * lib/auth/users.js. Kept in its own document rather than inside settings so that a settings
 * write can never accidentally clobber credentials, and so a caller reading settings never
 * incidentally loads password material.
 * @returns {Promise<object[]>} stored users, or [] if none exist yet
 */
async function listUsers () {
  const files = await getFiles()
  const entries = await files.list(USERS_PATH)
  if (!entries || entries.length === 0) return []
  try {
    const parsed = JSON.parse((await files.read(USERS_PATH)).toString('utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch (e) {
    return []
  }
}

/**
 * Persist the full user list (callers read-modify-write the whole document).
 * @param {object[]} users
 * @returns {Promise<object[]>} the stored list
 */
async function saveUsers (users) {
  const files = await getFiles()
  const list = Array.isArray(users) ? users : []
  await files.write(USERS_PATH, JSON.stringify(list, null, 2))
  return list
}

/**
 * Reset the store to a blank slate (D51/D52): delete every job/ingredient, the catalog
 * index, all project records, the work-context, and any manifests/assets - leaving the
 * editable settings override (config) intact. Enumerates by prefix so nothing is missed.
 * @returns {Promise<{deleted: number, jobs: number, assets: number}>}
 */
async function resetAll () {
  const files = await getFiles()
  const special = new Set([CATALOG_PATH, PROJECTS_PATH, WORK_CONTEXT_PATH])
  let deleted = 0; let jobs = 0; let assets = 0
  for (const dir of [RESOURCES_DIR, ASSETS_DIR]) {
    let entries = []
    try { entries = await files.list(`${dir}/`) } catch (e) { entries = [] }
    for (const e of (entries || [])) {
      const name = typeof e === 'string' ? e : e.name
      // Keep config AND user logins: wiping demo content must never lock the team out (D81).
      if (!name || name === SETTINGS_PATH || name === USERS_PATH) continue
      try { await files.delete(name) } catch (err) { /* already gone */ }
      deleted++
      if (name.startsWith(`${ASSETS_DIR}/`)) assets++
      else if (name.endsWith('.json') && !special.has(name)) jobs++
    }
  }
  return { deleted, jobs, assets }
}

/**
 * Read the last-compiled company CX graph (D40/D53), or null if never built.
 * @returns {Promise<object|null>}
 */
async function getCxGraph () {
  const files = await getFiles()
  const entries = await files.list(CX_GRAPH_PATH)
  if (!entries || entries.length === 0) return null
  try { return JSON.parse((await files.read(CX_GRAPH_PATH)).toString('utf8')) } catch (e) { return null }
}

/**
 * Persist the compiled CX graph.
 * @param {object} graph
 * @returns {Promise<object>}
 */
async function saveCxGraph (graph) {
  const files = await getFiles()
  await files.write(CX_GRAPH_PATH, JSON.stringify(graph, null, 2))
  return graph
}

// --- OAuth login-bridge ephemeral records (D68) ---
// Short-lived, single-use transaction/grant records for the login bridge (lib/auth/oauthBridge.js).
// MUST be persisted here, not in-memory, because actions are stateless/serverless - the
// /authorize, /callback, and /token legs of one sign-in are separate invocations.
const OAUTH_TX_DIR = 'oauth-bridge/tx'
const OAUTH_GRANT_DIR = 'oauth-bridge/grant'
const OAUTH_RECORD_TTL_MS = 10 * 60 * 1000 // one sign-in attempt should complete well within 10 minutes

/**
 * @param {string} dir
 * @param {string} id
 * @param {object} data
 */
async function writeEphemeralRecord (dir, id, data) {
  const files = await getFiles()
  await files.write(`${dir}/${id}.json`, JSON.stringify({ ...data, createdAt: Date.now() }))
}

/**
 * Read a record ONCE and delete it (single-use - an authorization code/grant must not be
 * replayable). Returns null if absent or expired.
 * @param {string} dir
 * @param {string} id
 * @returns {Promise<object|null>}
 */
async function takeEphemeralRecord (dir, id) {
  const files = await getFiles()
  const path = `${dir}/${id}.json`
  const entries = await files.list(path)
  if (!entries || entries.length === 0) return null
  const buf = await files.read(path)
  try { await files.delete(path) } catch (e) { /* best-effort; a concurrent take also races here safely */ }
  let data
  try { data = JSON.parse(buf.toString('utf8')) } catch (e) { return null }
  if (!data || (Date.now() - data.createdAt) > OAUTH_RECORD_TTL_MS) return null
  return data
}

/** @param {string} txnId @param {object} data */
async function saveOAuthTransaction (txnId, data) { return writeEphemeralRecord(OAUTH_TX_DIR, txnId, data) }
/** @param {string} txnId @returns {Promise<object|null>} */
async function takeOAuthTransaction (txnId) { return takeEphemeralRecord(OAUTH_TX_DIR, txnId) }
/** @param {string} code @param {object} data */
async function saveOAuthGrant (code, data) { return writeEphemeralRecord(OAUTH_GRANT_DIR, code, data) }
/** @param {string} code @returns {Promise<object|null>} */
async function takeOAuthGrant (code) { return takeEphemeralRecord(OAUTH_GRANT_DIR, code) }

module.exports = {
  saveResource,
  getResource,
  deleteResource,
  resetAll,
  getCxGraph,
  saveCxGraph,
  listResources,
  searchResources,
  getWorkContext,
  setWorkContext,
  listProjects,
  upsertProjectByName,
  setProjectStatus,
  saveAsset,
  readAssetBase64,
  deleteAsset,
  getSettingsOverride,
  saveSettingsOverride,
  listUsers,
  saveUsers,
  saveOAuthTransaction,
  takeOAuthTransaction,
  saveOAuthGrant,
  takeOAuthGrant
}
