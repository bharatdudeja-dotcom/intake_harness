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
 * D83: the onboarding kit an admin hands a new consultant. It is a real deliverable - the only
 * artifact a new person gets - so it is worth protecting from silently losing a section.
 *
 * buildHandout lives in the dashboard SPA (web-src/index.html, one inline script). Rather than
 * duplicate it here and let the copy drift, this extracts the real function from the shipped file
 * and runs it with the two globals it reads.
 */

const { readFileSync } = require('fs')
const { join } = require('path')

const HTML_PATH = join(__dirname, '..', 'web-src', 'index.html')
const MCP_URL = 'https://example.adobeioruntime.net/api/v1/web/tap-mcp-connector/mcp-server'

/** Extract buildHandout from the shipped SPA and return it as a callable function. */
function loadBuildHandout () {
    const html = readFileSync(HTML_PATH, 'utf8')
    const script = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1])[0]
    const start = script.indexOf('function buildHandout (user) {')
    const end = script.indexOf('/** Trigger a client-side download of the handout. */')
    if (start === -1 || end === -1) throw new Error('buildHandout not found in web-src/index.html')

    const state = { info: { connector: { mcpServerUrl: MCP_URL } } }
    const location = { origin: 'https://example.adobeio-static.net', pathname: '/index.html' }
    // eslint-disable-next-line no-new-func
    return new Function('state', 'location', `${script.slice(start, end)}; return buildHandout;`)(state, location)
}

const USER = {
    id: 'saul.goodman',
    password: 'test-pw-hotel-0008',
    email: 'saul.goodman@tapcxm.example',
    display_name: 'Saul Goodman',
    roles: ['chef'],
    practice: 'braze'
}

describe('the new-user onboarding kit (D83)', () => {
    let kit
    beforeAll(() => { kit = loadBuildHandout()(USER) })

    test('carries the credentials the person needs to sign in', () => {
        expect(kit).toContain('saul.goodman')
        expect(kit).toContain('test-pw-hotel-0008')
        expect(kit).toContain('saul.goodman@tapcxm.example')
        expect(kit).toContain('Saul Goodman')
    })

    test('includes a VALID, complete Claude Desktop config, not a fragment', () => {
        // Pull the JSON block out and parse it - a config that does not parse is worse than none,
        // because the failure is silent and the person has no idea why no tools appeared.
        const match = kit.match(/\{\s*\n\s*"mcpServers"[\s\S]*?\n\}/)
        expect(match).not.toBeNull()
        const parsed = JSON.parse(match[0])
        const server = parsed.mcpServers['agent-manager']
        expect(server.command).toBe('npx')
        expect(server.args).toContain(MCP_URL)
        expect(server.args).toContain('x-cookbook-login:saul.goodman:test-pw-hotel-0008')
    })

    test('says WHERE the Claude Desktop config file lives, on both platforms', () => {
        expect(kit).toContain('%APPDATA%\\Claude\\claude_desktop_config.json')
        expect(kit).toContain('~/Library/Application Support/Claude/claude_desktop_config.json')
    })

    test('warns that a full restart is required, the step people miss', () => {
        expect(kit).toMatch(/quit Claude Desktop completely/i)
        expect(kit).toMatch(/read only at\s+startup/i)
    })

    test('includes the one-line command to connect an IDE, with the credential in it', () => {
        expect(kit).toMatch(/claude mcp add agent-manager --transport http/)
        expect(kit).toContain(`--header "x-cookbook-login: ${USER.id}:${USER.password}"`)
        // and the machine-wide variant, since most people want it in every project
        expect(kit).toMatch(/--scope user/)
    })

    test('includes the standing capture instruction AND where to configure it', () => {
        expect(kit).toMatch(/search for prior runs/i)
        expect(kit).toMatch(/append_step/)
        expect(kit).toMatch(/save_resource with its existing id/i)
        // Where it goes is the half people get wrong.
        expect(kit).toContain('CLAUDE.md')
        expect(kit).toMatch(/~\/\.claude\/CLAUDE\.md/)
        expect(kit).toMatch(/Claude Desktop/)
        expect(kit).toMatch(/copy from here/)
        // The rule that stops one task becoming several recipes must survive any rewrite.
        // Whitespace-tolerant: the copy is hard-wrapped, so the phrase can straddle a line break.
        expect(kit).toMatch(/One\s+run per intake/i)
    })

    test('names the person\'s practice, so they know their work is filed automatically', () => {
        expect(kit).toContain('braze')
    })

    test('tells them how to change the password and what it breaks', () => {
        expect(kit).toMatch(/Change my password/)
        expect(kit).toMatch(/update your Claude Desktop config/i)
    })

    test('explains the privacy model, which is the whole product promise', () => {
        expect(kit).toMatch(/PRIVATE to you/i)
        expect(kit).toMatch(/Hero Agent/i)
        expect(kit).toMatch(/Shared Knowledge Graph/)
    })

    test('carries troubleshooting for the failures people actually hit', () => {
        expect(kit).toMatch(/Incorrect login id or password/)
        expect(kit).toMatch(/trailing comma/)
        expect(kit).toMatch(/Worked yesterday, not today/)
    })

    test('carries no em dashes, in line with the product voice (D85)', () => {
        expect(kit).not.toContain('\u2014')
    })

    test('tells them to keep it private and delete it', () => {
        expect(kit).toMatch(/Keep this file private/i)
        expect(kit).toMatch(/Never commit it/i)
        expect(kit).toMatch(/delete it once you are set up/i)
    })

    test('degrades sensibly when the optional fields are absent', () => {
        const minimal = loadBuildHandout()({ id: 'newbie', password: 'test-pw-india-0009' })
        expect(minimal).toContain('newbie')
        expect(minimal).toContain('not set')   // email / practice placeholders
        expect(minimal).toContain('marketer')  // default role stated rather than blank
        expect(minimal).not.toContain('undefined')
    })
})
