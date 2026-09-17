/**
 * What CX Agent Manager will and will not record.
 *
 * This service was built on a store whose whole purpose was to capture
 * everything a connected AI produced. Once a real Claude Desktop was pointed at
 * it, that is exactly what happened: architecture diagrams and summaries from
 * unrelated conversations filed themselves into the agent record, and the only
 * thing that had ever discouraged it was a sentence in the server instructions.
 *
 * Rewriting the instructions stopped Claude being ASKED to do it. These tests
 * cover the part that stops it being ABLE to, which is the part that holds when
 * a client ignores the instructions or a future model reads them differently.
 *
 * The rest of the suite runs with CAPTURE_MODE=open (see test/jest.setup.js),
 * because it is testing the store rather than the policy. This file is the one
 * place the policy itself is exercised, so it sets the mode explicitly per test.
 */

const filesLib = require('@adobe/aio-lib-files')
const settings = require('../lib/settings')

const TEST_API_KEY = 'test-api-key'

beforeEach(() => {
    const data = new Map()
    filesLib.init = jest.fn(async () => ({
        list: jest.fn(async (path) => (data.has(path) ? [{ name: path }] : [])),
        read: jest.fn(async (path) => data.get(path)),
        write: jest.fn(async (path, content) => {
            const buf = Buffer.isBuffer(content) ? content : Buffer.from(content)
            data.set(path, buf)
            return buf.length
        })
    }))
})

const { main } = require('../actions/mcp-server/index.js')

async function rpc (method, params = {}, id = 1) {
    const result = await main({
        SERVICE_API_KEY: TEST_API_KEY,
        __ow_headers: { 'x-api-key': TEST_API_KEY, host: 'unit.test.host' },
        LOG_LEVEL: 'error',
        __ow_method: 'post',
        __ow_body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    })
    return JSON.parse(result.body)
}

const callTool = (name, args, id = 1) => rpc('tools/call', { name, arguments: args }, id)
const text = (body) => body.result.content[0].text
const refused = (body) => !!body.result.isError

/** The policy reads the environment when the stored override is silent. */
function setMode (mode) {
    process.env.CAPTURE_MODE = mode
    settings._setCache({})
}

const OPEN = process.env.CAPTURE_MODE

afterEach(() => { process.env.CAPTURE_MODE = OPEN })

describe('capture policy: only agent work is recorded', () => {
    describe('closed by default', () => {
        test('the default is agent-runs-only, not open - a missing setting must not mean "record everything"', () => {
            delete process.env.CAPTURE_MODE
            settings._setCache({})
            expect(settings.captureMode()).toBe('agent-runs-only')
        })

        test('an explicit "open" is honoured, so an admin can still turn it on', () => {
            setMode('open')
            expect(settings.captureMode()).toBe('open')
        })

        test('any other value is treated as closed - a typo must fail safe', () => {
            setMode('opne')
            expect(settings.captureMode()).toBe('agent-runs-only')
        })
    })

    describe('a normal conversation with Claude', () => {
        beforeEach(() => setMode('agent-runs-only'))

        test('cannot save its own output as a resource', async () => {
            const body = await callTool('save_resource', {
                type: 'architecture-diagram',
                title: 'As-built architecture, verified 16 Sep',
                content: 'graph TD; A-->B',
                format: 'mermaid',
                project: 'Comcast Intake',
                source: 'desktop-ai'
            })
            expect(refused(body)).toBe(true)
            // The refusal has to send them somewhere, or a client that was told
            // to capture its work will simply retry.
            expect(text(body)).toMatch(/not what CX Agent Manager records/i)
            expect(text(body)).toMatch(/company cookbook/i)
        })

        test('cannot open a working thread of its own', async () => {
            const body = await callTool('start_job', {
                title: 'Some chat session',
                project: 'Comcast Intake'
            })
            expect(refused(body)).toBe(true)
            expect(text(body)).toMatch(/not what CX Agent Manager records/i)
        })

        test('the refusal names the escape hatch, so an admin is not left guessing', async () => {
            const body = await callTool('start_job', { title: 'x', project: 'p' })
            expect(text(body)).toMatch(/capture_mode/)
        })
    })

    describe('what IS still allowed', () => {
        test('a handoff-prompt: a pointer to work, which the instructions ask clients to write', async () => {
            setMode('agent-runs-only')
            const body = await callTool('save_resource', {
                type: 'handoff-prompt',
                title: 'Hand the segment build to AEP',
                content: 'Build the segment described below.',
                target_agent: 'aep'
            })
            expect(refused(body)).toBeFalsy()
        })

        test('steering an AGENT run - the most valuable thing in the store', async () => {
            // Build a run the way start_intake does: what makes it an agent run
            // is `upstream`, and nothing else.
            setMode('open')
            const created = await callTool('start_job', { title: 'Q4 HSD Upsell', project: 'Comcast Intake' })
            const jobId = JSON.parse(text(created)).id

            const store = require('../lib/store')
            const resource = await store.getResource(jobId)
            resource.upstream = { system_id: 'agentic-harness', run_id: 'r-1' }
            await store.saveResource(resource)

            // Now close the policy. Steering that run must still be recordable.
            setMode('agent-runs-only')
            const body = await callTool('append_step', {
                job_id: jobId,
                kind: 'steering',
                signal: 'correct',
                content: 'Offer was $200; the campaign is $600.',
                source: 'desktop-ai'
            })
            expect(refused(body)).toBeFalsy()
        })

        test('but NOT appending to a run no agent ever touched', async () => {
            setMode('open')
            const created = await callTool('start_job', { title: 'Hand-made notes', project: 'Comcast Intake' })
            const jobId = JSON.parse(text(created)).id

            setMode('agent-runs-only')
            const body = await callTool('append_step', {
                job_id: jobId,
                kind: 'doc',
                content: 'Some notes from a chat.',
                source: 'desktop-ai'
            })
            expect(refused(body)).toBe(true)
            expect(text(body)).toMatch(/not an agent run/i)
        })
    })

    describe('the gate is on the target, not the caller', () => {
        test('a chat client may steer an agent run; the agent pipeline is not the only permitted author', async () => {
            setMode('open')
            const created = await callTool('start_job', { title: 'Run', project: 'P' })
            const jobId = JSON.parse(text(created)).id
            const store = require('../lib/store')
            const r = await store.getResource(jobId)
            r.upstream = { system_id: 's', run_id: '1' }
            await store.saveResource(r)

            setMode('agent-runs-only')
            // source is a chat client, and that is fine - a human's correction
            // arrives through one, and refusing it would throw away the record
            // this product exists to keep.
            const body = await callTool('append_step', {
                job_id: jobId, kind: 'steering', signal: 'reject',
                content: 'Wrong audience.', source: 'desktop-ai'
            })
            expect(refused(body)).toBeFalsy()
        })
    })
})
