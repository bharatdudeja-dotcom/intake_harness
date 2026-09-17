/*
Copyright 2026 Adobe. All rights reserved.
Licensed under the Apache License, Version 2.0.
*/

/**
 * Create the demo consultants' Cookbook logins (D81) through the real admin tool, against the
 * live deployment - the same create_user path an admin uses from the dashboard, so what the demo
 * shows is what the product does.
 *
 * Passwords are deliberately memorable because they are typed on stage. They are DEMO
 * credentials: anyone holding one can act as that consultant. Rotate after the event.
 *
 *   node validation/seed-logins.mjs [--url <mcp-server-url>]
 *
 * Bootstrap: uses the admin api key from the git-ignored keys.local.json to create the first
 * logins. Writes the handout to the git-ignored connector/demo-logins.local.md - never to git.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const argOf = (flag) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : null }
const MCP_URL = argOf('--url') || 'https://110557-tapmcpconnector-stage.adobeioruntime.net/api/v1/web/tap-mcp-connector/mcp-server'
const DASH_URL = 'https://110557-tapmcpconnector-stage.adobeio-static.net/index.html'

/**
 * Bootstrap credential. Prefers an admin LOGIN from demo-people.local.json - people use logins,
 * not keys (D82) - and falls back to the break-glass api key for the very first run, when no admin
 * login exists yet. The break-glass key exists so a broken login can never lock the deployment out
 * entirely; it is not a credential for a person.
 */
async function bootstrapHeaders (people) {
    const admin = people.find(p => (p.roles || []).includes('admin'))
    const breakGlass = (() => {
        try {
            const entities = JSON.parse(readFileSync(join(ROOT, 'keys.local.json'), 'utf8')).entities
            const key = Object.values(entities).find(e => (e.roles || []).includes('admin'))?.key
            return key ? { 'x-api-key': key } : null
        } catch (e) { return null }
    })()

    // PROBE the admin login rather than assuming it works. On a password ROTATION the local file
    // already holds the new password while the server still has the old one, so the login must
    // fail over to break-glass - otherwise the rotation cannot bootstrap itself. Same on a first
    // run, when no login exists yet.
    if (admin) {
        const probe = await call({ 'x-cookbook-login': `${admin.id}:${admin.password}` }, 'get_my_roles')
        if (!probe.isError && probe.status === 200) return { 'x-cookbook-login': `${admin.id}:${admin.password}` }
        if (breakGlass) {
            console.log(`(admin login not usable yet — bootstrapping with the break-glass key)\n`)
            return breakGlass
        }
    }
    if (breakGlass) return breakGlass
    console.error('No usable admin login in demo-people.local.json and no break-glass admin key available.')
    process.exit(1)
}

/**
 * The consultants to create, read from the GIT-IGNORED demo-people.local.json so no password ever
 * enters version control. Copy demo-people.example.json to demo-people.local.json and set your own
 * passwords before running this.
 */
const PEOPLE_PATH = join(ROOT, 'demo-people.local.json')
let PEOPLE
try {
    PEOPLE = JSON.parse(readFileSync(PEOPLE_PATH, 'utf8')).people
    if (!Array.isArray(PEOPLE) || !PEOPLE.length) throw new Error('no "people" array')
} catch (e) {
    console.error(`Cannot read ${PEOPLE_PATH}: ${e.message}
Copy demo-people.example.json to demo-people.local.json (it is git-ignored) and set a password for
each person, then re-run. Passwords must never be committed.`)
    process.exit(1)
}

let rpcId = 0
/** Call a tool with an arbitrary credential header set. */
async function call (headers, name, args = {}) {
    const res = await fetch(MCP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
    })
    const text = await res.text()
    try {
        const body = JSON.parse(text)
        const content = body?.result?.content?.[0]?.text
        const payload = content ? (() => { try { return JSON.parse(content) } catch { return content } })() : (body.error?.message || text)
        return { status: res.status, isError: !!body?.result?.isError || !!body?.error, payload }
    } catch {
        return { status: res.status, isError: true, payload: text }
    }
}
const ADMIN_HEADERS = await bootstrapHeaders(PEOPLE)
const asAdmin = (name, args) => call(ADMIN_HEADERS, name, args)
const asLogin = (id, password, name, args) => call({ 'x-cookbook-login': `${id}:${password}` }, name, args)

let failures = 0
function check (label, ok, detail = '') {
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failures++
}

console.log(`Creating demo logins against ${MCP_URL}\n`)

// Practices must exist before anyone is assigned to one.
await asAdmin('set_practices', {
    practices: [
        { id: 'braze', label: 'Braze' },
        { id: 'aem', label: 'AEM' },
        { id: 'aep', label: 'AEP / Real-Time CDP' },
        { id: 'campaign', label: 'Adobe Campaign' },
        { id: 'decisioning', label: 'Decisioning & Personalization' },
        { id: 'security', label: 'Security & IT Governance' }
    ]
})

