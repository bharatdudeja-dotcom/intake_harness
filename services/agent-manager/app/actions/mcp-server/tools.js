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
 * MCP Server Tools - the Resource Control Plane / company cookbook (D26, D30, D33)
 *
 * Host-neutral: no AI-vendor-specific code - any MCP client can call these tools.
 * Storage lives behind lib/store.js (see the // SWAP POINT there for a future backend swap).
 * The Resource Policy (config/resource-policy.json, lib/policy.js) is data, not code - it
 * declares what resource types ("recipe kinds") this connector accepts, their required
 * fields, formats, storage routing, and approval rules. save_resource enforces it;
 * get_resource_policy / list_resource_types let any AI learn it.
 *
 * Two dimensions organize every resource (D30/D33): its policy `type` (kind) and its
 * work context `epic -> story -> task` - so the cookbook is browsable by the unit of
 * work that produced a recipe, not just by kind. Work context is declared by the AI or
 * user (set_work_context / save_resource fields); an issue tracker can populate it
 * later without any coupling here.
 *
 * Everything is EXPERIMENTAL on capture and stays in the Test Kitchen until a human
 * certifies it (D38); only approved recipes enter the cookbook / MCP Resources. Recipes are
 * segmented per configurable levels (D39, default Project -> Epic -> Story; project required),
 * updated-in-place by stable id (version++ + history, not duplicated), carry a token counter
 * and an owner (D39/D40). handoff-prompt is exempt from cookbook approval (task_status lifecycle).
 *
 * Tools:
 * - get_resource_policy / list_resource_types - learn what kinds to capture and where
 * - get_segmentation_config - the ordered segmentation levels (Project/Epic/Story...)
 * - start_project      - start/select a Project + make it the active work context (D39)
 * - set_work_context   - set the active project + default segment levels for later saves
 * - save_resource      - contribute/UPDATE a recipe (policy-validated, routed, experimental
 *                        by default; upsert by stable id -> version++/history; tokens + owner)
 * - find_similar       - find existing recipes before saving, to update not duplicate
 * - approve_resource / certify - human-consent approval -> approved (records approved_by/at/note)
 * - export_as_skill    - turn an APPROVED recipe into a portable skill/prompt (D31)
 * - list_active_tasks / set_task_status / link_recipes - handoff-prompt task lifecycle (D36)
 * - list_resources     - discover recipes (metadata only), filter by project/kind/tag/status/epic/story/owner
 * - search_resources   - find recipes by keyword, same filters
 * - get_resource       - read a recipe's full content
 *
 * Also re-exposes captured resources as native MCP Resources (resources/list, resources/read,
 * a resource://company/{type}/{id} template) so any MCP client - not just the one that saved
 * it - can reuse company knowledge (extends D16).
 */

const { z } = require('zod')
const { randomUUID, createHash } = require('crypto')
const { ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js')
const store = require('../../lib/store')
const policy = require('../../lib/policy')
const skills = require('../../lib/skills')
const segmentation = require('../../lib/segmentation')
const statusLib = require('../../lib/status')
const stepsLib = require('../../lib/steps')
const retention = require('../../lib/retention')
const settings = require('../../lib/settings')
const usersLib = require('../../lib/auth/users')
const cxGraph = require('../../lib/cx-graph')
const agentSystems = require('../../lib/agent-systems')
const narrate = require('../../lib/narrate')
const mcpServers = require('../../lib/mcp-servers')
const approvalConfig = require('../../config/approval.json')

const TASK_STATUSES = ['open', 'in_progress', 'done']
const HANDOFF_TYPE = 'handoff-prompt'
/** Identity used when the caller authenticated with x-api-key (no per-user OIDC identity). */
const SERVICE_PRINCIPAL = 'service-account'
/** Material-change re-consent flag (D38); config, default true. */
const REAPPROVE_ON_CHANGE = approvalConfig.reapprove_on_change !== false

const POLICY_TYPE_IDS = policy.listTypeIds()
const SEGMENT_LEVEL_KEYS = segmentation.levelKeys()

/** @param {string} content @returns {string} short content hash for material-change detection */
function contentHash (content) {
    return createHash('sha256').update(String(content || ''), 'utf8').digest('hex').slice(0, 16)
}

/**
 * Resolve the authenticated principal (owner / approver identity). Falls back to
 * the service principal for the x-api-key path, which carries no per-user identity.
 * @param {{ userInfo?: object }} context
 * @returns {string}
 */
function resolvePrincipal (context) {
    const userInfo = context && context.userInfo
    if (!userInfo) return SERVICE_PRINCIPAL
    return userInfo.email || userInfo.username || userInfo.user_id || userInfo.sub || SERVICE_PRINCIPAL
}

/**
 * Seed roles carried by the caller's own credential (D79) - e.g. an API key mapped to a specific
 * entity. Additive only; settings.user_roles stays authoritative and admin-editable.
 * @param {{ userInfo?: object }} context
 * @returns {string[]}
 */
function credentialSeedRoles (context) {
    const roles = context && context.userInfo && context.userInfo.roles
    return Array.isArray(roles) ? roles : []
}

/**
 * The caller's full role set (D66/D79): stored roles + credential seed roles, then chef by
 * default - except `viewer`, which is exclusive and read-only.
 * @param {{ userInfo?: object }} context
 * @returns {string[]}
 */
function callerRoles (context) {
    return settings.rolesFor(resolvePrincipal(context), credentialSeedRoles(context))
}

/** @returns {boolean} whether the caller holds a given role (D66/D79) */
function callerHasRole (context, role) {
    return settings.hasRole(resolvePrincipal(context), role, credentialSeedRoles(context))
}

/**
 * May this caller see other people's SUBMITTED (baked) work? (D86)
 *
 * Head Chefs and admins must, because they cannot review a candidate they cannot open. Nobody else
 * does: a colleague's baked-but-not-yet-admitted recipe is still under review, not yet company
 * knowledge. Assignment is the separate, explicit route for sharing unfinished work.
 * @param {object} context
 * @returns {boolean}
 */
function callerCanReview (context) {
    return callerHasRole(context, 'head-chef') || callerHasRole(context, 'admin')
}

/**
 * May this caller READ this resource? (D88)
 *
 * The same four rules the store applies when listing: your own work, work admitted to the CX
 * graph, work submitted for review if you are a reviewer, and work explicitly assigned to you.
 *
 * This exists because filtering the LIST was not enough. Every read-by-id path went straight to
 * storage, so a colleague's private draft was one predictable id away: ids are
 * `recipe-<timestamp>-<slug-of-title>`, and get_resource / get_recipe / list_steps returned the
 * whole thing. Enforcing privacy only on enumeration makes it decorative.
 *
 * @param {object} resource full resource
 * @param {object} context caller identity
 * @returns {boolean}
 */
function callerCanRead (resource, context) {
    if (!resource) return false
    // A handoff-prompt is a brief addressed to someone else by design, and auto-approves on
    // capture; it is not private working content.
    if (resource.type === HANDOFF_TYPE) return true
    const me = resolvePrincipal(context)
    if (resource.owner === me || resource.author === me) return true
    if (resource.cx_approved === true) return true
    if ((resource.assigned_to || []).includes(me)) return true
    if (resource.baked === true && callerCanReview(context)) return true
    return false
}

/**
 * Whether the caller may CHANGE this resource. D88 and D99 closed the read paths, and every
 * mutation was then gated on callerCanRead - which is the wrong rule, because reading and
 * writing are not the same permission. callerCanRead says yes to anything in the CX graph, so
 * everyone could edit the shared recipes nobody owns; and save_resource had no gate at all, so
 * a peer who knew an id could overwrite a colleague's private draft, take its authorship (owner
 * was reassigned to the caller unconditionally), and leave the real author unable to read their
 * own work. Sharing something to be read is not consent to have it rewritten.
 *
 * Writing is the narrow rule: your own work, or an ingredient someone deliberately assigned you.
 * Reviewers are deliberately absent - their power is headchef_approve / headchef_reject / assign,
 * not editing the thing they are judging.
 *
 * @param {object} resource full resource
 * @param {object} context caller identity
 * @returns {boolean}
 */
function callerCanWrite (resource, context) {
    if (!resource) return false
    const me = resolvePrincipal(context)
    if (resource.owner === me || resource.author === me) return true
    if ((resource.assigned_to || []).includes(me)) return true
    return false
}

/** The single refusal for a write the caller does not own. */
function notWritableError (id) {
    return errorResult(`Refused: '${id}' is not yours to change. You may change your own recipes, and ones where its author has assigned you an ingredient. If you need to work on this, ask its author to assign you an ingredient with assign_step. If you are reviewing it, use headchef_approve or headchef_reject.`)
}

/** The single refusal message, so every read path says the same thing. */
function notVisibleError (id) {
    return errorResult(`No resource visible to you with id '${id}'. It may not exist, or it may be someone else's unfinished work: a recipe becomes readable when its author bakes it and a Head Chef admits it, or when they assign you one of its ingredients.`)
}

/**
 * Every state-changing tool (D79). Used for ONE read-only choke point rather than a guard
 * duplicated into ~20 handlers, so a newly added write tool cannot accidentally bypass the
 * `viewer` restriction - anything not listed here is treated as a read, and the list is asserted
 * against the live registration set in tests.
 */
const WRITE_TOOLS = new Set([
    'save_resource', 'start_project', 'start_recipe', 'append_step', 'set_work_context',
    'approve_resource', 'certify', 'approve_step', 'approve_steps', 'discard_step',
    'bake_recipe', 'bake_project', 'set_project_status', 'set_task_status', 'link_recipes',
    'update_settings', 'set_head_chefs', 'set_user_roles', 'set_practices', 'set_user_practices',
    'headchef_approve', 'headchef_reject',
    'rebuild_cx_graph', 'purge_expired', 'admin_reset_data',
    'create_user', 'set_user_password', 'set_user_enabled', 'change_my_password', 'delete_recipe', 'assign_step', 'unassign_step', 'set_user_display_name',
    // Starts a run upstream AND writes the captured run here.
    'start_intake',
    // Changes which MCP servers agents can reach.
    'set_mcp_server'
])

/** Guides any connected AI on reuse-first + capture behavior (MCP `initialize` instructions). */
const SERVER_INSTRUCTIONS = `This is the company MCP connector - a shared, cross-AI resource store.

Before starting new work, call search_resources or list_resources to check for relevant
prior decisions, architecture, playbooks, configuration, or code the company has already
captured - reuse before you rebuild.

Whenever you produce an artifact matching one of the company's resource-policy types (call
get_resource_policy for the full list, currently: ${POLICY_TYPE_IDS.join(', ')}), save it with
save_resource using the correct "type". It is validated against the policy and routed to the
right store automatically. Some types require human approval before becoming visible to
others (status: "pending") - that is expected behavior, not an error; a human calls
approve_resource to promote it to "active".

Everything you capture is EXPERIMENTAL by default and lives in the Test Kitchen until a
human certifies it - that is expected, not an error. Only certified/approved recipes enter
the shared cookbook. Do not expect your saves to be immediately reusable by others.

Organize work by project. At the start of a new, unrelated conversation, call start_project
with a short descriptive name (and file this session's recipes under it) - do not pile
unrelated work into one shared project. The configured segmentation levels are:
${SEGMENT_LEVEL_KEYS.join(' -> ')} (call get_segmentation_config for the labels). project is
required on every recipe; set it via start_project / set_work_context, or pass it on
save_resource. Auto-fill the other levels from the conversation. Use the project/epic/story
filters on list_resources and search_resources to find prior work in a project.

If you are refining or correcting earlier work, DO NOT create a new recipe: search_resources
(or find_similar) for the existing one and call save_resource again with its same id - it is
updated in place (a new version), not duplicated. Creating near-duplicates is the wrong move.

ONE RECIPE PER WORKING THREAD, MANY INGREDIENTS. This is the rule people get wrong most
often. If one task produces a diagram AND an architecture doc AND some code, that is ONE
recipe with three ingredients - NOT three recipes. Call start_recipe once, then append_step
for each artifact. Splitting one piece of work across several recipes makes each look
half-finished, forces each to be curated and baked separately, and means a human reviewing
your work sees fragments instead of the thing you actually built. Only call save_resource
per-artifact when the artifacts are genuinely unrelated pieces of work.

ALWAYS report cost and provenance on every capture: model (which model produced it, free
text), tokens_used (the tokens that capture consumed), and source (which client you are,
e.g. "desktop-ai", "ide-agent"). These are how the company sees what its AI work costs and
where knowledge comes from. An omitted tokens_used is NOT recorded as zero - it is recorded
as "not reported", it is excluded from every total, and it shows in the dashboard as missing
telemetry. If your host exposes usage at all, pass it; if you can only estimate, estimate.

When you generate a prompt intended for another agent or coding tool, save it as a
"handoff-prompt" with target_agent and the current work item, so it appears as an active
task - it can then be retrieved and executed outside this chat, marked in_progress/done
via set_task_status, and linked (link_recipes) to the recipes the work produced.

For a working session with more than one output worth keeping, prefer the ordered Step
model over repeated save_resource calls: call start_recipe once per working thread, then
append_step for each output as you produce it, tagging its source (which client produced
it), model (which model produced it, free text), and kind (message/code/diagram/image/
decision/doc/handoff/config/steering). Steps are appended in order and never reordered.
When you produce a diagram, append it as its own kind:"diagram" step with the mermaid/svg
source in content (not only prose) - that is what renders as a picture, not a code block.
If you authored an SVG diagram, capture the exact <svg> source verbatim as format:"svg" -
do not reconstruct it as mermaid; the dashboard renders captured SVGs inside a scope that
supplies your var(--surface-*)/var(--text-*)/var(--border*)/var(--font-*) references.
If you separately have a rendered image's base64 (e.g. an architecture screenshot), append
it as its own kind:"image" step with asset {data, mime_type}; keep both when you have them.
Embedding a \`\`\`mermaid block inside a doc/message step's markdown also renders as a
diagram, but a dedicated kind:"diagram" step is the reliable, always-captured path. Capture
how a human steered the work as a
kind:"steering" step with a signal (affirm/reject/correct) - corrections especially are
worth keeping. Mark the steps worth keeping with approve_step/approve_steps once reviewed;
only approved steps join the cookbook, in their original order, as a followable how-to -
unapproved steps expire automatically. Finalize a finished recipe with bake_recipe
(optionally approve_all). To refine a step, do not append a duplicate - this model does not
yet support in-place step edits, so treat a correction as a new step and approve the
right one.

A task can span tools: keep all of one task's outputs (chat-app brainstorming, the
coding agent's work) in ONE recipe. When you hand off to another agent, save the
handoff-prompt with recipe_id set to that task's recipe; the agent that picks it up calls
get_active_recipe(project) (or reads the recipe_id) and append_steps its work to the same
thread. save_resource remains available as a single-step shortcut for one-shot artifacts
(it always targets that recipe's first step).`

/**
 * Resolve the contributing author from the caller's IMS identity, if present.
 * @param {{ userInfo?: object }} context
 * @returns {string}
 */
function resolveAuthor (context) {
    const userInfo = context && context.userInfo
    if (!userInfo) return 'unknown'
    // IMS userinfo scope determines which fields are present: a full-profile
    // token has email/name/user_id, a minimal-scope token (e.g. CLI login) may
    // only carry the opaque `sub` claim - still a real identity, just not human-readable.
    return userInfo.email || userInfo.username || userInfo.user_id || userInfo.sub || 'unknown'
}

/**
 * Build a readable, unique resource id: `${type}-${timestamp}-${slug}`.
 * @param {string} type
 * @param {string} title
 * @returns {string}
 */
function makeResourceId (type, title) {
    const slug = String(title)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || randomUUID().slice(0, 8)
    return `${type}-${Date.now()}-${slug}`
}

/**
 * @param {object} value
 * @returns {{ content: Array<{type: 'text', text: string}> }}
 */
function jsonResult (value) {
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify(value, null, 2)
            }
        ]
    }
}

