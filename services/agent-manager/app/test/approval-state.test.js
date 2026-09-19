/**
 * The approval check reads Workfront's approval RECORDS, not its prose.
 *
 * It used to grep an LLM-generated object summary for the literal phrase
 * "approved this", take the first matching line as current, and expect
 * "**Status**: CODE". Any rewording, reordering or truncation by the summarizer
 * turned a real approval into "never approved" - an approval check that worked
 * most of the time and failed for no reason the user could see.
 *
 * These tests pin the two things that decide whether a campaign goes out: that
 * status codes are read from `redrock_approverStatus`, and what happens when
 * approver rows disagree.
 */

jest.mock('../lib/mcp-gateway', () => ({ callProxied: jest.fn() }))
jest.mock('../lib/settings', () => ({
    mcpServers: () => ({}),
    agentSystems: () => ({}),
    get: () => ({}),
    _setCache: () => {}
}))

const mcpGateway = require('../lib/mcp-gateway')
const { approverVerdict, structuredApprovalState } = require('../actions/mcp-server/tools')

const OBJ = '6aadceda00014e6c125707c77f9a703f'
const F = (f) => `redrock_approverStatus.redrock_approverStatus_${f}`

/** One approver-status row as find_workfront_data returns it. */
const row = (status, objId = OBJ) => ({
    [F('status')]: { value: status },
    [F('approvableObjCode')]: { value: 'OPTASK' },
    [F('approvableObjID')]: { value: objId },
    [F('approvedByID')]: { value: '' }
})

const answer = (rows) => { mcpGateway.callProxied.mockResolvedValue({ rows, totalCount: rows.length }) }

beforeEach(() => { mcpGateway.callProxied.mockReset() })

describe('approverVerdict', () => {
    // The field metadata lists codes; the query returns display names. Betting
    // on one of those is how this breaks again on a different tenant.
    test('reads the codes', () => {
        expect(approverVerdict('AD')).toBe('approved')
        expect(approverVerdict('RJ')).toBe('rejected')
        expect(approverVerdict('AA')).toBe('pending')
        expect(approverVerdict('NA')).toBe('none')
    })

    test('reads the display names the query actually returns', () => {
        expect(approverVerdict('Approved')).toBe('approved')
        expect(approverVerdict('Rejected')).toBe('rejected')
        expect(approverVerdict('Awaiting Approval')).toBe('pending')
        expect(approverVerdict('Not Available')).toBe('none')
    })

    test('anything unrecognised is not an approval', () => {
        for (const v of ['', null, undefined, 'something new', 'approve']) {
            expect(approverVerdict(v)).toBe('none')
        }
    })
})

describe('structuredApprovalState', () => {
    test('an approved request reads as approved', async () => {
        answer([row('Approved'), row('Not Available')])
        const state = await structuredApprovalState('OPTASK', OBJ)
        expect(state.approved).toBe(true)
        expect(state.status).toBe('AD')
    })

    test('stages with nobody yet acting is not an approval', async () => {
        answer([row('Not Available'), row('Not Available')])
        const state = await structuredApprovalState('OPTASK', OBJ)
        expect(state.approved).toBe(false)
        expect(state.status).toBe('NA')
    })

    test('an outstanding approver beats an approval already given', async () => {
        // Multi-stage: stage one approved, stage two still waiting. The request
        // is NOT approved yet, and reading the first row as the answer is
        // exactly how a half-finished approval would be treated as done.
        answer([row('Approved'), row('Awaiting Approval')])
        const state = await structuredApprovalState('OPTASK', OBJ)
        expect(state.approved).toBe(false)
        expect(state.status).toBe('AA')
    })

    test('when rows disagree and cannot be ordered, it fails closed', async () => {
        // There is no timestamp on an approver-status record, so a rejection
        // and an approval cannot be put in order. Reading that as approved is
        // the failure that matters: a campaign going out on an approval nobody
        // gave. A stale rejection only sends someone to look at Workfront.
        answer([row('Rejected'), row('Approved')])
        const state = await structuredApprovalState('OPTASK', OBJ)
        expect(state.approved).toBe(false)
        expect(state.status).toBe('RJ')
    })

    test("another object's approval is never read as this one's", async () => {
        // The condition argument is `condition`; passing `filters`, or a bare
        // clause, is accepted and silently ignored - the query then returns
        // every row in the tenant. That fails by handing back plausible data
        // rather than an error, so the rows are filtered again here.
        answer([row('Approved', 'some-other-object-entirely')])
        expect(await structuredApprovalState('OPTASK', OBJ)).toBeNull()
    })

    test('no rows means defer to the summary, not "approved"', async () => {
        // An object approved by a plain status change has no approval process
        // and so no rows. null sends the caller to the prose fallback.
        answer([])
        expect(await structuredApprovalState('OPTASK', OBJ)).toBeNull()
    })

    test('an unreadable query is not an approval', async () => {
        mcpGateway.callProxied.mockRejectedValue(new Error('gateway down'))
        expect(await structuredApprovalState('OPTASK', OBJ)).toBeNull()
    })

    test('it asks Workfront with the condition shape that is honoured', async () => {
        answer([row('Approved')])
        await structuredApprovalState('OPTASK', OBJ)
        const [tool, args] = mcpGateway.callProxied.mock.calls[0]
        expect(tool).toBe('workfront-adobe__insights_find_workfront_data')
        // `condition` wrapping a `conditions` array - not `filters`, and not a
        // bare clause, both of which are ignored without complaint.
        expect(args.condition.operator).toBe('and')
        expect(args.condition.conditions[0]).toEqual({
            fieldId: F('approvableObjID'),
            operator: 'eq',
            values: [OBJ]
        })
    })
})
