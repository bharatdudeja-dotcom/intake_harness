/**
 * A Settings change has to reach the code that sends the run.
 *
 * This is the bug these tests exist for: config/agent-systems.json is a SEED,
 * and Settings overrides it, but resolve() read the seed file directly. So
 * pointing the harness at a different host from Settings looked like it worked -
 * list_agent_systems showed the new base_url, check_agent_system talked to the
 * new host - while start_intake went on sending every run to the old one. The
 * override was correct, stored, and simply never consulted.
 *
 * It was found by noticing a run arriving on a machine that should not have had
 * it, which is a bad way to find it. Hence a test per read path.
 */

const agentSystems = require('../lib/agent-systems')

const LOCAL = 'http://host.docker.internal:3100'

/** What Settings writes when someone repoints the harness. */
const OVERRIDE = [{ id: 'agentic-harness', base_url: LOCAL, active: true }]

beforeEach(() => agentSystems.reset())

describe('agent-system overrides reach every read path', () => {
    test('the seed is there to begin with, so the test is comparing against something', () => {
        const seeded = agentSystems.list().find(s => s.id === 'agentic-harness')
        expect(seeded).toBeTruthy()
        expect(seeded.base_url).not.toBe(LOCAL)
    })

    test('list() reflects an override', () => {
        const s = agentSystems.list(OVERRIDE).find(x => x.id === 'agentic-harness')
        expect(s.base_url).toBe(LOCAL)
    })

    test('get() reflects an override', () => {
        expect(agentSystems.get('agentic-harness', OVERRIDE).base_url).toBe(LOCAL)
    })

    test('resolve() BY ID reflects an override', () => {
        const { system, error } = agentSystems.resolve('agentic-harness', undefined, OVERRIDE)
        expect(error).toBeNull()
        expect(system.base_url).toBe(LOCAL)
    })

    test('resolve() with NO id - the path start_intake uses - reflects an override', () => {
        // The regression lived exactly here. Every other read was correct, so
        // the registry looked right everywhere a person could see it, and the
        // one caller that actually sends the run used the seed.
        const { system, error } = agentSystems.resolve(undefined, undefined, OVERRIDE)
        expect(error).toBeNull()
        expect(system.base_url).toBe(LOCAL)
    })

    test('an override can activate a system the seed has switched off', () => {
        const off = agentSystems.list().find(s => !s.active)
        expect(off).toBeTruthy()
        const on = [{ id: off.id, active: true, base_url: 'https://example.test', practice: off.practice }]
        expect(agentSystems.get(off.id, on).active).toBe(true)
    })

    test('an override can switch a system OFF, and resolve() must stop choosing it', () => {
        const { system } = agentSystems.resolve(undefined, undefined,
            [{ id: 'agentic-harness', active: false }])
        // With the only active system disabled there is nothing to resolve to.
        // Silently falling back to the seed would send runs to a host an admin
        // had deliberately turned off.
        expect(system).toBeNull()
    })

    test('overrides merge onto the seed rather than replacing it', () => {
        // Settings writes only what changed, so the fields it does not mention
        // must survive - otherwise repointing a URL would wipe the paths that
        // tell us how to read that system.
        const s = agentSystems.get('agentic-harness', OVERRIDE)
        expect(s.base_url).toBe(LOCAL)
        expect(s.agents_path).toBeTruthy()
        expect(s.start_path).toBeTruthy()
    })
})