/**
 * @param {string} message
 * @returns {{ content: Array<{type: 'text', text: string}>, isError: true }}
 */
function errorResult (message) {
    return {
        content: [
            {
                type: 'text',
                text: message
            }
        ],
        isError: true
    }
}

/**
 * Recompute a recipe's flat projection from its steps (D45/D47) and attach the steps.
 * `status` is step-derived (experimental/approved) UNLESS the recipe has been baked
 * (D47), in which case `baked` is the source of truth and status shows "baked" - which
 * canonicalizes to "approved" for cookbook/MCP-resource exposure, so a baked recipe stays
 * visible even if a later experimental step or a retention purge would otherwise recompute
 * it. Timestamps are only touched when `now` is passed (save_resource preserves its own).
 * @param {object} resource
 * @param {object[]} steps
 * @param {string} [now] ISO timestamp; when given, updates updated/updated_at
 */
function projectRecipe (resource, steps, now) {
    resource.steps = steps
    resource.status = resource.baked ? 'baked' : stepsLib.recipeStatusFromSteps(steps)
    resource.content = stepsLib.composeContent(steps)
    const tokens = stepsLib.aggregateTokens(steps)
    resource.tokens_used = tokens.total
    resource.tokens_last = tokens.last
    resource.models_used = stepsLib.aggregateModels(steps)
    resource.step_count = steps.filter(s => s.status !== 'discarded').length
    resource.expires_at = stepsLib.earliestExpiry(steps) // earliest experimental-step expiry (D48 Home/Work Log lens)
    // D86: everyone assigned on any live ingredient. Rolled up to the recipe because visibility is
    // decided from the catalog, and a discarded ingredient must not keep granting access.
    const assignees = new Set()
    for (const s of steps) {
        if (s.status === 'discarded') continue
        for (const a of (s.assigned_to || [])) if (a) assignees.add(a)
    }
    resource.assigned_to = assignees.size ? [...assignees] : undefined
    if (now) { resource.updated = now; resource.updated_at = now }
}

/**
 * Validate a save_resource request against its policy entry.
 * @param {object} policyEntry
 * @param {{title: string, content: string, format?: string, project?: string, tags?: string[], fields?: object}} input
 * @returns {{ error?: string, format?: string }}
 */
function validateAgainstPolicy (policyEntry, { title, content, format, project, tags, fields }) {
    let chosenFormat = format
    if (!chosenFormat) {
        if (policyEntry.format.length === 1) {
            chosenFormat = policyEntry.format[0]
        } else {
            return { error: `Resource type '${policyEntry.type}' supports multiple formats (${policyEntry.format.join(', ')}) - specify one via the 'format' argument` }
        }
    }
    if (!policyEntry.format.includes(chosenFormat)) {
        return { error: `Invalid format '${chosenFormat}' for type '${policyEntry.type}' - must be one of ${policyEntry.format.join(', ')}` }
    }

    const candidate = { title, content, project, tags, ...fields }
    const missing = (policyEntry.schema.required || []).filter(field => {
        const value = candidate[field]
        return value === undefined || value === null || value === ''
    })
    if (missing.length) {
        return { error: `Missing required field(s) for type '${policyEntry.type}': ${missing.join(', ')}` }
    }

    return { format: chosenFormat }
}

/**
 * Register all tools with the MCP server
 * @param {McpServer} server - The MCP server instance
 * @param {{ userInfo?: object }} [context] - caller identity resolved from IMS auth, if any
 */
