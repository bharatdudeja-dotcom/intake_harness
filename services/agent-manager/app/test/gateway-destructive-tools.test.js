/**
 * An assistant is not handed tools that destroy things.
 *
 * Every discovered gateway tool used to be registered for every caller, which
 * put 411 tools in front of Claude Desktop - 49 of them destructive, against a
 * live Adobe tenant. `adobe_delete_sandbox` was one of them, and
 * `adobe_delete_dataset` another. There is no confirmation step between an
 * assistant and this gateway and no undo behind it, so a marketer's ambiguous
 * sentence was one plausible tool choice away from deleting a sandbox.
 *
 * Two things have to stay true, and they pull in opposite directions, which is
 * why both are pinned here:
 *
 *   - a person or an assistant is never offered an irreversible upstream tool;
 *   - the PIPELINE still gets all of them, because its agents are code, call
 *     tools by name, and enforce their own per-agent allowlist upstream.
 *
 * Registration is the enforcement point rather than a display filter. Verified
 * against the live server: a tool that is not registered answers "Tool <name>
 * not found" instead of running. So withholding removes the capability.
 */

const path = require('path')

const INDEX = path.join(__dirname, '..', 'actions', 'mcp-server', 'index.js')

/**
 * The two rules under test, read out of the source rather than re-declared.
 *
 * Copying the regex into the test would let the two drift apart and the test
 * would keep passing while the product stopped blocking anything - which is
 * exactly the failure a safety test must not have.
 */
function rulesFromSource () {
    const src = require('fs').readFileSync(INDEX, 'utf8')

    const reMatch = src.match(/const DESTROYS_UPSTREAM = (\/.+\/[gimsuy]*)/)
    if (!reMatch) throw new Error('DESTROYS_UPSTREAM is gone from index.js')
    const body = reMatch[1].slice(1, reMatch[1].lastIndexOf('/'))
    const flags = reMatch[1].slice(reMatch[1].lastIndexOf('/') + 1)

    const pipeMatch = src.match(/function isPipelineCaller \(context\) \{\s*return ([^\n]+)/)
    if (!pipeMatch) throw new Error('isPipelineCaller is gone from index.js')

    return {
        destroys: new RegExp(body, flags),
        // eslint-disable-next-line no-new-func
        isPipelineCaller: new Function('context', `return ${pipeMatch[1].trim()}`),
    }
}

const { destroys, isPipelineCaller } = rulesFromSource()

describe('which upstream tools count as irreversible', () => {
    // Real names, taken from the live gateway on 19 Sep 2026.
    test.each([
        'adobe_delete_sandbox',
        'adobe_delete_dataset',
        'adobe_delete_schema',
        'adobe_delete_segment',
        'adobe_delete_profile_entity',
        'workflow_delete_any_object',
        'planning_delete_workspace',
        'comment-stream_delete_comment',
        'query_schedule_delete',
        'dataprep_delete_mapping_set',
    ])('withholds %s', (name) => {
        expect(destroys.test(name)).toBe(true)
    })

    /*
     * The other half of the rule, and the more important half to get right. A
     * filter that catches writes as well as deletes would stop the marketer
     * filing a request at all, and someone would "fix" it by removing the
     * filter.
     */
    test.each([
        'workflow_create_any_object',
        'workflow_update_any_object',
        'adobe_create_segment',
        'adobe_get_schema',
        'adobe_list_segments',
        'insights_search_fields',
        'insights_find_workfront_data',
        'insights_summarize_object',
        'comment-stream_create_comment',
        'query_run',
        'query_get_connection_parameters',
        'approvals_create_approval_from_template',
    ])('still offers %s', (name) => {
        expect(destroys.test(name)).toBe(false)
    })

    test('a server called "reset-service" does not take its own catalogue down', () => {
        // The check runs on the BARE tool name for exactly this reason: the
        // gateway prefixes every tool with the server it came from.
        expect(destroys.test('adobe_get_schema')).toBe(false)
        expect(destroys.test('reset-service__adobe_get_schema'.split('__')[1])).toBe(false)
    })
})

describe('who is treated as the pipeline', () => {
    test('the service key with no owner is the pipeline', () => {
        expect(isPipelineCaller({ authMode: 'api-key' })).toBe(true)
    })

    test('a personal access key is a person, not the pipeline', () => {
        // Same auth mode, but it resolved to an owner - so it is somebody's
        // key, and somebody is driving an assistant with it.
        expect(isPipelineCaller({ authMode: 'api-key', userInfo: { email: 'a@b.com' } })).toBe(false)
    })

    test.each([
        ['oidc', { authMode: 'oidc', userInfo: { email: 'a@b.com' } }],
        ['user-login', { authMode: 'user-login', userInfo: { email: 'a@b.com' } }],
        ['auth bypassed', { authMode: 'none' }],
        ['nothing at all', {}],
        ['undefined', undefined],
    ])('%s is interactive, so it gets the smaller surface', (_label, ctx) => {
        expect(isPipelineCaller(ctx)).toBe(false)
    })
})