console.log('Creating logins:')
for (const p of PEOPLE) {
    const res = await asAdmin('create_user', {
        id: p.id,
        password: p.password,
        email: p.email,
        display_name: p.name,
        roles: p.roles,
        ...(p.practices.length ? { practices: p.practices } : {})
    })
    if (res.isError && /already exists/i.test(String(res.payload))) {
        // Idempotent: re-running the seed resets the password rather than failing.
        const reset = await asAdmin('set_user_password', { id: p.id, password: p.password })
        check(`${p.name} (existing login, password reset)`, !reset.isError, String(reset.payload).slice(0, 80))
    } else {
        check(`${p.name} created`, !res.isError, res.isError ? String(res.payload).slice(0, 120) : `roles: ${(res.payload.roles || []).join('+')}`)
    }
}

console.log('\nVerifying each login actually works and resolves to that person:')
for (const p of PEOPLE) {
    const me = await asLogin(p.id, p.password, 'get_my_roles')
    check(`${p.name} signs in`, !me.isError && me.payload?.owner === p.email, me.isError ? String(me.payload).slice(0, 90) : `${me.payload.owner} (${(me.payload.roles || []).join('+')})`)
}

console.log('\nVerifying the login is REJECTED when it should be:')
const first = PEOPLE[0]
const wrong = await asLogin(first.id, 'not-the-password', 'get_my_roles')
check('a wrong password is refused', wrong.status === 401, `HTTP ${wrong.status}`)
const ghost = await asLogin('does.not.exist', 'anything-at-all', 'get_my_roles')
check('an unknown login is refused', ghost.status === 401, `HTTP ${ghost.status}`)

console.log('\nVerifying each person sees THEIR OWN cookbook:')
for (const p of PEOPLE) {
    const mine = await asLogin(p.id, p.password, 'list_recipes')
    const list = Array.isArray(mine.payload) ? mine.payload : []
    const own = list.filter(r => r.author === p.email).length
    check(`${p.name} view`, !mine.isError, `${list.length} recipe(s) visible, ${own} authored by them`)
}

console.log('\nVerifying roles differ by person:')
const admin = PEOPLE.find(p => p.roles.includes('admin')) || PEOPLE[0]
const viewer = PEOPLE.find(p => p.roles.includes('viewer'))
const chef = PEOPLE.find(p => p.roles.length === 1 && p.roles[0] === 'chef') || PEOPLE[0]
const headChefQueue = await asLogin(admin.id, admin.password, 'list_cx_pending')
check(admin.name + ' (head chef) can read the CX queue', !headChefQueue.isError, `${Array.isArray(headChefQueue.payload) ? headChefQueue.payload.length : 0} pending`)
const guestWrite = viewer ? await asLogin(viewer.id, viewer.password, 'start_recipe', { project: 'x', title: 'y' }) : { isError: true, payload: '(no viewer configured)' }
check('viewer cannot write', guestWrite.isError, String(guestWrite.payload).slice(0, 70))
const chefAdmin = await asLogin(chef.id, chef.password, 'create_user', { id: 'sneaky', password: 'long-enough-1' })
check('a plain chef cannot create logins', chefAdmin.isError, String(chefAdmin.payload).slice(0, 60))

// The handout. Git-ignored: it contains live credentials.
const rows = PEOPLE.map(p => `| **${p.name}** | \`${p.id}\` | \`${p.password}\` | ${p.roles.join(', ')} | ${p.practices.join(', ') || '—'} | ${p.blurb} |`).join('\n')
const mcpBlock = (p) => `{
  "mcpServers": {
    "company-cookbook": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${MCP_URL}", "--header", "x-cookbook-login:${p.id}:${p.password}"]
    }
  }
}`

writeFileSync(join(ROOT, 'demo-logins.local.md'), `# TAP Cookbook — demo logins (GIT-IGNORED, DO NOT COMMIT)

**Dashboard:** ${DASH_URL}
Sign in with the login id and password below. Each person sees their own work plus everything the
company has approved and everything in the Company CX Graph.

| Consultant | Login id | Password | Roles | Practice | Who they are |
|---|---|---|---|---|---|
${rows}

## Connect an AI client as any of them

Claude Desktop — \`%APPDATA%\\Claude\\claude_desktop_config.json\` (Windows) or
\`~/Library/Application Support/Claude/claude_desktop_config.json\` (macOS):

\`\`\`json
${mcpBlock(PEOPLE[0])}
\`\`\`

Claude Code / VS Code — one command, from the project folder:

\`\`\`bash
claude mcp add company-cookbook --transport http ${MCP_URL} --header "x-cookbook-login: ${PEOPLE[0].id}:${PEOPLE[0].password}"
\`\`\`

Swap the id:password pair for whichever consultant you want to be.

## Demo notes

- **Walter White** is the Head Chef + admin — use him to show curation and the Team panel.
- **Mike Ehrmantraut** is a *second* head chef, so curation isn't a single point of control.
- **Guest** is read-only: it reads the shared CX graph and is refused every write.
- Each consultant has a **private, un-baked work-in-progress recipe**. Sign in as Saul and you
  cannot see Jesse's rough thinking — that's the privacy model, live.
- These are demo credentials. Rotate them after the event with \`set_user_password\`.
`)

console.log(`\n${'='.repeat(60)}`)
console.log(failures === 0 ? 'All logins created and verified.' : `${failures} check(s) FAILED.`)
console.log('credentials -> connector/demo-logins.local.md (git-ignored)')
process.exit(failures === 0 ? 0 : 1)