function registerTools (server, context = {}) {
    // READ-ONLY CHOKE POINT (D79). Wrap registration once so every write tool is gated for a
    // `viewer` identity without repeating a guard in ~20 handlers - and so a write tool added
    // later cannot silently escape the gate (WRITE_TOOLS is asserted against the live
    // registration set in tests). Reads pass through untouched, as does every non-viewer caller.
    const registerRaw = server.tool.bind(server)
    server.tool = (name, description, schema, handler) => registerRaw(name, description, schema,
        async (...handlerArgs) => {
            if (WRITE_TOOLS.has(name) && callerHasRole(context, 'viewer')) {
                return errorResult(`Refused: this is a read-only (viewer) identity, and '${name}' changes data. Ask an admin for a chef role to contribute.`)
            }
            return handler(...handlerArgs)
        })

    /**
     * Ensure a Project RECORD exists for this name (D49/D52) - project records are the
     * source of truth, so start_project / set_work_context / the first save all
     * auto-create one. Idempotent (upsert selects an existing record). Best-effort: a
     * record-write hiccup never blocks the actual save.
     * @param {string} [name]
     */
    async function ensureProject (name) {
        if (!name) return
        try { await store.upsertProjectByName({ name, owner: resolvePrincipal(context) }) } catch (e) { /* non-fatal */ }
    }

    server.tool(
        'get_resource_policy',
        'Get the full company resource policy: every resource type this connector accepts, its required fields, allowed formats, storage routing, capture trigger, and approval rule. Call this to learn what to capture and how before using save_resource. Titles reflect any Settings overrides (D48).',
        {},
        async () => {
            const overrides = settings.kindLabelOverrides()
            return jsonResult(policy.listResourceTypes().map(t => (overrides[t.type] ? { ...t, title: overrides[t.type] } : t)))
        }
    )

    server.tool(
        'list_resource_types',
        'List just the resource type ids, titles, and descriptions from the company resource policy - a lighter-weight alternative to get_resource_policy.',
        {},
        async () => {
            const overrides = settings.kindLabelOverrides()
            return jsonResult(policy.listResourceTypes().map(({ type, title, description }) => ({ type, title: overrides[type] || title, description })))
        }
    )

    server.tool(
        'save_resource',
        `Contribute a recipe to the company cookbook. Validated against the resource policy (call get_resource_policy for all kinds); routed to that kind's storage automatically. Everything is saved EXPERIMENTAL and stays in the Test Kitchen until a human certifies it - only then does it enter the shared cookbook (handoff-prompt is exempt - it uses task_status, not certification). project is required (start a project with start_project or set_work_context); other segment levels (${SEGMENT_LEVEL_KEYS.join(', ')}) are auto-filled. To refine earlier work, pass the existing recipe's id to UPDATE it in place (new version) - do not create a duplicate. Current kinds: ${POLICY_TYPE_IDS.join(', ')}.`,
        {
            type: z.enum(POLICY_TYPE_IDS).describe('Resource kind id - see get_resource_policy for the full list'),
            title: z.string().min(1).describe('Short, descriptive title for the recipe'),
            content: z.string().min(1).describe('The full content of the recipe'),
            format: z.string().optional().describe('Content format - must be one the kind allows; optional if the kind allows only one format'),
            id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,160}$/i).optional().describe('Stable recipe id. If a recipe with this id exists it is UPDATED in place (version++, prior version kept in history); otherwise created with this id. Omit for a generated id. Pass the existing id when refining earlier work - do NOT create a new recipe.'),
            project: z.string().optional().describe('Project this recipe belongs to (required unless set via start_project/set_work_context, or the kind is handoff-prompt)'),
            epic: z.string().optional().describe('Segment level: epic (defaults to the set_work_context value)'),
            story: z.string().optional().describe('Segment level: story (defaults to the set_work_context value)'),
            task: z.string().optional().describe('Optional task label within the story'),
            segments: z.record(z.string(), z.string()).optional().describe('Segment level values keyed by configured level key (see get_segmentation_config) - an alternative to the project/epic/story arguments'),
            tags: z.array(z.string()).optional().describe('Optional list of tags for discovery'),
            fields: z.record(z.string(), z.any()).optional().describe("Additional kind-specific fields required by the policy (e.g. 'system' for architecture-diagram), plus free-form provenance (source, session...)"),
            tokens_used: z.number().int().nonnegative().optional().describe('Tokens this save consumed (best-effort, AI-reported). Accumulated across a recipe\'s revisions.'),
            model: z.string().optional().describe('Free-text model identifier that produced this content (vendor-neutral), e.g. "opus-4.8". Shown per step in the dashboard.'),
            recipe_id: z.string().optional().describe('For kind "handoff-prompt": the id of the task-thread Recipe this prompt belongs to, so the agent that picks it up appends its work to the same recipe (get_active_recipe / start_recipe).'),
            target_agent: z.string().optional().describe('For kind "handoff-prompt": which agent or coding tool this prompt is for - see get_resource_policy\'s target_agents hint'),
            task_status: z.enum(TASK_STATUSES).optional().describe('For kind "handoff-prompt": the task lifecycle status - defaults to "open"')
        },
        async ({ type, title, content, format, id, project, epic, story, task, segments, tags, fields, tokens_used: tokensDelta, model, recipe_id: recipeId, target_agent: targetAgent, task_status: taskStatus }) => {
            const policyEntry = policy.getResourceType(type)
            if (!policyEntry) {
                return errorResult(`Unknown resource type '${type}'`)
            }

            const validation = validateAgainstPolicy(policyEntry, { title, content, format, project, tags, fields })
            if (validation.error) {
                return errorResult(validation.error)
            }

            // Resolve segments: explicit args/segments-map win; else the stored work-context default.
            const workCtx = await store.getWorkContext()
            const explicit = { ...(segments || {}) }
            if (project !== undefined) explicit.project = project
            if (epic !== undefined) explicit.epic = epic
            if (story !== undefined) explicit.story = story
            const resolvedSegments = {}
            const levelDefaults = workCtx.segments || {}
            for (const key of SEGMENT_LEVEL_KEYS) {
                const v = explicit[key] !== undefined ? explicit[key] : levelDefaults[key]
                if (v !== undefined && v !== '') resolvedSegments[key] = v
            }
            // carry through any explicit non-standard segment keys too (config may add levels)
            for (const [k, v] of Object.entries(explicit)) {
                if (resolvedSegments[k] === undefined && v !== undefined && v !== '') resolvedSegments[k] = v
            }
            const resolvedProject = resolvedSegments.project
            const resolvedTask = task !== undefined ? task : workCtx.task

            if (type !== HANDOFF_TYPE && !resolvedProject) {
                return errorResult('project is required: start one with start_project (or pass "project", or set it via set_work_context). The cookbook is scoped by project so unrelated work stays separate.')
            }
            // Project records are the source of truth (D49): the first save into a project
            // auto-creates its record so the dashboard lists it, no phantom-from-segments.
            await ensureProject(resolvedProject)

            if (type === HANDOFF_TYPE && taskStatus === undefined) {
                taskStatus = 'open'
            }

            const now = new Date().toISOString()
            const owner = resolvePrincipal(context)
            const author = resolveAuthor(context)
            const gated = policyEntry.approval === 'human-gate'
            const newHash = contentHash(content)

            let ownerFinal = owner
            let authorFinal = author
            let existing = null
            if (id) {
                existing = await store.getResource(id)
            } else {
                id = makeResourceId(type, title)
            }

            let created = now
            let version = 1
            let history
            let status
            let approved, approvedAt, approvedBy, approvalNote
            let tokensTotal = tokensDelta != null ? tokensDelta : undefined
            let tokensLast = tokensDelta != null ? tokensDelta : undefined
            let updatedAt
            let existed = false
            let reapproved = false
            let linkedRecipes

            if (existing) {
                // An id is a guessable string, so "pass the same id to update in place" was also
                // "pass someone else's id to overwrite their work".
                if (!callerCanWrite(existing, context)) return notWritableError(id)
                existed = true
                created = existing.created || now
                updatedAt = now
                linkedRecipes = existing.linked_recipes
                // Authorship belongs to whoever did the work, not to whoever touched it last.
                ownerFinal = existing.owner || owner
                authorFinal = existing.author || author
                const prevHash = existing.content_hash || contentHash(existing.content)
                const materialChange = prevHash !== newHash

                const prevTotal = Number(existing.tokens_used) || 0
                tokensTotal = tokensDelta != null ? prevTotal + tokensDelta : existing.tokens_used
                tokensLast = tokensDelta != null ? tokensDelta : existing.tokens_last

                history = Array.isArray(existing.history) ? existing.history.slice() : []

                if (materialChange) {
                    version = (Number(existing.version) || 1) + 1
                    // Lineage: keep the prior version's metadata (not its full content, so
                    // memory stays bounded - the whole point of update-not-duplicate).
                    history.push({
                        version: Number(existing.version) || 1,
                        title: existing.title,
                        updated_at: existing.updated_at || existing.updated || existing.created,
                        content_hash: prevHash,
                        status: existing.status,
                        approved_by: existing.approved_by,
                        approved_at: existing.approved_at,
                        tokens_used: existing.tokens_used
                    })
                    if (statusLib.isApproved(existing.status) && REAPPROVE_ON_CHANGE) {
                        // Re-consent on material change (D38): an approved recipe returns to
                        // experimental; its prior approval is preserved in history above.
                        status = statusLib.EXPERIMENTAL
                        reapproved = true
                    } else {
                        status = existing.status
                        approved = existing.approved; approvedAt = existing.approved_at
                        approvedBy = existing.approved_by; approvalNote = existing.approval_note
                    }
                } else {
                    // Metadata-only update (e.g. re-segmentation/migration): keep version,
                    // status, and approval untouched.
                    version = Number(existing.version) || 1
                    status = existing.status || (gated ? statusLib.EXPERIMENTAL : statusLib.APPROVED)
                    approved = existing.approved; approvedAt = existing.approved_at
                    approvedBy = existing.approved_by; approvalNote = existing.approval_note
                }
            } else {
                status = gated ? statusLib.EXPERIMENTAL : statusLib.APPROVED
            }

            const resource = {
                id, title, type, content, content_hash: newHash, format: validation.format,
                project: resolvedProject, segments: resolvedSegments,
                epic: resolvedSegments.epic, story: resolvedSegments.story, task: resolvedTask,
                tags, fields, owner: ownerFinal, author: authorFinal,
                created, updated: updatedAt, updated_at: updatedAt, version, status,
                approved, approved_at: approvedAt, approved_by: approvedBy, approval_note: approvalNote,
                tokens_used: tokensTotal, tokens_last: tokensLast,
                storage: policyEntry.storage,
                target_agent: targetAgent, task_status: taskStatus,
                recipe_id: recipeId !== undefined ? recipeId : (existing ? existing.recipe_id : undefined),
                baked: existing ? existing.baked : undefined,
                baked_at: existing ? existing.baked_at : undefined,
                baked_by: existing ? existing.baked_by : undefined,
                // CX-graph admission MUST survive an update-in-place (D79 bugfix). This object is a
                // full rebuild, so any field not carried over here is silently DROPPED - and losing
                // cx_approved silently evicted an already-admitted recipe from the Company CX Graph
                // the next time anyone refined it. Found by the E2E validation, not by a unit test,
                // because it only shows up in the save -> headchef_approve -> save-again sequence.
                cx_approved: existing ? existing.cx_approved : undefined,
                cx_approved_by: existing ? existing.cx_approved_by : undefined,
                cx_approved_at: existing ? existing.cx_approved_at : undefined,
                // Practice/capability group (D79): preserved on update, inherited from the
                // consultant's own practice on create - same rule as start_recipe, so a recipe
                // never silently loses the discipline that makes it findable.
                practice: existing ? existing.practice : (settings.defaultPracticeFor(owner) || undefined),
                linked_recipes: linkedRecipes,
                history: history && history.length ? history : undefined
            }

            // Increment 11 (D45): save_resource is a back-compat wrapper that always
            // targets a recipe's step at order 0. Everything above is unchanged from
            // Increment 9/10 (version/history/reapprove-on-change/tokens computed exactly
            // as before) so the single-step case - every recipe created this way, and all
            // 65 migrated recipes - behaves identically. Composing status/content/tokens
            // across ALL of the recipe's steps (not just step 0) keeps a recipe correct if
            // it later grows via append_step.
            const priorSteps = existing ? stepsLib.ensureSteps(existing) : []
            const priorStep0 = priorSteps.find(s => s.order === 0)
            const step0 = {
                id: stepsLib.makeStepId(id, 0),
                recipe_id: id,
                order: 0,
                source: (priorStep0 && priorStep0.source) || (fields && fields.source) || 'unknown',
                model: model !== undefined ? model : (priorStep0 ? priorStep0.model : undefined),
                kind: (priorStep0 && priorStep0.kind) || stepsLib.kindForType(type),
                content,
                format: validation.format,
                owner,
                tokens_used: tokensTotal,
                tokens_last: tokensLast,
                provenance: fields,
                created,
                updated: now,
                status,
                approved_by: approvedBy,
                approved_at: approvedAt,
                approval_note: approvalNote,
                expires_at: statusLib.isExperimental(status) ? stepsLib.computeExpiry(now) : undefined,
                tags
            }
            const allSteps = [step0, ...priorSteps.filter(s => s.order !== 0)]
            // step0.status already carries save_resource's version/history-aware value
            // (incl. reapprove-on-change); projectRecipe derives the recipe-level status
            // from all steps (honoring bake) and composes content/tokens/models/step_count.
            projectRecipe(resource, allSteps)

            await store.saveResource(resource)

            // D84: warn when this looks like a SIBLING of work just captured - one working thread
            // that produced several artifacts. save_resource creates one recipe per call, so an AI
            // saving an architecture-diagram and then an architecture-doc for the same task ends up
            // with two 1-ingredient recipes instead of one recipe with two ingredients. Observed
            // live: two recipes 20 seconds apart, same project, same subject, one baked and one not,
            // which made the work look half-finished to its author and to the Head Chef. This does
            // not block the save - guessing wrong must not lose someone's work - it tells the caller
            // what to do instead.
            let siblingHint
            if (!existed) {
                try {
                    siblingHint = await findRecentSibling({ id, title, project: resource.project, owner, now })
                } catch (e) { siblingHint = undefined }
            }

            return jsonResult({
                id, status, version,
                ...(existed ? { updated: true } : {}),
                ...(reapproved ? { reapproved_to_experimental: true } : {}),
                ...(siblingHint ? { warning: siblingHint } : {})
            })
        }
    )

    server.tool(
        'start_project',
        'Start (or select) a Project - the top segmentation level. Call this at the start of a new, unrelated conversation and name it, so its recipes stay separate from other work. Sets the active project for subsequent save_resource calls and returns the project id.',
        {
            name: z.string().min(1).describe('A short, descriptive project name'),
            note: z.string().optional().describe('Optional note describing the project')
        },
        async ({ name, note }) => {
            const project = await store.upsertProjectByName({ name, note, owner: resolvePrincipal(context) })
            await store.setWorkContext({ project: name })
            return jsonResult({ id: project.id, name: project.name, note: project.note, selected: project.existed })
        }
    )

    server.tool(
        'set_work_context',
        'Set the active project and default segment levels for this workspace. Applied to every subsequent save_resource that does not declare its own. Accepts project/epic/story (and a generic segments map). Call with no arguments to clear it. Values replace the previous context entirely.',
        {
            project: z.string().optional().describe('The active project'),
            epic: z.string().optional().describe('Default epic'),
            story: z.string().optional().describe('Default story'),
            task: z.string().optional().describe('Default task'),
            segments: z.record(z.string(), z.string()).optional().describe('Default segment values keyed by configured level key (alternative to project/epic/story)')
        },
        async ({ project, epic, story, task, segments }) => {
            const stored = await store.setWorkContext({ project, epic, story, task, segments })
            await ensureProject(stored.project) // project records are source of truth (D49)
            return jsonResult(stored)
        }
    )

    server.tool(
        'get_segmentation_config',
        'Get the configured segmentation levels (ordered { key, label }) - how recipes are organized by unit of work. project is the required top level; the rest are auto-filled. Labels reflect any Settings overrides (D48).',
        {},
        async () => {
            const base = segmentation.getConfig()
            const overrides = settings.segmentationLabelOverrides()
            return jsonResult({ levels: base.levels.map(l => ({ key: l.key, label: overrides[l.key] || l.label })) })
        }
    )

    server.tool(
        'find_similar',
        'Find existing recipes similar to a title or snippet BEFORE saving, so you update the right recipe instead of creating a near-duplicate. Returns lightweight matches (id, title, kind, status, segments).',
        {
            query: z.string().min(1).describe('A title or snippet to match against existing recipes'),
            project: z.string().optional().describe('Restrict to a project (recommended - scope to the current work)')
        },
        async ({ query, project }) => {
            // D99: scoped like every other search. Before this it returned any recipe in the
            // company, so a caller could discover a colleague's private work by guessing words.
            const matches = await store.searchResources(query, {
                ...(project ? { project } : {}),
                visibleTo: resolvePrincipal(context),
                visibleSubmitted: callerCanReview(context)
            })
            return jsonResult(matches.slice(0, 10).map(m => ({
                id: m.id, title: m.title, type: m.type, status: m.status, segments: m.segments || {}
            })))
        }
    )

    /**
     * Shared consent/approval handler for approve_resource + certify (D38).
     * @param {string} id
     * @param {string} [note]
     * @returns {Promise<object>}
     */
    /**
     * Look for a recipe by the same owner, in the same project, created in the last few minutes,
     * whose title covers the same subject - i.e. almost certainly another artifact from the SAME
     * working thread (D84).
     *
     * Deliberately conservative: same owner, same project, a short time window, and a real overlap
     * of meaningful title words. A false positive only ever produces an advisory string, but a
     * noisy advisory teaches callers to ignore advisories, so the bar is set high.
     *
     * @param {{id: string, title: string, project?: string, owner: string, now: string}} input
     * @returns {Promise<string|undefined>} a hint for the caller, or undefined
     */
    async function findRecentSibling ({ id, title, project, owner, now }) {
        const WINDOW_MS = 10 * 60 * 1000
        const nowMs = Date.parse(now) || Date.now()
        const words = (s) => new Set(String(s || '').toLowerCase()
            .split(/[^\p{L}\p{N}]+/u)
            .filter(w => w.length > 3 && !['with', 'from', 'that', 'this', 'into', 'record', 'system'].includes(w)))

        const mine = words(title)
        if (mine.size < 2) return undefined

        const candidates = (await store.listResources({ owner, ...(project ? { project } : {}) }))
            .filter(r => r.id !== id && r.type !== HANDOFF_TYPE)
            .filter(r => Math.abs(nowMs - (Date.parse(r.created || r.updated || '') || 0)) < WINDOW_MS)

        for (const r of candidates) {
            const theirs = words(r.title)
            const shared = [...mine].filter(w => theirs.has(w))
            // Two or more shared meaningful words, and most of the shorter title in common.
            if (shared.length >= 2 && shared.length >= Math.min(mine.size, theirs.size) * 0.5) {
                return `This looks like a second artifact from the same work as '${r.id}' ("${r.title}"), created minutes ago in the same project. ` +
                    'Both are now SEPARATE recipes with one ingredient each, which splits one piece of work in two: each looks half-finished, and each has to be curated and baked on its own. ' +
                    `If they belong together, capture the rest as INGREDIENTS of one recipe instead: append_step({recipe_id: '${r.id}', kind: 'diagram'|'doc'|'code'|..., content, model, tokens_used}). ` +
                    'Use save_resource for a NEW, distinct piece of work, or with an EXISTING id to refine that recipe in place.'
            }
        }
        return undefined
    }

    async function certifyHandler (id, note) {
        const resource = await store.getResource(id)
        if (!resource) {
            return errorResult(`No resource found with id '${id}'`)
        }
        if (resource.type === HANDOFF_TYPE) {
            return errorResult(`Resource '${id}' is a handoff-prompt, not a cookbook recipe - handoffs use set_task_status, not certification`)
        }
        if (!callerCanWrite(resource, context)) return notWritableError(id)
        // Idempotent, not an error (D79): approving any step already promotes the recipe, so a
        // caller following the documented capture -> approve -> certify order would otherwise hit
        // a hard failure for asking for a state the recipe is already in. The intent is satisfied;
        // say so, and flag that nothing changed so an agent does not report a fresh consent.
        if (statusLib.isApproved(resource.status)) {
            return jsonResult({
                id,
                status: resource.status,
                already_approved: true,
                approved_by: resource.approved_by,
                approved_at: resource.approved_at,
                note: `Already certified - no change made. Consent was recorded by ${resource.approved_by || 'a human'}${resource.approved_at ? ` at ${resource.approved_at}` : ''}.`
            })
        }
        const now = new Date().toISOString()
        const principal = resolvePrincipal(context)
        resource.approved = now // legacy field (existing dashboard reads this)
        resource.approved_at = now
        resource.approved_by = principal
        if (note) resource.approval_note = note

        // Keep step 0 in sync (D45) so the ordered-step views (get_recipe/list_steps)
        // agree with this legacy, whole-recipe consent record.
        const steps = stepsLib.ensureSteps(resource)
        const step0 = steps.find(s => s.order === 0)
        if (step0) {
            step0.status = statusLib.APPROVED
            step0.approved_by = principal
            step0.approved_at = now
            if (note) step0.approval_note = note
            step0.expires_at = undefined
        }
        projectRecipe(resource, steps, now)

        await store.saveResource(resource)
        return jsonResult({ id, status: resource.status, approved_by: principal, approved_at: now, ...(note ? { approval_note: note } : {}) })
    }

    server.tool(
        'approve_resource',
        'Certify an experimental recipe as a human consent, promoting it to "approved" so it enters the shared cookbook. Records who approved it and when. (Alias: certify.)',
        {
            id: z.string().min(1).describe('The recipe id to approve')
        },
        async ({ id }) => certifyHandler(id)
    )

    server.tool(
        'certify',
        'Certify (approve) an experimental recipe - a human consent that promotes it into the shared cookbook, recording approved_by, approved_at, and an optional note. Same effect as approve_resource, with a note.',
        {
            id: z.string().min(1).describe('The recipe id to certify'),
            note: z.string().optional().describe('Optional consent note (why it is being certified)')
        },
        async ({ id, note }) => certifyHandler(id, note)
    )

    server.tool(
        'export_as_skill',
        `Export a certified (house) recipe as a portable skill/prompt any AI can consume (D31). For a multi-step recipe this is the end-to-end REPLAY: its approved steps in order (prompts, decisions, code, diagram/image references) so another AI can redo the task (D47). Only approved/baked recipes can be exported - an experimental one must be certified or baked first. Formats: ${skills.describeFormats()}.`,
        {
            recipe_id: z.string().min(1).describe('The recipe id to export, as returned by save_resource or list_resources'),
            format: z.enum(skills.listFormats()).optional().describe('Export format - defaults to "prompt" (portable, any AI)')
        },
        async ({ recipe_id: recipeId, format }) => {
            const resource = await store.getResource(recipeId)
            if (!resource) {
                return errorResult(`No recipe found with id '${recipeId}'`)
            }
            if (!callerCanRead(resource, context)) return notVisibleError(recipeId)
            try {
                // Export the APPROVED-steps view (D45), not the full working log - a
                // multi-step recipe may still carry unreviewed drafts. A recipe with more
                // than one approved step exports as an ordered end-to-end replay walkthrough
                // (D47); a single-step recipe exports its plain content as before.
                const allSteps = stepsLib.ensureSteps(resource)
                const approvedSteps = allSteps.filter(s => s.status !== 'discarded' && statusLib.isApproved(s.status))
                const content = approvedSteps.length > 1
                    ? stepsLib.composeReplay(allSteps, { approvedOnly: true })
                    : stepsLib.composeContent(allSteps, { approvedOnly: true })
                const approvedView = { ...resource, content }
                return jsonResult(skills.exportRecipe(approvedView, format))
            } catch (e) {
                return errorResult(e.message)
            }
        }
    )

    server.tool(
        'list_active_tasks',
        'List handoff-prompts that are still open or in progress (the active-tasks queue, D36) - newest first. Use this to pick up a prompt that was handed off for another agent/coding tool to execute.',
        {},
        async () => {
            const visibleTo = resolvePrincipal(context) // personal task queue (D53)
            const visibleSubmitted = callerCanReview(context)
            const [open, inProgress] = await Promise.all([
                store.listResources({ type: 'handoff-prompt', task_status: 'open', visibleTo, visibleSubmitted }),
                store.listResources({ type: 'handoff-prompt', task_status: 'in_progress', visibleTo, visibleSubmitted })
            ])
            const active = [...open, ...inProgress].sort((a, b) => (b.created || '').localeCompare(a.created || ''))
            return jsonResult(active)
        }
    )

    server.tool(
        'set_task_status',
        'Move a handoff-prompt through its task lifecycle: open -> in_progress -> done. This is independent of the recipe\'s approval status.',
        {
            id: z.string().min(1).describe('The handoff-prompt id'),
            status: z.enum(TASK_STATUSES).describe('The new task status')
        },
        async ({ id, status }) => {
            const resource = await store.getResource(id)
            if (!resource) {
                return errorResult(`No resource found with id '${id}'`)
            }
            if (resource.type !== 'handoff-prompt') {
                return errorResult(`Resource '${id}' is a '${resource.type}', not a handoff-prompt - set_task_status only applies to handoff-prompts`)
            }
            resource.task_status = status
            await store.saveResource(resource)
            return jsonResult({ id, task_status: status })
        }
    )

    server.tool(
        'link_recipes',
        'Record lineage from a handoff-prompt to the recipe(s) it produced, once the handed-off work is done - builds the brainstorm -> build -> outcome graph (D36).',
        {
            handoff_id: z.string().min(1).describe('The handoff-prompt id'),
            recipe_ids: z.array(z.string().min(1)).min(1).describe('The id(s) of recipes this handoff produced')
        },
        async ({ handoff_id: handoffId, recipe_ids: recipeIds }) => {
            const handoff = await store.getResource(handoffId)
            if (!handoff) {
                return errorResult(`No resource found with id '${handoffId}'`)
            }
            if (handoff.type !== 'handoff-prompt') {
                return errorResult(`Resource '${handoffId}' is a '${handoff.type}', not a handoff-prompt - link_recipes only applies to handoff-prompts`)
            }
            if (!callerCanWrite(handoff, context)) return notWritableError(handoffId)
            const existing = new Set(handoff.linked_recipes || [])
            for (const recipeId of recipeIds) existing.add(recipeId)
            handoff.linked_recipes = [...existing]
            await store.saveResource(handoff)
            return jsonResult({ id: handoffId, linked_recipes: handoff.linked_recipes })
        }
    )

    server.tool(
        'list_resources',
        'Discover recipes in the cookbook. Returns metadata only (no full content) - use get_resource to read one. Filters are project-scoped by intent: pass a project to see just that project\'s work. Status filter accepts experimental/approved (pending/active still work as aliases).',
        {
            project: z.string().optional().describe('Filter by project'),
            type: z.enum(POLICY_TYPE_IDS).optional().describe('Filter by recipe kind'),
            tag: z.string().optional().describe('Filter by tag'),
            status: z.enum(['experimental', 'approved', 'pending', 'active']).optional().describe('Filter by approval status (experimental/approved; pending/active are aliases)'),
            epic: z.string().optional().describe('Filter by epic segment'),
            story: z.string().optional().describe('Filter by story segment'),
            practice: z.string().optional().describe('Filter by practice / capability group (aem, aep, braze, campaign - see list_practices)'),
            owner: z.string().optional().describe('Filter by owner (the identity that captured the recipe)')
        },
        async ({ project, type, tag, status, epic, story, owner, practice }) => {
            // Multi-tenant isolation (D53): a personal listing returns the caller's own
            // recipes plus approved (cross-owner-visible) ones. On the x-api-key path the
            // caller is the single service principal, so this is a no-op until per-user OAuth.
            const entries = await store.listResources({ project, type, tag, status, epic, story, owner, practice, visibleTo: resolvePrincipal(context), visibleSubmitted: callerCanReview(context) })
            return jsonResult(entries)
        }
    )

    server.tool(
        'search_resources',
        'Find recipes by keyword (case-insensitive over title, tags, and content), optionally scoped by project/kind/status/segment/owner. Search here BEFORE saving to update an existing recipe instead of duplicating it.',
        {
            query: z.string().min(1).describe('Keyword or phrase to search for'),
            project: z.string().optional().describe('Filter by project'),
            type: z.enum(POLICY_TYPE_IDS).optional().describe('Filter by recipe kind'),
            status: z.enum(['experimental', 'approved', 'pending', 'active']).optional().describe('Filter by approval status (experimental/approved; pending/active are aliases)'),
            epic: z.string().optional().describe('Filter by epic segment'),
            story: z.string().optional().describe('Filter by story segment'),
            practice: z.string().optional().describe('Filter by practice / capability group (aem, aep, braze, campaign - see list_practices)'),
            owner: z.string().optional().describe('Filter by owner')
        },
        async ({ query, project, type, status, epic, story, owner, practice }) => {
            const entries = await store.searchResources(query, { project, type, status, epic, story, owner, practice, visibleTo: resolvePrincipal(context), visibleSubmitted: callerCanReview(context) })
            return jsonResult(entries)
        }
    )

    server.tool(
        'get_resource',
        'Read a resource\'s full content by id from the shared company resource store.',
        {
            id: z.string().min(1).describe('The resource id, as returned by save_resource or list_resources')
        },
        async ({ id }) => {
            const resource = await store.getResource(id)
            if (!resource) {
                return errorResult(`No resource found with id '${id}'`)
            }
            if (!callerCanRead(resource, context)) return notVisibleError(id)
            return jsonResult(resource)
        }
    )

    // --- Ordered Step/Recipe model (Increment 11, D45) ---------------------------------
    // A Recipe is an ordered container of Steps within a Project. The experimental recipe
    // is the full ordered step log; its cookbook view is just the approved steps, in their
    // original order. save_resource above remains a single-step shortcut (always step 0);
    // these tools are the multi-step path for a working session with more than one output.

    server.tool(
        'start_recipe',
        'Start a new, empty ordered Recipe - a working thread/session inside a Project. You then append its outputs in order with append_step. Distinct from start_project (which selects the Project itself). The recipe is experimental until at least one of its steps is approved.',
        {
            project: z.string().min(1).describe('The project this recipe belongs to (start/select one first with start_project)'),
            title: z.string().min(1).describe('A short, descriptive title for this recipe / working thread'),
            practice: z.string().optional().describe('Practice / capability group this work belongs to (e.g. aem, aep, braze, campaign - call list_practices). Omit to inherit your own configured practice, which is the normal case.'),
            segments: z.record(z.string(), z.string()).optional().describe('Optional additional segment level values (see get_segmentation_config)')
        },
        async ({ project, title, practice, segments }) => {
            await ensureProject(project) // a task thread implies its project record exists (D49)
            const now = new Date().toISOString()
            const owner = resolvePrincipal(context)
            const id = makeResourceId('recipe', title)
            const resolvedSegments = { ...(segments || {}), project }
            // Practice (D79): an explicit value wins, else inherit the consultant's own practice so
            // an AEM consultant's work lands in AEM with zero extra effort. An unknown id is a hard
            // error rather than silently stored, or the filter would quietly miss this recipe.
            const resolvedPractice = practice || settings.defaultPracticeFor(owner)
            if (practice && !settings.practiceIds().includes(practice)) {
                return errorResult(`Unknown practice '${practice}'. Valid: ${settings.practiceIds().join(', ') || '(none configured)'} - see list_practices.`)
            }
            const resource = {
                id,
                title,
                type: 'recipe',
                content: '',
                content_hash: contentHash(''),
                project,
                practice: resolvedPractice || undefined,
                segments: resolvedSegments,
                owner,
                author: resolveAuthor(context),
                created: now,
                updated: now,
                updated_at: now,
                version: 1,
                status: statusLib.EXPERIMENTAL,
                steps: []
            }
            await store.saveResource(resource)
            return jsonResult({ id, title, project, practice: resolvedPractice || null, status: resource.status, created: now })
        }
    )

    /* -----------------------------------------------------------------
       Agent systems: the bridge between a marketer's brief and the
       upstream pipeline that executes it.

       start_intake is the one tool a marketer's assistant actually needs.
       The others are for seeing what is registered.
       ----------------------------------------------------------------- */

    server.tool(
        'list_agent_systems',
        'List the upstream agent systems registered with Agent Manager - one per executing system, each bound to a domain and an adapter. Use this to see what can run a brief. Agent names are NOT listed here; call list_system_agents, which reads them from the upstream itself.',
        {},
        async () => jsonResult(agentSystems.list())
    )

    server.tool(
        'list_system_agents',
        "List the agents an upstream system actually has, read live from that system's own catalog rather than from any list held here. An agent added upstream appears immediately, with nothing changed on this side.",
        {
            system_id: z.string().optional().describe('Which system. Omit when only one is active.')
        },
        async ({ system_id: systemId }) => {
            const { system, error } = agentSystems.resolve(systemId)
            if (error) return errorResult(error)
            try {
                return jsonResult({ system: system.id, agents: await agentSystems.discoverAgents(system) })
            } catch (e) {
                return errorResult(`Could not reach ${system.id}: ${e.message}`)
            }
        }
    )

    server.tool(
        'start_intake',
        "Start a campaign intake from a marketer's brief in plain English. Hands the brief to the upstream agent pipeline, waits for it, and logs every stage as artifacts of ONE run so the whole thing is reviewable afterwards. Returns the run id, what each agent did, and anything that failed - including a tool failure an agent reported as a success. Use this rather than calling the upstream directly, or nothing is captured.",
        {
            brief: z.string().min(1).describe("The marketer's brief, in their own words"),
            title: z.string().optional().describe('A short title for the run. Defaults to the first line of the brief.'),
            project: z.string().optional().describe('Programme this run belongs to. Defaults to the active work context.'),
            system_id: z.string().optional().describe('Which agent system to run it on. Omit when only one is active.'),
            wait_ms: z.number().int().min(0).max(120000).optional().describe('How long to wait for the pipeline before returning what it has so far. Default 25000.')
        },
        async ({ brief, title, project, system_id: systemId, wait_ms: waitMs }) => {
            const { system, error } = agentSystems.resolve(systemId)
            if (error) return errorResult(error)

            const now = new Date().toISOString()
            const owner = resolvePrincipal(context)
            const runTitle = title || brief.split('\n')[0].slice(0, 120)
            const workContext = await store.getWorkContext(owner)
            const resolvedProject = project || (workContext && workContext.project)
            if (!resolvedProject) {
                return errorResult('No programme set. Pass project, or call start_project first.')
            }

            let started
            try {
                started = await agentSystems.startRun(system, brief)
            } catch (e) {
                return errorResult(`${system.id} refused the brief: ${e.message}`)
            }

            const id = makeResourceId('recipe', runTitle)
            const resource = {
                id,
                title: runTitle,
                type: 'recipe',
                content: '',
                content_hash: contentHash(''),
                project: resolvedProject,
                practice: system.practice || settings.defaultPracticeFor(owner) || undefined,
                segments: { project: resolvedProject },
                owner,
                author: resolveAuthor(context),
                created: now,
                updated: now,
                updated_at: now,
                version: 1,
                status: statusLib.EXPERIMENTAL,
                // The upstream run is REFERENCED, never joined. Their database stays
                // theirs; this is a typed pointer we resolve through the adapter.
                upstream: { system_id: system.id, run_id: started.upstream_run_id },
                steps: []
            }

            const addStep = (kind, content, extra = {}) => {
                const order = stepsLib.nextOrder(resource.steps)
                const at = new Date().toISOString()
                resource.steps.push({
                    id: stepsLib.makeStepId(id, order),
                    recipe_id: id,
                    order,
                    source: 'agent-manager',
                    kind,
                    content,
                    status: statusLib.EXPERIMENTAL,
                    created: at,
                    expires_at: stepsLib.computeExpiry(at),
                    ...extra
                })
            }

            // Artifact 0 is the brief, verbatim. Everything downstream is judged
            // against it, so it is captured before any agent touches it.
            addStep('message', narrate.narrateBrief(brief, system), { format: 'md', tags: ['brief'] })

            const waited = await agentSystems.waitForRun(
                system, started.upstream_run_id, { timeoutMs: waitMs == null ? 25000 : waitMs }
            )
            const steps = agentSystems.toSteps(waited.envelope)
            const agents = await agentSystems.discoverAgents(system).catch(() => [])
            const labelFor = (agentId) => {
                const hit = agents.find(a => a.id === agentId)
                return (hit && hit.label) || agentId
            }

            for (const st of steps) {
                // Markdown, not a JSON dump. A record nobody can read is not a
                // record - see lib/narrate.js.
                addStep('doc', narrate.narrateStep(st, labelFor(st.agent_id)), {
                    format: 'md',
                    tags: ['agent', st.agent_id].concat(st.embedded_error ? ['silent-failure'] : []),
                    provenance: {
                        upstream_task_run_id: st.upstream_task_run_id,
                        duration_ms: st.duration_ms,
                        started_at: st.started_at,
                        finished_at: st.finished_at,
                        // Exactly what the upstream sent and received, verbatim.
                        // The narration is a reading of this; this is the evidence.
                        upstream_payload: {
                            agent: st.agent_id,
                            upstream_status: st.upstream_status,
                            input: st.input,
                            output: st.output,
                            metadata: st.metadata
                        }
                    }
                })
            }

            // Where the time went, and what is unresolved. Written every run.
            addStep('decision', narrate.narrateLedger(steps, { labelFor, settled: waited.settled }), {
                format: 'md', tags: ['ledger']
            })

            resource.content = stepsLib.composeContent(resource.steps)
            resource.content_hash = contentHash(resource.content)
            resource.step_count = resource.steps.length
            await store.saveResource(resource)

            const faults = steps.filter(st => st.embedded_error)

            return jsonResult({
                run_id: id,
                upstream: { system_id: system.id, run_id: started.upstream_run_id },
                upstream_status: (waited.envelope && waited.envelope.run && waited.envelope.run.status) || 'unknown',
                settled: waited.settled,
                stages: steps.map(st => ({
                    agent: labelFor(st.agent_id),
                    reported: st.upstream_status,
                    // What the stage ACTUALLY did, which is not always what it reported.
                    actual: st.embedded_error ? 'faulted' : st.upstream_status,
                    failure: st.embedded_error || undefined,
                    ms: st.duration_ms
                })),
                loop_count: agentSystems.loopCount(steps),
                // Stated explicitly so an assistant repeats it to the marketer
                // instead of reporting a green run.
                warnings: faults.map(f => `${labelFor(f.agent_id)} reported "${f.upstream_status}" but its tool call failed: ${f.embedded_error}`),
                note: waited.settled
                    ? undefined
                    : 'The pipeline had not finished when this returned. Call get_intake with the run_id for the rest.'
            })
        }
    )

    server.tool(
        'get_intake',
        'Re-read an intake run from its upstream and return where each stage got to. Use after start_intake when the pipeline had not finished, or to check a run later.',
        {
            run_id: z.string().min(1).describe('The Agent Manager run id returned by start_intake')
        },
        async ({ run_id: runId }) => {
            const resource = await store.getResource(runId)
            if (!resource) return errorResult(`No run found with id '${runId}'`)
            const ref = resource.upstream
            if (!ref || !ref.run_id) return errorResult(`Run '${runId}' has no upstream reference`)
            const { system, error } = agentSystems.resolve(ref.system_id)
            if (error) return errorResult(error)

            let envelope
            try {
                envelope = await agentSystems.getRun(system, ref.run_id)
            } catch (e) {
                return errorResult(`Could not reach ${system.id}: ${e.message}`)
            }
            const steps = agentSystems.toSteps(envelope)
            return jsonResult({
                run_id: runId,
                upstream: ref,
                upstream_status: (envelope && envelope.run && envelope.run.status) || 'unknown',
                loop_count: agentSystems.loopCount(steps),
                stages: steps.map(st => ({
                    agent: st.agent_id,
                    reported: st.upstream_status,
                    actual: st.embedded_error ? 'faulted' : st.upstream_status,
                    failure: st.embedded_error || undefined,
                    ms: st.duration_ms
                }))
            })
        }
    )

    /* -----------------------------------------------------------------
       MCP servers. Adobe ships one per product - Workfront, AEM, AEP -
       and more will arrive. Each is a registry entry with an endpoint,
       editable here and in Settings, never a branch in code.
       ----------------------------------------------------------------- */

    server.tool(
        'list_mcp_servers',
        'List the MCP servers Agent Manager can reach - Workfront, AEM, AEP and any other. Shows each one\'s endpoint, domain, whether it is active and whether its credential is configured. Never returns the credential itself.',
        {},
        async () => {
            const overrides = settings.mcpServers()
            const servers = mcpServers.listSafe(overrides)
            return jsonResult(servers.map(s => ({
                ...s,
                ready: mcpServers.readiness(mcpServers.get(s.id, overrides)).ready,
                blocked_because: mcpServers.readiness(mcpServers.get(s.id, overrides)).reason
            })))
        }
    )

    server.tool(
        'set_mcp_server',
        'ADMIN: add or update an MCP server. Use this to point Agent Manager at a new Adobe MCP - Workfront, AEM, AEP - without a deploy. Only the fields you pass are changed. Put real tokens in the environment and reference them as ${ENV_VAR} rather than pasting them here.',
        {
            id: z.string().min(1).describe('Stable key, e.g. workfront-adobe'),
            label: z.string().optional().describe('What people see'),
            practice: z.string().optional().describe('Domain it belongs to: workfront | aep | aem'),
            endpoint: z.string().optional().describe('Base URL of the MCP server'),
            auth: z.string().optional().describe('Authorization header value, or ${ENV_VAR} to read it from the environment. Blank when the server owns auth.'),
            instance: z.string().optional().describe('Tenant, where the server needs one (Workfront)'),
            active: z.boolean().optional().describe('Off leaves it registered but unused')
        },
        async (args) => {
            if (!callerHasRole(context, 'admin')) {
                return errorResult('Only an admin may change MCP servers.')
            }
            const overrides = settings.mcpServers()
            const existing = overrides.find(s => s.id === args.id) || { id: args.id }
            const merged = { ...existing }
            for (const [k, v] of Object.entries(args)) if (v !== undefined) merged[k] = v

            const next = overrides.filter(s => s.id !== args.id).concat([merged])
            const current = await store.getSettingsOverride()
            const stored = await store.saveSettingsOverride({ ...current, mcp_servers: next })
            settings._setCache(stored)

            const resolved = mcpServers.get(args.id, next)
            const state = mcpServers.readiness(resolved)
            return jsonResult({
                saved: mcpServers.listSafe(next).find(s => s.id === args.id),
                ready: state.ready,
                blocked_because: state.reason
            })
        }
    )

    server.tool(
        'check_mcp_server',
        'Ask an MCP server what tools it exposes. Use it to verify a server actually answers before pointing an agent at it, and to find the real name of a tool rather than guessing one.',
        {
            id: z.string().min(1).describe('The server id, from list_mcp_servers'),
            contains: z.string().optional().describe('Only return tool names containing this string')
        },
        async ({ id, contains }) => {
            const overrides = settings.mcpServers()
            const srv = mcpServers.get(id, overrides)
            if (!srv) return errorResult(`No MCP server registered with id '${id}'`)
            try {
                const tools = await mcpServers.listTools(srv)
                const names = tools.map(t => t.name).filter(n => !contains || n.includes(contains))
                return jsonResult({ id, endpoint: srv.endpoint, tool_count: tools.length, tools: names.slice(0, 200) })
            } catch (e) {
                // Reported as a failure, not as an empty list. An unreachable
                // server and a server with no tools are different problems.
                return errorResult(`${id} did not answer: ${e.message}`)
            }
        }
    )

    server.tool(
        'append_step',
        'Append the next ordered Step to a Recipe (started with start_recipe) - the atomic capture primitive. Steps are appended in order and never reshuffled. Text kinds (message/code/decision/doc/handoff/config, and diagram when captured as mermaid/svg source) use "content"; image/rendered-diagram kinds use "asset" (base64 + mime_type) - give both together to keep a diagram\'s source alongside its rendered image. Use kind "steering" with a "signal" (affirm/reject/correct) to capture how a human steered the work (a correction is prime capture). New steps are EXPERIMENTAL and expire after the retention window unless approved (approve_step/approve_steps).',
        {
            recipe_id: z.string().min(1).describe('The recipe id to append to, as returned by start_recipe'),
            source: z.string().optional().describe('Free text: which client produced this step, e.g. "desktop-ai", "ide-agent", "cli-agent" - vendor-neutral; defaults to "unknown"'),
            model: z.string().optional().describe('Free-text model identifier that produced this step (vendor-neutral), e.g. "opus-4.8"'),
            kind: z.enum(['message', 'code', 'diagram', 'image', 'decision', 'doc', 'handoff', 'config', 'steering', 'other']).describe('What kind of output this step captures'),
            signal: z.enum(['affirm', 'reject', 'correct']).optional().describe('For kind "steering": affirm (approved/allowed), reject (denied), or correct (edited/redirected)'),
            content: z.string().optional().describe('Text content. Required unless "asset" is given.'),
            asset: z.object({
                data: z.string().min(1).describe('Base64-encoded binary content'),
                mime_type: z.string().min(1).describe('MIME type, e.g. image/png, image/svg+xml')
            }).optional().describe('Binary artifact (image, or a rendered diagram) - stored as a blob asset'),
            format: z.string().optional().describe('Content format hint, e.g. md, mermaid, svg, png, diff'),
            language: z.string().optional().describe('For kind "code": the programming language'),
            diff: z.string().optional().describe('For kind "code": an optional unified diff'),
            tokens_used: z.number().int().nonnegative().optional().describe('Tokens this step consumed (best-effort, AI-reported)'),
            tags: z.array(z.string()).optional().describe('Optional tags for discovery'),
            provenance: z.record(z.string(), z.any()).optional().describe('Optional free-form provenance (session id, tool version, anchor...)')
        },
        async ({ recipe_id: recipeId, source, model, kind, signal, content, asset, format, language, diff, tokens_used: tokensUsed, tags, provenance }) => {
            // A steering step is self-describing via its signal; other kinds need content or an asset.
            if (!content && !asset && kind !== 'steering') {
                return errorResult('Provide "content" or "asset" - a step needs at least one')
            }
            const resource = await store.getResource(recipeId)
            if (!resource) {
                return errorResult(`No recipe found with id '${recipeId}' - start one with start_recipe`)
            }
            if (!callerCanWrite(resource, context)) return notWritableError(recipeId)
            const steps = stepsLib.ensureSteps(resource)
            const order = stepsLib.nextOrder(steps)
            const now = new Date().toISOString()
            const owner = resolvePrincipal(context)
            const stepId = stepsLib.makeStepId(recipeId, order)

            let assetPointer
            if (asset) {
                assetPointer = await store.saveAsset(stepId, asset.data, asset.mime_type)
            }

            const step = {
                id: stepId,
                recipe_id: recipeId,
                order,
                source: source || 'unknown',
                model,
                kind,
                signal: kind === 'steering' ? signal : undefined,
                content,
                asset: assetPointer,
                language,
                diff,
                format,
                owner,
                tokens_used: tokensUsed,
                tokens_last: tokensUsed,
                provenance,
                created: now,
                updated: now,
                status: statusLib.EXPERIMENTAL,
                expires_at: stepsLib.computeExpiry(now),
                tags
            }

            const nextSteps = [...steps, step]
            projectRecipe(resource, nextSteps, now)
            await store.saveResource(resource)

            return jsonResult({ id: step.id, recipe_id: recipeId, order, kind, signal: step.signal, status: step.status, expires_at: step.expires_at })
        }
    )

    /**
     * Shared step-approval handler for approve_step/approve_steps (D45).
     * @param {string[]} stepIds
     * @param {string} [note]
     * @returns {Promise<object[]>} one result per requested step id
     */
    async function approveStepsHandler (stepIds, note) {
        const now = new Date().toISOString()
        const principal = resolvePrincipal(context)
        const results = []
        const byRecipe = new Map()
        for (const stepId of stepIds) {
            const parsed = stepsLib.parseStepId(stepId)
            if (!parsed) {
                results.push({ id: stepId, error: `Not a valid step id: '${stepId}'` })
                continue
            }
            if (!byRecipe.has(parsed.recipeId)) byRecipe.set(parsed.recipeId, [])
            byRecipe.get(parsed.recipeId).push(stepId)
        }

        for (const [recipeId, ids] of byRecipe) {
            const resource = await store.getResource(recipeId)
            if (!resource) {
                for (const stepId of ids) results.push({ id: stepId, error: `No recipe found for step '${stepId}'` })
                continue
            }
            if (!callerCanWrite(resource, context)) {
                for (const stepId of ids) results.push({ id: stepId, error: `Refused: '${recipeId}' is not yours to change` })
                continue
            }
            const steps = stepsLib.ensureSteps(resource)
            let changed = false
            for (const stepId of ids) {
                const step = steps.find(s => s.id === stepId)
                if (!step) {
                    results.push({ id: stepId, error: `No step found with id '${stepId}'` })
                    continue
                }
                if (step.status === 'discarded') {
                    results.push({ id: stepId, error: 'Cannot approve a discarded step' })
                    continue
                }
                step.status = statusLib.APPROVED
                step.approved_by = principal
                step.approved_at = now
                if (note) step.approval_note = note
                step.expires_at = undefined
                changed = true
                results.push({ id: stepId, status: statusLib.APPROVED, approved_by: principal, approved_at: now })
            }
            if (changed) {
                projectRecipe(resource, steps, now)
                await store.saveResource(resource)
            }
        }
        return results
    }

    server.tool(
        'approve_step',
        'Certify a single Step as a human consent, promoting it to "approved" - it joins its recipe\'s cookbook view (in order) and is kept forever. Records approved_by/at and an optional note.',
        {
            step_id: z.string().min(1).describe('The step id, as returned by append_step/get_recipe/list_steps'),
            note: z.string().optional().describe('Optional consent note')
        },
        async ({ step_id: stepId, note }) => {
            const [result] = await approveStepsHandler([stepId], note)
            return result.error ? errorResult(result.error) : jsonResult(result)
        }
    )

    server.tool(
        'approve_steps',
        'Certify several Steps at once (same effect as calling approve_step repeatedly, one consent note for all of them).',
        {
            step_ids: z.array(z.string().min(1)).min(1).describe('The step ids to approve'),
            note: z.string().optional().describe('Optional consent note applied to all of them')
        },
        async ({ step_ids: stepIds, note }) => jsonResult(await approveStepsHandler(stepIds, note))
    )

    server.tool(
        'discard_step',
        'Discard a Step - it is excluded from the recipe\'s full and approved views (e.g. a draft that turned out not to be useful). An already-approved step cannot be discarded (it is kept forever once certified). Idempotent.',
        {
            step_id: z.string().min(1).describe('The step id to discard')
        },
        async ({ step_id: stepId }) => {
            const parsed = stepsLib.parseStepId(stepId)
            if (!parsed) return errorResult(`Not a valid step id: '${stepId}'`)
            const resource = await store.getResource(parsed.recipeId)
            if (!resource) return errorResult(`No recipe found for step '${stepId}'`)
            if (!callerCanWrite(resource, context)) return notWritableError(parsed.recipeId)
            const steps = stepsLib.ensureSteps(resource)
            const step = steps.find(s => s.id === stepId)
            if (!step) return errorResult(`No step found with id '${stepId}'`)
            if (statusLib.isApproved(step.status)) {
                return errorResult(`Step '${stepId}' is already approved - approved steps are kept forever and cannot be discarded`)
            }
            step.status = 'discarded'
            step.expires_at = undefined
            projectRecipe(resource, steps, new Date().toISOString())
            await store.saveResource(resource)
            return jsonResult({ id: stepId, status: 'discarded' })
        }
    )

    server.tool(
        'get_recipe',
        'Read a Recipe as its ordered Steps. view="full" (default) returns every non-discarded step in order - the full working log, including experimental drafts (the Test Kitchen view). view="approved" returns only approved steps in order - the composed, followable cookbook recipe. Image/diagram asset steps include their base64 data.',
        {
            id: z.string().min(1).describe('The recipe id'),
            view: z.enum(['full', 'approved']).optional().describe('Defaults to "full"')
        },
        async ({ id, view }) => {
            const resource = await store.getResource(id)
            if (!resource) {
                return errorResult(`No recipe found with id '${id}'`)
            }
            if (!callerCanRead(resource, context)) return notVisibleError(id)
            const steps = stepsLib.ensureSteps(resource)
                .filter(s => s.status !== 'discarded')
                .sort((a, b) => a.order - b.order)
            const filtered = view === 'approved' ? steps.filter(s => statusLib.isApproved(s.status)) : steps
            const hydrated = await Promise.all(filtered.map(async s => {
                if (!s.asset || !s.asset.path) return s
                const data = await store.readAssetBase64(s.asset.path)
                return { ...s, asset: { ...s.asset, data } }
            }))
            return jsonResult({
                id: resource.id,
                title: resource.title,
                project: resource.project,
                segments: resource.segments,
                owner: resource.owner,
                status: resource.status,
                created: resource.created,
                updated: resource.updated_at || resource.updated,
                version: resource.version,
                view: view || 'full',
                // D89: the rollups the catalog already carries. get_recipe is the primary
                // read-one-recipe tool, and it was the only view that could not answer "what stage
                // is this at, what did it cost, which models produced it" without a second call.
                practice: resource.practice,
                baked: resource.baked === true,
                cx_approved: resource.cx_approved === true,
                step_count: resource.step_count,
                tokens_used: resource.tokens_used,
                models_used: resource.models_used || [],
                assigned_to: resource.assigned_to || [],
                steps: hydrated
            })
        }
    )

    server.tool(
        'list_recipes',
        'List Recipes (metadata only - title/project/status/owner/version/practice, no step content), optionally filtered by project, status and/or practice. Excludes handoff-prompts (task briefs, not recipes). Filter by practice to see just one discipline\'s knowledge (e.g. practice:"aem").',
        {
            project: z.string().optional().describe('Filter by project'),
            status: z.enum(['experimental', 'approved', 'pending', 'active']).optional().describe('Filter by approval status'),
            practice: z.string().optional().describe('Filter by practice / capability group (aem, aep, braze, campaign - see list_practices)')
        },
        async ({ project, status, practice }) => {
            const entries = await store.listResources({ project, status, practice, visibleTo: resolvePrincipal(context), visibleSubmitted: callerCanReview(context) })
            return jsonResult(entries.filter(e => e.type !== HANDOFF_TYPE))
        }
    )

    server.tool(
        'list_practices',
        'List the configured practices / capability groups (e.g. AEM, AEP, Braze, Adobe Campaign) and which ones YOU belong to. Practices are how knowledge stays findable per discipline: filter list_recipes / search_resources / list_resources by practice to see just that discipline\'s work. Read-only, safe for anyone.',
        {},
        async () => jsonResult({
            practices: settings.practices(),
            my_practices: settings.practicesForOwner(resolvePrincipal(context)),
            my_default_practice: settings.defaultPracticeFor(resolvePrincipal(context)),
            note: 'A new recipe inherits your first practice unless you pass an explicit practice.'
        })
    )

    server.tool(
        'set_practices',
        'ADMIN ONLY: replace the list of practices / capability groups the company delivers (e.g. add "analytics" or "target"). Full replace - pass the complete list. Practices are data, so adding one is a settings change, not a deploy. Existing recipes keep their practice id even if you relabel it.',
        {
            practices: z.array(z.object({
                id: z.string().min(1).describe('Stable short id, lowercase (e.g. "aem") - never change this once recipes use it'),
                label: z.string().min(1).describe('Human-readable label shown in the UI (e.g. "AEM")')
            })).describe('The complete practice list')
        },
        async ({ practices: next }) => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may change the practice list.')
            const ids = next.map(p => p.id.trim().toLowerCase())
            const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
            if (dupes.length) return errorResult(`Duplicate practice id(s): ${[...new Set(dupes)].join(', ')}`)
            const clean = next.map(p => ({ id: p.id.trim().toLowerCase(), label: p.label.trim() }))
            const current = await store.getSettingsOverride()
            const stored = await store.saveSettingsOverride({ ...current, practices: clean })
            settings._setCache(stored)
            return jsonResult({ practices: settings.practices() })
        }
    )

    server.tool(
        'set_user_practices',
        'HEAD CHEF or ADMIN: set which practices a consultant belongs to. Their first practice is what their new recipes inherit by default, so this is what makes per-discipline capture automatic. Full replace for that user; pass an empty array to clear.',
        {
            owner: z.string().min(1).describe('The consultant\'s owner identity (email/username, as shown by get_my_roles)'),
            practices: z.array(z.string()).describe('The practice ids this consultant works in, most-primary first (see list_practices)')
        },
        async ({ owner, practices: next }) => {
            if (!callerHasRole(context, 'head-chef') && !callerHasRole(context, 'admin')) {
                return errorResult('Refused: only a Head Chef or admin may assign practices.')
            }
            const valid = settings.practiceIds()
            const unknown = next.filter(p => !valid.includes(p))
            if (unknown.length) return errorResult(`Unknown practice id(s): ${unknown.join(', ')}. Valid: ${valid.join(', ') || '(none configured)'}`)
            const current = await store.getSettingsOverride()
            const map = { ...(current.user_practices || {}) }
            const key = owner.trim()
            if (next.length) map[key] = [...new Set(next)]; else delete map[key]
            const stored = await store.saveSettingsOverride({ ...current, user_practices: map })
            settings._setCache(stored)
            return jsonResult({ owner: key, practices: settings.practicesForOwner(key), user_practices: settings.userPracticesMap() })
        }
    )

    server.tool(
        'list_steps',
        'List every non-discarded Step of a Recipe, in order, with lightweight asset pointers (no binary payload - use get_recipe for full asset bytes).',
        {
            recipe_id: z.string().min(1).describe('The recipe id')
        },
        async ({ recipe_id: recipeId }) => {
            const resource = await store.getResource(recipeId)
            if (!resource) {
                return errorResult(`No recipe found with id '${recipeId}'`)
            }
            if (!callerCanRead(resource, context)) return notVisibleError(recipeId)
            const steps = stepsLib.ensureSteps(resource)
                .filter(s => s.status !== 'discarded')
                .sort((a, b) => a.order - b.order)
                .map(s => ({ ...s, asset: s.asset ? { path: s.asset.path, mime_type: s.asset.mime_type, size: s.asset.size } : undefined }))
            return jsonResult(steps)
        }
    )

    server.tool(
        'get_active_recipe',
        'Resolve the active Recipe (task thread) for a project - the most recently updated, not-yet-baked recipe - so a second tool (e.g. a coding agent picking up a handoff) appends its work to the SAME recipe instead of starting a new one (D47). Returns null-ish if the project has no open recipe yet.',
        {
            project: z.string().min(1).describe('The project to resolve the active recipe for')
        },
        async ({ project }) => {
            // D99: YOUR active recipe. It used to resolve across all owners, so it could return a
            // colleague's open recipe and then invite the caller to append ingredients to it.
            const entries = await store.listResources({ project, type: 'recipe', owner: resolvePrincipal(context) })
            const open = entries
                .filter(r => !r.baked && r.status !== 'archived')
                .sort((a, b) => (b.updated_at || b.updated || b.created || '').localeCompare(a.updated_at || a.updated || a.created || ''))
            const active = open[0]
            if (!active) return jsonResult({ project, active_recipe: null })
            return jsonResult({ project, active_recipe: { id: active.id, title: active.title, status: active.status, step_count: active.step_count } })
        }
    )

    server.tool(
        'bake_recipe',
        'Finalize a Recipe (D47): experimental -> baked. With approve_all=true, first certifies every non-discarded step (records consent), so the recipe\'s followable cookbook view = its approved steps in order. A baked recipe stays in the cookbook even as later drafts come and go. Distinct from bake_project (which finalizes the whole engagement).',
        {
            id: z.string().min(1).describe('The recipe id to bake'),
            approve_all: z.boolean().optional().describe('Approve all non-discarded steps as part of baking (default false - bake as-is, only already-approved steps are followable)'),
            note: z.string().optional().describe('Optional consent note recorded on the steps approved by approve_all')
        },
        async ({ id, approve_all: approveAll, note }) => {
            const resource = await store.getResource(id)
            if (!resource) {
                return errorResult(`No recipe found with id '${id}'`)
            }
            if (resource.type === HANDOFF_TYPE) {
                return errorResult(`Resource '${id}' is a handoff-prompt, not a recipe - use set_task_status`)
            }
            // Baking submits work for review, which shows it to every reviewer. That is the
            // author's decision to make, and nobody else's.
            if (!callerCanWrite(resource, context)) return notWritableError(id)
            const now = new Date().toISOString()
            const principal = resolvePrincipal(context)
            const steps = stepsLib.ensureSteps(resource)
            // D64 baking rule: you cannot bake a recipe with no approved ingredients. The
            // default path requires the human to have approved >= 1 ingredient in the Work Log
            // first (no auto-approve). approve_all=true is the explicit "approve them as part of
            // baking" path for API callers, and still needs >= 1 non-discarded ingredient to
            // approve - you can't bake an empty recipe either way.
            const nonDiscarded = steps.filter(s => s.status !== 'discarded')
            const approvedExisting = nonDiscarded.filter(s => statusLib.isApproved(s.status))
            if (!approveAll && approvedExisting.length === 0) {
                return errorResult('Cannot bake: this recipe has no approved ingredients. Approve at least one ingredient first (or pass approve_all=true to approve them as part of baking).')
            }
            if (approveAll && nonDiscarded.length === 0) {
                return errorResult('Cannot bake: this recipe has no ingredients to approve.')
            }
            let approvedCount = 0
            if (approveAll) {
                for (const step of steps) {
                    if (step.status === 'discarded' || statusLib.isApproved(step.status)) {
                        if (statusLib.isApproved(step.status)) approvedCount++
                        continue
                    }
                    step.status = statusLib.APPROVED
                    step.approved_by = principal
                    step.approved_at = now
                    if (note) step.approval_note = note
                    step.expires_at = undefined
                    approvedCount++
                }
            } else {
                approvedCount = steps.filter(s => statusLib.isApproved(s.status)).length
            }
            resource.baked = true
            resource.baked_at = now
            resource.baked_by = principal
            projectRecipe(resource, steps, now) // status -> 'baked' (resource.baked is now true)
            await store.saveResource(resource)
            return jsonResult({ id, baked: true, baked_at: now, baked_by: principal, status: resource.status, approved_steps: approvedCount })
        }
    )

    server.tool(
        'bake_project',
        'Mark a Project "baked" - the consultant\'s signal that it is fully cooked (its Test Kitchen work is done). The project keeps its recipes; this just moves it out of the active working set.',
        {
            project: z.string().min(1).describe('The project name, as passed to start_project')
        },
        async ({ project }) => {
            const updated = await store.setProjectStatus(project, 'baked')
            if (!updated) return errorResult(`No project named '${project}' - start one with start_project first`)
            return jsonResult(updated)
        }
    )

    server.tool(
        'set_project_status',
        'Set a Project\'s lifecycle status directly: active (Test Kitchen) -> baked -> archived.',
        {
            project: z.string().min(1).describe('The project name, as passed to start_project'),
            status: z.enum(['active', 'baked', 'archived']).describe('The new lifecycle status')
        },
        async ({ project, status }) => {
            const updated = await store.setProjectStatus(project, status)
            if (!updated) return errorResult(`No project named '${project}' - start one with start_project first`)
            return jsonResult(updated)
        }
    )

    server.tool(
        'list_projects',
        'List Projects with their lifecycle status (active/baked/archived). Scoped to the caller\'s own project records (D53 isolation); the single service principal on the x-api-key path.',
        {},
        async () => jsonResult(await store.listProjects({ owner: resolvePrincipal(context) }))
    )

    server.tool(
        'purge_expired',
        'Run the retention purge on demand: deletes expired EXPERIMENTAL steps (past the retention window) and any recipe left with no approved/active steps as a result. Approved content is never touched. Idempotent - safe to call repeatedly (this also runs automatically on a daily schedule).',
        {},
        async () => jsonResult(await retention.purgeExpired())
    )

    server.tool(
        'get_settings',
        'Read the connector\'s editable settings (D48): the retention window (days) plus the current segmentation level labels and kind labels (with any overrides applied), and the editable keys/ids so an admin UI can render a form. Reading is safe for anyone.',
        {},
        async () => {
            const eff = settings.effectiveSettings()
            return jsonResult({
                retention_days: eff.retention_days,
                segmentation_levels: segmentation.getConfig().levels.map(l => ({
                    key: l.key, label: eff.segmentation_labels[l.key] || l.label, default_label: l.label
                })),
                kinds: policy.listResourceTypes().map(t => ({
                    type: t.type, label: eff.kind_labels[t.type] || t.title, default_label: t.title, description: t.description, approval: t.approval
                })),
                head_chefs: eff.head_chefs // D64: the config-driven Head Chef roster (see get_role/set_head_chefs)
            })
        }
    )

    server.tool(
        'update_settings',
        'Update the connector\'s editable settings (D48): retention_days, segmentation label overrides, and/or kind label overrides. Only the fields you pass are changed (partial update); internal keys/ids are never changed, only their labels. GUARDED WRITE - through the dashboard this runs under the shared service key; per-user RBAC is a later increment.',
        {
            retention_days: z.number().int().positive().optional().describe('Days an experimental step lives before the retention purge removes it (must be > 0)'),
            segmentation_labels: z.record(z.string(), z.string()).optional().describe('Level key -> new label (e.g. { "epic": "Workstream" }); keys must be existing segmentation level keys'),
            kind_labels: z.record(z.string(), z.string()).optional().describe('Kind id -> new label (e.g. { "decision": "ADR" }); keys must be existing resource-policy type ids')
        },
        async ({ retention_days: retentionDays, segmentation_labels: segLabels, kind_labels: kindLabels }) => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may edit settings.')
            const current = await store.getSettingsOverride()
            const next = { ...current }

            if (retentionDays !== undefined) next.retention_days = retentionDays

            if (segLabels) {
                const validKeys = new Set(segmentation.levelKeys())
                const bad = Object.keys(segLabels).filter(k => !validKeys.has(k))
                if (bad.length) return errorResult(`Unknown segmentation level key(s): ${bad.join(', ')} (valid: ${[...validKeys].join(', ')})`)
                next.segmentation_labels = { ...(current.segmentation_labels || {}), ...segLabels }
            }
            if (kindLabels) {
                const validTypes = new Set(POLICY_TYPE_IDS)
                const bad = Object.keys(kindLabels).filter(k => !validTypes.has(k))
                if (bad.length) return errorResult(`Unknown kind id(s): ${bad.join(', ')} (valid: ${[...validTypes].join(', ')})`)
                next.kind_labels = { ...(current.kind_labels || {}), ...kindLabels }
            }

            const stored = await store.saveSettingsOverride(next)
            settings._setCache(stored) // reflect immediately within this request
            return jsonResult(settings.effectiveSettings())
        }
    )

    server.tool(
        'admin_list_recipes',
        'ADMIN (D55, scoped in D98): recipes across all owners that have been SUBMITTED for review or ADMITTED to the Company CX Graph, plus your own work and anything assigned to you. It does NOT show other people\'s private drafts: an admin reviews what people chose to submit, and nobody reads unsubmitted work belonging to someone else. Optional project/status/owner filters.',
        {
            project: z.string().optional().describe('Filter by project'),
            status: z.enum(['experimental', 'approved', 'pending', 'active']).optional().describe('Filter by approval status'),
            owner: z.string().optional().describe('Narrow to one owner (see the owner labels in any listing)')
        },
        async ({ project, status, owner }) => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: admin cross-owner listing requires the admin role.')
            /*
             * D98: this used to pass no visibility filter at all, so an admin read every private
             * draft in the company. Being able to administer a system is not the same as being
             * entitled to read unfinished work, and a consultant who has not submitted something
             * has not offered it to anyone. The admin view now uses exactly the same four rules as
             * every other read path, with the reviewer allowance that lets a head chef or admin
             * open a SUBMITTED candidate in order to review it.
             */
            const entries = await store.listResources({
                project,
                status,
                owner,
                visibleTo: resolvePrincipal(context),
                visibleSubmitted: true
            })
            return jsonResult(entries.filter(e => e.type !== HANDOFF_TYPE))
        }
    )

    server.tool(
        'admin_list_projects',
        'ADMIN (D55): list Project records across ALL owners (personal list_projects scopes to the caller). Same guard posture as admin_list_recipes.',
        {},
        async () => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: admin cross-owner listing requires the admin role.')
            return jsonResult(await store.listProjects())
        }
    )

    server.tool(
        'admin_reset_data',
        'DESTRUCTIVE ADMIN RESET (D52): delete ALL recipes/ingredients, the catalog index, all project records, the work-context, and stored assets - leaving tools/model/config (incl. the settings override) intact. Requires confirm=true. Not available through the dashboard proxy; x-api-key/admin only.',
        {
            confirm: z.boolean().describe('Must be true - a guard against accidental wipes')
        },
        async ({ confirm }) => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may reset the data store.')
            if (confirm !== true) {
                return errorResult('Refusing to reset: pass confirm=true to delete all recipes, ingredients, projects, and the catalog (config is preserved).')
            }
            const result = await store.resetAll()
            return jsonResult({ reset: true, ...result })
        }
    )

    server.tool(
        'get_role',
        'Report the caller\'s role(s) (D64/D66): "chef" (everyone by default), "head-chef" (admits baked recipes into the Company CX Graph), and/or "admin" (manage roles, admin views, settings/reset). Also returns the resolved owner identity, the full roles array, and the head-chef roster. Read-only, safe for anyone. NOTE: roles bind to owner identity - on the shared x-api-key path the owner is a single service account, so real per-user enforcement arrives once an OAuth provider is wired (D66/Phase 2).',
        {},
        async () => {
            const roles = callerRoles(context)
            return jsonResult({
                owner: resolvePrincipal(context),
                role: roles.includes('head-chef') ? 'head-chef' : 'chef', // back-compat scalar (D64)
                roles, // D66 full set
                head_chefs: settings.headChefs(),
                enforcement: 'roles bind to owner identity; per-user identity enforcement is real once an OAuth provider is wired (D66/Phase 2)'
            })
        }
    )

    server.tool(
        'get_my_roles',
        'Report just the caller\'s resolved owner identity and role set (D66) - a lightweight self-check for the dashboard. Read-only, safe for anyone.',
        {},
        async () => jsonResult({ owner: resolvePrincipal(context), roles: callerRoles(context) })
    )

    server.tool(
        'list_user_roles',
        'ADMIN ONLY (D66): list the stored user->roles assignments (owner identity -> roles[]), plus the effective roster derived views (head-chefs, bootstrap admins). Guarded: only an admin caller may list. Read-only.',
        {},
        async () => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may view role assignments.')
            return jsonResult({
                user_roles: settings.userRolesMap(),
                head_chefs: settings.headChefs(),
                bootstrap_admins: settings.getBootstrapAdmins(),
                valid_roles: settings.VALID_ROLES
            })
        }
    )

    server.tool(
        'set_user_roles',
        'ADMIN ONLY (D66): set the complete role set for one owner identity (multi-role allowed: any of chef/head-chef/admin). Full replace for that owner. Persisted as a settings override. Guarded: only an admin caller may assign roles. Passing an empty array resets the owner to the default (chef).',
        {
            owner: z.string().min(1).describe('The owner identity (email/username/sub, or "service-account") to assign roles to'),
            roles: z.array(z.enum(['chef', 'head-chef', 'admin'])).describe('The complete role set for this owner (multi-role). Empty = reset to default chef.')
        },
        async ({ owner, roles }) => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may assign roles.')
            const clean = [...new Set(roles.filter(r => settings.VALID_ROLES.includes(r)))]
            const current = await store.getSettingsOverride()
            const map = { ...(current.user_roles || {}) }
            if (clean.length) map[owner.trim()] = clean; else delete map[owner.trim()]
            const stored = await store.saveSettingsOverride({ ...current, user_roles: map })
            settings._setCache(stored)
            return jsonResult({ owner: owner.trim(), roles: settings.rolesFor(owner.trim()), user_roles: settings.userRolesMap() })
        }
    )

    // ── User accounts (D81) ──────────────────────────────────────────────────────────────────
    // An admin creates a login id + password per consultant, and that login identifies them in
    // both the dashboard and their AI client. Replaces the shared deployment passcode, which
    // proved only that someone was allowed in, never who they were. Passwords are scrypt-hashed
    // by lib/auth/users.js and never stored, returned or logged in plaintext.

    server.tool(
        'create_user',
        'ADMIN ONLY (D81): create a Cookbook login for a consultant - a login id and password they use to sign in to the dashboard and to connect their AI client. Optionally assigns roles and practices at the same time, so a new joiner is productive immediately. The password is hashed on write and is NEVER retrievable afterwards: capture it at creation time and hand it over securely.',
        {
            id: z.string().min(2).describe('Login id, e.g. "jesse.pinkman" (case-insensitive; letters, numbers, dot, dash, underscore)'),
            password: z.string().min(8).describe('Initial password (minimum 8 characters). Stored only as a scrypt hash.'),
            email: z.string().optional().describe('Work email - becomes the owner identity that authors their recipes, and matches them to the same person if SSO is enabled later. Strongly recommended.'),
            display_name: z.string().optional().describe('Human-readable name, e.g. "Jesse Pinkman"'),
            roles: z.array(z.enum(['chef', 'head-chef', 'admin', 'viewer'])).optional().describe('Roles to grant. Omit for a normal consultant (chef). "viewer" is exclusive and read-only.'),
            practices: z.array(z.string()).optional().describe('Practice/capability group ids this consultant works in (call list_practices). Their recipes inherit the first one.')
        },
        async ({ id, password, email, display_name: displayName, roles, practices }) => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may create Cookbook logins.')

            const practiceIds = settings.practiceIds()
            for (const p of (practices || [])) {
                if (!practiceIds.includes(p)) {
                    return errorResult(`Unknown practice id '${p}'. Configured practices: ${practiceIds.join(', ') || '(none)'}. Add it with set_practices first.`)
                }
            }

            const users = await store.listUsers()
            const wanted = usersLib.normalizeId(id)
            if (users.some(u => usersLib.normalizeId(u.id) === wanted)) {
                return errorResult(`A login with id '${wanted}' already exists. Use set_user_password to reset it, or pick a different id.`)
            }

            const built = usersLib.buildUser({ id, password, email, display_name: displayName, roles, practices, created_by: resolvePrincipal(context) })
            if (!built.ok) return errorResult(built.error)

            await store.saveUsers([...users, built.user])

            // Roles and practices live in settings (authoritative and separately editable), so the
            // account creation and the authorisation it implies stay consistent.
            const current = await store.getSettingsOverride()
            const next = { ...current }
            if (roles && roles.length) {
                const clean = [...new Set(roles.filter(r => settings.VALID_ROLES.includes(r)))]
                next.user_roles = { ...(current.user_roles || {}), [built.user.owner]: clean }
            }
            if (practices && practices.length) {
                next.user_practices = { ...(current.user_practices || {}), [built.user.owner]: [...new Set(practices)] }
            }
            if (next.user_roles || next.user_practices) {
                const stored = await store.saveSettingsOverride(next)
                settings._setCache(stored)
            }

            return jsonResult({
                created: usersLib.publicUser(built.user),
                roles: settings.rolesFor(built.user.owner, built.user.roles),
                practices: settings.practicesForOwner(built.user.owner),
                // Everything the new user needs to connect, so the caller can hand over one bundle.
                connection: {
                    login_id: built.user.id,
                    dashboard: 'Sign in at the Cookbook dashboard with this login id and password.',
                    mcp_header: `x-cookbook-login: ${built.user.id}:<password>`,
                    note: 'The password is not stored in retrievable form. If it is lost, an admin resets it with set_user_password.'
                }
            })
        }
    )

    server.tool(
        'list_users',
        'ADMIN ONLY (D81): list Cookbook logins with their roles, practices and who created them. Never returns password material of any kind.',
        {},
        async () => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may list Cookbook logins.')
            const users = await store.listUsers()
            return jsonResult(users.map(u => ({
                ...usersLib.publicUser(u),
                effective_roles: settings.rolesFor(u.owner || u.id, u.roles),
                effective_practices: settings.practicesForOwner(u.owner || u.id)
            })))
        }
    )

    server.tool(
        'list_people',
        'The company name directory (D96): each person\'s owner identity and their display name. Readable by anyone signed in, and deliberately narrow: no password material, no roles, no account state. Use it to show people by name instead of guessing a name from their email address, and to offer a valid list when assigning work.',
        {},
        async () => {
            const users = await store.listUsers()
            return jsonResult(users
                .filter(u => !u.disabled)
                .map(u => ({
                    id: u.id,
                    owner: u.owner || u.id,
                    // Fall back to the login id rather than inventing a name from the email.
                    display_name: u.display_name || u.id
                }))
                .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name))))
        }
    )

    server.tool(
        'set_user_display_name',
        'ADMIN ONLY (D96): correct how a person\'s name is shown. Names get typed in a hurry when a login is created, and a wrong one then follows that person across every recipe they author, so it needs to be fixable without recreating the account.',
        {
            id: z.string().min(2).describe('The login id whose name to change'),
            display_name: z.string().min(1).describe('How this person should be shown, e.g. "Dirk"')
        },
        async ({ id, display_name: displayName }) => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may change how someone is shown.')
            const users = await store.listUsers()
            const wanted = usersLib.normalizeId(id)
            const idx = users.findIndex(u => usersLib.normalizeId(u.id) === wanted)
            if (idx < 0) return errorResult(`No login found with id '${wanted}'. List them with list_users.`)

            const clean = String(displayName).trim()
            if (!clean) return errorResult('A display name cannot be blank.')
            const before = users[idx].display_name || users[idx].id
            users[idx] = { ...users[idx], display_name: clean }
            await store.saveUsers(users)
            return jsonResult({ id: wanted, display_name: clean, was: before })
        }
    )

    server.tool(
        'set_user_password',
        'ADMIN ONLY (D81): reset a Cookbook login\'s password. Used when a password is forgotten - the old one is not recoverable by anyone, including admins, by design.',
        {
            id: z.string().min(2).describe('The login id to reset'),
            password: z.string().min(8).describe('The new password (minimum 8 characters)')
        },
        async ({ id, password }) => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may reset a password.')
            const users = await store.listUsers()
            const wanted = usersLib.normalizeId(id)
            const idx = users.findIndex(u => usersLib.normalizeId(u.id) === wanted)
            if (idx < 0) return errorResult(`No login found with id '${wanted}'. List them with list_users.`)

            const strength = usersLib.checkPasswordStrength(password)
            if (!strength.ok) return errorResult(strength.error)

            const { salt, hash, algo } = usersLib.hashPassword(password)
            users[idx] = { ...users[idx], salt, hash, algo, password_updated_at: new Date().toISOString() }
            await store.saveUsers(users)
            return jsonResult({ id: wanted, password_updated_at: users[idx].password_updated_at, note: 'Hand the new password over securely. It cannot be read back.' })
        }
    )

    // ── Assignment (D86) ─────────────────────────────────────────────────────────────────────
    // The only way unfinished work crosses between consultants. Everything else is either yours,
    // admitted to the CX graph by a Head Chef, or (for reviewers) submitted for review.

    /**
     * Resolve a person to the canonical owner identity used everywhere else, accepting either a
     * login id or an email. Typos are rejected rather than stored: an assignment to
     * "jesse.pinkmn" would silently grant nobody access, and the assigner would believe it worked.
     * @param {string} who
     * @returns {Promise<{ok: boolean, owner?: string, error?: string}>}
     */
    async function resolveAssignee (who) {
        const wanted = String(who || '').trim()
        if (!wanted) return { ok: false, error: 'Name someone to assign this to.' }
        const users = await store.listUsers()
        if (!users.length) {
            // No account system in use on this deployment; accept the identity as given.
            return { ok: true, owner: wanted }
        }
        const lower = wanted.toLowerCase()
        const match = users.find(u =>
            usersLib.normalizeId(u.id) === lower ||
            String(u.owner || '').toLowerCase() === lower ||
            String(u.email || '').toLowerCase() === lower)
        if (!match) {
            const known = users.filter(u => !u.disabled).map(u => u.id).join(', ')
            return { ok: false, error: `No Cookbook login matches '${wanted}'. Assign to one of: ${known || '(none)'}.` }
        }
        if (match.disabled) return { ok: false, error: `'${match.id}' is disabled and cannot be assigned work.` }
        return { ok: true, owner: match.owner || match.id }
    }

    server.tool(
        'assign_step',
        'Assign one ingredient to a colleague, which is what makes an UNFINISHED recipe visible to them (D86). Without an assignment, your drafts are yours alone until a Head Chef admits the recipe to the Company CX Graph. Use this to hand over a piece of work, ask for a review, or pull someone in. Assign by their login id or email. The recipe owner, a Head Chef or an admin may assign.',
        {
            step_id: z.string().min(1).describe('The ingredient id, as returned by append_step/list_steps'),
            assignee: z.string().min(1).describe('Who to assign it to: their Cookbook login id or email'),
            note: z.string().optional().describe('Why you are handing this over, e.g. "needs a legal read before we ship"')
        },
        async ({ step_id: stepId, assignee, note }) => {
            const parsed = stepsLib.parseStepId(stepId)
            if (!parsed) return errorResult(`Not a valid ingredient id: '${stepId}'`)
            const resource = await store.getResource(parsed.recipeId)
            if (!resource) return errorResult(`No recipe found for ingredient '${stepId}'`)

            const principal = resolvePrincipal(context)
            const mayAssign = resource.owner === principal || callerHasRole(context, 'head-chef') || callerHasRole(context, 'admin')
            if (!mayAssign) return errorResult('Refused: only the recipe\'s owner, a Head Chef or an admin may assign its ingredients.')

            const steps = stepsLib.ensureSteps(resource)
            const step = steps.find(s => s.id === stepId)
            if (!step) return errorResult(`No ingredient found with id '${stepId}'`)
            if (step.status === 'discarded') return errorResult('That ingredient was discarded. Assigning it would grant access to something nobody is working on.')

            const who = await resolveAssignee(assignee)
            if (!who.ok) return errorResult(who.error)

            const current = new Set(step.assigned_to || [])
            const already = current.has(who.owner)
            current.add(who.owner)
            step.assigned_to = [...current]
            step.assignment_note = note || step.assignment_note
            step.assigned_by = principal
            step.assigned_at = new Date().toISOString()
            projectRecipe(resource, steps, new Date().toISOString())
            await store.saveResource(resource)

            return jsonResult({
                step_id: stepId,
                recipe_id: resource.id,
                assigned_to: step.assigned_to,
                already_assigned: already,
                recipe_visible_to: resource.assigned_to || [],
                note: `${who.owner} can now see this recipe in their Work Log, including the parts that are not finished.`
            })
        }
    )

    server.tool(
        'unassign_step',
        'Remove an assignment from an ingredient (D86). If that was the only reason a colleague could see the recipe, they lose access to it again.',
        {
            step_id: z.string().min(1).describe('The ingredient id'),
            assignee: z.string().min(1).describe('Who to remove: their Cookbook login id or email')
        },
        async ({ step_id: stepId, assignee }) => {
            const parsed = stepsLib.parseStepId(stepId)
            if (!parsed) return errorResult(`Not a valid ingredient id: '${stepId}'`)
            const resource = await store.getResource(parsed.recipeId)
            if (!resource) return errorResult(`No recipe found for ingredient '${stepId}'`)

            const principal = resolvePrincipal(context)
            const mayAssign = resource.owner === principal || callerHasRole(context, 'head-chef') || callerHasRole(context, 'admin')
            if (!mayAssign) return errorResult('Refused: only the recipe\'s owner, a Head Chef or an admin may change its assignments.')

            const steps = stepsLib.ensureSteps(resource)
            const step = steps.find(s => s.id === stepId)
            if (!step) return errorResult(`No ingredient found with id '${stepId}'`)

            const who = await resolveAssignee(assignee)
            // An unknown assignee is not an error here: removing something that was never there
            // should be a no-op, not a failure.
            const target = who.ok ? who.owner : String(assignee).trim()
            const before = (step.assigned_to || []).length
            step.assigned_to = (step.assigned_to || []).filter(a => a !== target)
            const removed = before !== step.assigned_to.length
            if (!step.assigned_to.length) delete step.assigned_to
            projectRecipe(resource, steps, new Date().toISOString())
            await store.saveResource(resource)

            const stillVisible = (resource.assigned_to || []).includes(target)
            return jsonResult({
                step_id: stepId,
                removed,
                recipe_visible_to: resource.assigned_to || [],
                note: removed
                    ? (stillVisible
                        ? `${target} is still assigned to another ingredient of this recipe, so they keep access.`
                        : `${target} no longer has access to this recipe, unless it is admitted to the CX graph.`)
                    : `${target} was not assigned to this ingredient. Nothing changed.`
            })
        }
    )

    server.tool(
        'list_my_assignments',
        'Ingredients other people have assigned to you (D86), with who handed them over and why. This is your inbox of work pulled in from colleagues.',
        {},
        async () => {
            const me = resolvePrincipal(context)
            const entries = await store.listResources({ visibleTo: me, visibleSubmitted: callerCanReview(context) })
            const out = []
            for (const entry of entries) {
                if (!(entry.assigned_to || []).includes(me)) continue
                const full = await store.getResource(entry.id)
                for (const s of stepsLib.ensureSteps(full)) {
                    if (s.status === 'discarded' || !(s.assigned_to || []).includes(me)) continue
                    out.push({
                        step_id: s.id,
                        recipe_id: entry.id,
                        recipe_title: entry.title,
                        recipe_owner: entry.owner,
                        kind: s.kind,
                        assigned_by: s.assigned_by || null,
                        assigned_at: s.assigned_at || null,
                        note: s.assignment_note || null
                    })
                }
            }
            out.sort((a, b) => String(b.assigned_at || '').localeCompare(String(a.assigned_at || '')))
            return jsonResult(out)
        }
    )

    server.tool(
        'delete_recipe',
        'ADMIN ONLY (D84): permanently delete ONE recipe - for junk, test data, or something captured by mistake. Until now an admin\'s only delete was admin_reset_data, which wipes everything, so removing one bad recipe meant destroying everyone\'s work. Refuses a recipe already admitted to the Company CX Graph unless force is true, because other people are relying on it.',
        {
            id: z.string().min(1).describe('The recipe id to delete'),
            force: z.boolean().optional().describe('Delete even if it is in the Company CX Graph. Requires deliberate intent - other people\'s work may reference it.')
        },
        async ({ id, force }) => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may delete a recipe.')
            const resource = await store.getResource(id)
            if (!resource) return errorResult(`No resource found with id '${id}' - nothing to delete.`)
            if (resource.cx_approved === true && force !== true) {
                return errorResult(`Refused: '${id}' is in the Company CX Graph, so other people's work may reference it. Hold it back first with headchef_reject, or pass force: true if you are certain.`)
            }
            const summary = {
                id,
                title: resource.title,
                owner: resource.owner || null,
                project: resource.project || null,
                step_count: stepsLib.ensureSteps(resource).length,
                was_in_cx_graph: resource.cx_approved === true
            }
            await store.deleteResource(id)

            // D91: say when this leaves an empty project behind. Deleting recipes silently
            // accumulated project records with nothing in them, which then showed up in the
            // dashboard's project filter and selected to an empty screen.
            let projectNowEmpty = false
            if (summary.project) {
                const siblings = await store.listResources({ project: summary.project })
                projectNowEmpty = siblings.length === 0
            }

            return jsonResult({
                deleted: summary,
                deleted_by: resolvePrincipal(context),
                ...(projectNowEmpty ? { project_now_empty: summary.project } : {}),
                note: projectNowEmpty
                    ? `Permanently removed. '${summary.project}' now has no recipes: archive it with set_project_status so it stops appearing as a choice. Rebuild the CX graph if this recipe was in it.`
                    : 'Permanently removed. Rebuild the CX graph (rebuild_cx_graph) if this recipe was in it.'
            })
        }
    )

    server.tool(
        'change_my_password',
        'Change YOUR OWN password (D82). Any signed-in user may do this for themselves - it does not require an admin, and an admin cannot see the result. Requires your current password even though you are already signed in.',
        {
            current_password: z.string().min(1).describe('Your current password'),
            new_password: z.string().min(8).describe('The new password (minimum 8 characters)')
        },
        async ({ current_password: currentPassword, new_password: newPassword }) => {
            const principal = resolvePrincipal(context)
            const users = await store.listUsers()
            // Match on the owner identity the caller is authenticated as, so this works whether
            // they signed in by login id or by email.
            const idx = users.findIndex(u => u.owner === principal || usersLib.normalizeId(u.id) === usersLib.normalizeId(principal))
            if (idx < 0) {
                return errorResult('Your identity has no Cookbook login to change. If you are using an api key or a federated sign-in, there is no password for it - ask an admin to create you a login.')
            }

            // Re-check the current password even though the caller is already authenticated. They
            // might hold a different credential type entirely (api key, SSO token), and requiring
            // it means a walked-away session cannot silently lock the real owner out.
            if (!usersLib.verifyPassword(currentPassword, users[idx])) {
                return errorResult('Your current password is incorrect. Nothing was changed.')
            }
            const strength = usersLib.checkPasswordStrength(newPassword)
            if (!strength.ok) return errorResult(strength.error)
            if (usersLib.verifyPassword(newPassword, users[idx])) {
                return errorResult('That is already your current password. Choose a different one.')
            }

            const { salt, hash, algo } = usersLib.hashPassword(newPassword)
            users[idx] = { ...users[idx], salt, hash, algo, password_updated_at: new Date().toISOString() }
            await store.saveUsers(users)
            return jsonResult({
                id: users[idx].id,
                password_updated_at: users[idx].password_updated_at,
                note: 'Password changed. Update it in any AI client config that uses it, and sign in again on other devices.'
            })
        }
    )

    server.tool(
        'set_user_enabled',
        'ADMIN ONLY (D81): disable or re-enable a Cookbook login. Disabling is preferred to deleting when someone leaves - it blocks sign-in while keeping their authored work and its provenance intact.',
        {
            id: z.string().min(2).describe('The login id'),
            enabled: z.boolean().describe('false to block sign-in, true to restore it')
        },
        async ({ id, enabled }) => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may enable or disable a login.')
            const users = await store.listUsers()
            const wanted = usersLib.normalizeId(id)
            const idx = users.findIndex(u => usersLib.normalizeId(u.id) === wanted)
            if (idx < 0) return errorResult(`No login found with id '${wanted}'.`)

            // Refusing to disable the last admin: locking every admin out of a live deployment is
            // not recoverable through the product, only through redeployment.
            if (!enabled) {
                const stillAdmin = users.filter((u, i) => i !== idx && !u.disabled &&
                    settings.rolesFor(u.owner || u.id, u.roles).includes('admin'))
                const targetIsAdmin = settings.rolesFor(users[idx].owner || users[idx].id, users[idx].roles).includes('admin')
                if (targetIsAdmin && stillAdmin.length === 0) {
                    return errorResult('Refused: this is the last enabled admin login. Create or promote another admin first, or you will lock everyone out.')
                }
            }

            users[idx] = { ...users[idx], disabled: !enabled }
            await store.saveUsers(users)
            return jsonResult(usersLib.publicUser(users[idx]))
        }
    )

    server.tool(
        'set_head_chefs',
        'ADMIN ONLY (D64/D66): replace the Head Chef roster - the list of owner identities allowed to admit recipes into the Company CX Graph. Full replace. Persisted as a settings override. Guarded by the admin role. (set_user_roles is the newer, more general way to grant head-chef; this remains for roster-style edits.)',
        {
            head_chefs: z.array(z.string().min(1)).describe('The complete list of owner identities (email/username/sub, or "service-account" for the shared key) that should hold the head-chef role')
        },
        async ({ head_chefs: heads }) => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may change the head-chef roster.')
            const current = await store.getSettingsOverride()
            const next = { ...current, head_chefs: [...new Set(heads.map(h => h.trim()).filter(Boolean))] }
            const stored = await store.saveSettingsOverride(next)
            settings._setCache(stored)
            return jsonResult({ head_chefs: settings.headChefs() })
        }
    )

    server.tool(
        'list_cx_pending',
        'The Head Chef review queue (D64): baked recipes that a Head Chef has NOT yet admitted to the Company CX Graph (cx_approved !== true). Cross-owner (a Head Chef reviews everyone\'s candidates). Read-only. A baked recipe stays here until headchef_approve admits it or headchef_reject holds it back.',
        {
            project: z.string().optional().describe('Filter the queue to one project')
        },
        async ({ project }) => {
            // D99: reviewers only. This lists work other people have submitted but not yet had
            // admitted, and it had no role check at all, so any chef could enumerate the lot.
            if (!callerCanReview(context)) {
                return errorResult('Refused: the Head Chef review queue is for head chefs and admins. Submitted work is visible to reviewers until it is admitted, and then to everyone.')
            }
            const entries = await store.listResources({ project }) // cross-owner review queue
            const pending = entries.filter(e => e.type !== HANDOFF_TYPE && e.baked === true && e.cx_approved !== true)
            return jsonResult(pending)
        }
    )

    server.tool(
        'headchef_approve',
        'HEAD CHEF ONLY (D64): admit a baked recipe into the Company CX Graph - sets cx_approved. Guarded: only a caller whose owner identity is on the head-chef roster (settings.head_chefs) may call this; anyone else is refused. The recipe must be baked first (a candidate). This is the second tier of the two-tier flow: chef bakes -> Head Chef admits.',
        {
            recipe_id: z.string().min(1).describe('The baked recipe id to admit into the CX graph')
        },
        async ({ recipe_id: recipeId }) => {
            if (!callerHasRole(context, 'head-chef')) {
                return errorResult('Refused: only a Head Chef may admit recipes into the Company CX Graph. Ask an admin to add you to settings.head_chefs (set_head_chefs).')
            }
            const resource = await store.getResource(recipeId)
            if (!resource) return errorResult(`No recipe found with id '${recipeId}'`)
            if (resource.type === HANDOFF_TYPE) return errorResult(`Resource '${recipeId}' is a handoff-prompt, not a recipe`)
            if (resource.baked !== true) return errorResult(`Recipe '${recipeId}' is not baked yet - only baked recipes are CX candidates. Bake it first (bake_recipe).`)
            const now = new Date().toISOString()
            resource.cx_approved = true
            resource.cx_approved_by = resolvePrincipal(context)
            resource.cx_approved_at = now
            await store.saveResource(resource)
            return jsonResult({ id: recipeId, cx_approved: true, cx_approved_by: resource.cx_approved_by, cx_approved_at: now })
        }
    )

    server.tool(
        'headchef_reject',
        'HEAD CHEF ONLY (D64): hold a baked recipe back OUT of the Company CX Graph - clears cx_approved (false). Same head-chef guard as headchef_approve. Use to reverse an earlier admission or to explicitly decline a candidate; the recipe stays baked and owner-visible, it just does not appear in the cross-owner CX graph.',
        {
            recipe_id: z.string().min(1).describe('The recipe id to hold back out of the CX graph')
        },
        async ({ recipe_id: recipeId }) => {
            if (!callerHasRole(context, 'head-chef')) {
                return errorResult('Refused: only a Head Chef may change a recipe\'s CX-graph admission. Ask an admin to add you to settings.head_chefs (set_head_chefs).')
            }
            const resource = await store.getResource(recipeId)
            if (!resource) return errorResult(`No recipe found with id '${recipeId}'`)
            if (resource.type === HANDOFF_TYPE) return errorResult(`Resource '${recipeId}' is a handoff-prompt, not a recipe`)
            // Candidate gate (D79 bugfix): only a BAKED recipe is a CX candidate, so only a baked
            // recipe can be held back. headchef_approve always enforced this; reject did not - which
            // let a head-chef stamp cx_approved:false onto another owner's private, un-baked,
            // still-experimental work (a pointless cross-owner write on something that was never a
            // candidate, and a confusing audit trail). Now symmetric with approve.
            if (resource.baked !== true) {
                return errorResult(`Recipe '${recipeId}' is not baked, so it is not a CX candidate - there is nothing to hold back. Only baked recipes reach the Head Chef queue (list_cx_pending).`)
            }
            const now = new Date().toISOString()
            resource.cx_approved = false
            resource.cx_approved_by = resolvePrincipal(context)
            resource.cx_approved_at = now
            await store.saveResource(resource)
            return jsonResult({ id: recipeId, cx_approved: false, cx_approved_by: resource.cx_approved_by, cx_approved_at: now })
        }
    )

    /*
     * D106: the Cook-off board, and the ONE deliberate disclosure in the whole system.
     *
     * Crystal colour encodes purity - the share of what you submitted that a Head Chef admitted -
     * and purity needs a denominator. The dashboard used to take it from list_cx_pending, which is
     * reviewers-only, so a plain chef got an empty queue, read it as nothing outstanding, and saw
     * every contributor as a spotless 100%. The same person showed as 50% yellow to a Head Chef and
     * 100% blue to everybody else. A leaderboard that ranks and colours people differently
     * depending on who is looking is not a leaderboard.
     *
     * So the denominator is published here, as COUNTS ONLY: how many recipes each person has
     * submitted, and how many got in. No titles, no ids, no projects, no dates - nothing about WHAT
     * anyone submitted, which stays as private as it was. What this does reveal is that a colleague
     * has n recipes waiting on review, and that is the accepted cost of one honest board.
     */
    server.tool(
        'get_cookoff',
        'The Cook-off board: per-person counts of recipes SUBMITTED for review and ADMITTED to the Company CX Graph, so every viewer computes the same standings and the same purity. Counts only - it carries no titles, ids, projects or dates, and reveals nothing about the content of anyone\'s unadmitted work. Readable by everyone on purpose: a leaderboard that differs by viewer is not a leaderboard.',
        {},
        async () => {
            // Deliberately unscoped: this aggregates across owners by design, and returns nothing
            // that identifies a recipe. Every other cross-owner read in this file is filtered.
            const entries = await store.listResources({})
            const byOwner = new Map()
            for (const entry of entries) {
                const owner = entry.owner || entry.author
                if (!owner) continue
                if (entry.type === HANDOFF_TYPE) continue
                if (!byOwner.has(owner)) byOwner.set(owner, { owner, submitted: 0, admitted: 0 })
                const row = byOwner.get(owner)
                // Admitting a recipe never clears baked, so submitted is the superset.
                if (entry.baked === true) row.submitted++
                if (entry.cx_approved === true) row.admitted++
            }
            const board = [...byOwner.values()]
                .filter(r => r.submitted > 0 || r.admitted > 0)
                .map(r => ({
                    ...r,
                    // A recipe admitted without a recorded bake would otherwise produce >100%.
                    submitted: Math.max(r.submitted, r.admitted),
                    purity: r.submitted || r.admitted
                        ? Math.round((r.admitted / Math.max(r.submitted, r.admitted)) * 1000) / 10
                        : null
                }))
                .sort((a, b) => b.admitted - a.admitted || String(a.owner).localeCompare(String(b.owner)))
            return jsonResult(board)
        }
    )

    server.tool(
        'get_cx_graph',
        'Read the compiled Company CX Knowledge Graph (D40/D53): the cross-owner, APPROVED-ONLY view (nodes = approved recipes + their approved ingredients; edges = composition, lineage, and shared tag/segment/kind). Read-only and safe cross-owner - only consented content is here. Returns the last compile (generated_at) or a not-yet-built marker.',
        {},
        async () => {
            const graph = await store.getCxGraph()
            if (!graph) return jsonResult({ generated_at: null, built: false, node_count: 0, edge_count: 0, nodes: [], edges: [], note: 'Not compiled yet - run rebuild_cx_graph or wait for the daily job.' })
            return jsonResult(graph)
        }
    )

    server.tool(
        'rebuild_cx_graph',
        'Recompile the Company CX Knowledge Graph now from all APPROVED recipes across owners, and cache it. Guarded write (runs under the shared service key today; per-user RBAC later). Also runs daily on a schedule.',
        {},
        async () => {
            const graph = await cxGraph.rebuildAndStore()
            return jsonResult({ rebuilt: true, generated_at: graph.generated_at, recipe_count: graph.recipe_count, node_count: graph.node_count, edge_count: graph.edge_count, owners: graph.owners })
        }
    )
}

/**
 * Register captured resources as native MCP Resources (Part B, D26) - so any MCP
 * client (not just the one that saved it) can list/read company knowledge, not
 * just via the custom tools above. Only APPROVED cookbook recipes are exposed:
 * experimental ones aren't consented yet, and handoff-prompts are active task
 * briefs, not reusable cookbook knowledge (D38/D42), so both are excluded. The
 * "active" status filter is alias-aware, so it matches both the new "approved"
 * spelling and legacy "active" records. Backed live by the store/catalog on every
 * request - each request creates a fresh McpServer instance (see index.js).
 * @param {McpServer} server - The MCP server instance
 */
/**
 * @param {object} server
 * @param {{userInfo?: object}} [context] caller identity, needed so resources/read obeys the same
 *   visibility rules as every other read path (D88). index.js has always passed it; the parameter
 *   was simply never declared, so the guard added here referenced an undefined binding.
 */
function registerResources (server, context = {}) {
    const template = new ResourceTemplate('resource://company/{type}/{id}', {
        list: async () => {
            // D99: the same visibility rules as every other read. "approved" alone is not a
            // sharing decision, because approving one ingredient promotes its recipe, so this
            // surface was listing people's private drafts to any connected client.
            const entries = (await store.listResources({
                status: 'approved',
                visibleTo: resolvePrincipal(context),
                visibleSubmitted: callerCanReview(context)
            })).filter(entry => entry.type !== HANDOFF_TYPE)
            return {
                resources: entries.map(entry => ({
                    uri: `resource://company/${entry.type}/${entry.id}`,
                    name: entry.title,
                    mimeType: policy.mimeTypeForFormat(entry.format)
                }))
            }
        }
    })

    server.resource(
        'company-resource',
        template,
        { description: 'Company knowledge captured via save_resource - decisions, architecture, playbooks, configuration, and more (see get_resource_policy).' },
        async (uri, variables) => {
            const resource = await store.getResource(variables.id)
            // D88: the MCP resources/read path is a read-by-id like any other, so it obeys the same
            // visibility rules. Approved-but-unsubmitted work is private to its owner.
            if (!resource || !statusLib.isApproved(resource.status) || resource.type === HANDOFF_TYPE ||
                !callerCanRead(resource, context)) {
                throw new Error(`Resource ${uri} not found`)
            }
            // The composed how-to (D45): approved steps only, in their original order -
            // a recipe with unreviewed draft steps alongside its approved ones exposes
            // only the certified subset here.
            const approvedContent = stepsLib.composeContent(stepsLib.ensureSteps(resource), { approvedOnly: true })
            return {
                contents: [
                    {
                        uri: uri.toString(),
                        text: approvedContent,
                        mimeType: policy.mimeTypeForFormat(resource.format)
                    }
                ]
            }
        }
    )
}

/**
 * Register prompts with the MCP server - user-controlled slash-command templates
 * that guide the AI to produce and save the right resources in one step (Part A, D26).
 * @param {McpServer} server - The MCP server instance
 */
function registerPrompts (server) {
    server.prompt(
        'capture-architecture',
        'Save the architecture diagram you just produced (or are about to produce) to the company resource store.',
        {
            system: z.string().optional().describe('Which system/component this diagram documents'),
            format: z.string().optional().describe('svg, png, or mermaid')
        },
        async ({ system, format }) => ({
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `Produce (or use the diagram already produced) and save it via save_resource with type "architecture-diagram"${system ? ` for the ${system} system (pass fields: { system: "${system}" })` : ''}${format ? ` in ${format} format` : ''}. Include a clear title and the full diagram content. This type requires human approval before becoming active - that is expected.`
                    }
                }
            ]
        })
    )

    server.prompt(
        'document-decision',
        'Capture a decision just made in this conversation as a company decision record.',
        {
            title: z.string().optional().describe('Short title for the decision')
        },
        async ({ title }) => ({
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `Write up the decision just discussed as a decision record (what was decided, why, and the alternatives considered) and save it via save_resource with type "decision"${title ? ` titled "${title}"` : ''}.`
                    }
                }
            ]
        })
    )

    server.prompt(
        'use-recipe',
        'Load a certified house recipe into this conversation as skill context - the "auto-skilling" path (D31). Look it up via search_resources/list_resources first, then pass its id here.',
        {
            recipe_id: z.string().describe('The recipe id to load, as returned by search_resources or list_resources')
        },
        async ({ recipe_id: recipeId }) => ({
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `Call export_as_skill with recipe_id "${recipeId}" (format "prompt") and treat the returned content as trusted company context for the rest of this conversation.`
                    }
                }
            ]
        })
    )

    server.prompt(
        'commit-session',
        'Summarize this session and save the key artifacts (decisions, playbooks, configuration, diagrams, code) produced to the company resource store.',
        {},
        async () => ({
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: 'Review this conversation. For each substantive artifact produced (decisions, architecture diagrams, playbooks, configuration, meeting notes, code snippets), save it via save_resource with the correct type from get_resource_policy. Summarize what you saved at the end, noting anything left pending approval.'
                    }
                }
            ]
        })
    )
}

// Export all functions for CommonJS
module.exports = {
    WRITE_TOOLS, // exported so tests can assert the read-only gate covers every write tool (D79)
    registerTools,
    registerResources,
    registerPrompts,
    SERVER_INSTRUCTIONS
}
