/** Shared fixtures for the render probes. */
const RUNS = [
  {
    id: 'job-live', title: 'Q4 HSD Upsell', type: 'job', owner: 'bharat.dudeja@tapcxm.com',
    author: 'bharat.dudeja@tapcxm.com', project: 'Comcast Intake', segments: { project: 'Comcast Intake' },
    status: 'experimental', step_count: 5, version: 1, created: '2026-09-16T00:00:00Z',
    updated: '2026-09-16T01:00:00Z', updated_at: '2026-09-16T01:00:00Z',
    practice: 'workfront', models_used: ['claude-opus-5'], tokens_used: 4200,
    baked: false, cx_approved: false,
    upstream: { system_id: 'agentic-harness', run_id: 'r-1' },
    agents: ['intake'], agent_faults: ['intake']
  },
  {
    id: 'job-done', title: 'Xfinity Mobile Winback', type: 'job', owner: 'bharat.dudeja@tapcxm.com',
    author: 'bharat.dudeja@tapcxm.com', project: 'Comcast Intake', segments: { project: 'Comcast Intake' },
    status: 'approved', step_count: 7, version: 2, created: '2026-09-15T00:00:00Z',
    updated: '2026-09-15T09:00:00Z', updated_at: '2026-09-15T09:00:00Z',
    practice: 'workfront', models_used: ['claude-opus-5'], tokens_used: 9100,
    baked: true, cx_approved: false,
    upstream: { system_id: 'agentic-harness', run_id: 'r-0' },
    agents: ['intake', 'review', 'audience_creation'], agent_faults: []
  }
  ,
  {
    id: 'job-handmade', title: 'As-built architecture, verified 16 Sep', type: 'job',
    owner: 'bharat.dudeja@tapcxm.com', author: 'bharat.dudeja@tapcxm.com',
    project: 'Comcast Intake', segments: { project: 'Comcast Intake' },
    status: 'experimental', step_count: 2, version: 1,
    created: '2026-09-16T02:00:00Z', updated: '2026-09-16T02:00:00Z', updated_at: '2026-09-16T02:00:00Z',
    models_used: ['opus-5'], tokens_used: 1200, baked: false, cx_approved: false
    // deliberately NO upstream and NO agents: nothing here ever touched an agent
  }
]

const STEPS = [
  { id: 's1', job_id: 'job-live', order: 1, kind: 'message', content: '### The brief', format: 'md', status: 'experimental', source: 'agent-manager', tags: ['brief'] },
  { id: 's2', job_id: 'job-live', order: 2, kind: 'doc', content: '### Intake', format: 'md', status: 'experimental', source: 'agent-manager', tags: ['agent', 'intake', 'silent-failure'], provenance: { duration_ms: 1200, upstream_payload: { agent: 'intake', upstream_status: 'completed' } } },
  { id: 's3', job_id: 'job-live', order: 3, kind: 'decision', content: '### Time ledger', format: 'md', status: 'experimental', source: 'agent-manager', tags: ['ledger'] },
  { id: 's4', job_id: 'job-live', order: 4, kind: 'steering', signal: 'correct', content: 'Wrong audience', status: 'approved', source: 'ide-agent', tags: [] }
]

const TOOLS = {
  list_jobs: RUNS,
  list_resources: RUNS,
  list_projects: [{ name: 'Comcast Intake', status: 'active' }],
  list_steps: STEPS,
  get_job: { ...RUNS[0], view: 'full', steps: STEPS },
  list_active_tasks: [{ id: 't1', title: 'Hand to AEP', task_status: 'open', target_agent: 'aep', job_id: 'job-live' }],
  get_settings: { retention_days: 30, segmentation_levels: [{ key: 'project', label: 'Programme', default_label: 'Project' }, { key: 'epic', label: 'Epic', default_label: 'Epic' }, { key: 'story', label: 'Story', default_label: 'Story' }], kind_labels: {}, kinds: [{ type: 'decision', label: 'Decision', approval: 'auto' }], head_chefs: ['bharat.dudeja@tapcxm.com'], practices: [{ id: 'workfront', label: 'Workfront' }] },
  get_role: { role: 'head-chef', roles: ['head-chef', 'chef'], owner: 'bharat.dudeja@tapcxm.com', head_chefs: ['bharat.dudeja@tapcxm.com'] },
  list_cx_pending: [RUNS[1]],
  list_practices: { practices: [{ id: 'workfront', label: 'Workfront' }], my_practices: ['workfront'], my_default_practice: 'workfront' },
  get_cx_graph: { built: true, generated_at: '2026-09-16T01:00:00Z', job_count: 1, node_count: 3, edge_count: 2, owners: ['bharat.dudeja@tapcxm.com'], practices: ['workfront'], projects: ['Comcast Intake'], nodes: [{ id: 'job-done', node: 'job', label: 'Xfinity Mobile Winback', owner: 'bharat.dudeja@tapcxm.com', project: 'Comcast Intake', practice: 'workfront' }, { id: 'x1', node: 'ingredient', job: 'job-done', kind: 'doc', label: 'a', tags: ['agent', 'review'] }, { id: 'x2', node: 'ingredient', job: 'job-done', kind: 'message', label: 'b', tags: ['brief'] }], edges: [{ from: 'job-done', to: 'x1', rel: 'artifact' }, { from: 'job-done', to: 'x2', rel: 'artifact' }] },
  list_agent_systems: [{ id: 'agentic-harness', label: 'Xfinity Creative Intake', practice: 'workfront', active: true, base_url: 'http://34.203.238.63:3000', agents_path: '/api/tasks', start_path: '/api/runs', run_path: '/api/runs/{run_id}', input_key: 'brief', input_envelope: 'input', mcp_endpoint: 'https://cryuy4x9n5.execute-api.us-east-1.amazonaws.com/mcp', mcp_server_id: 'adobe-aec', auth_configured: false, notes: ['Polled, not intercepted.'] }],
  list_system_agents: { system: 'agentic-harness', agents: [
    { id: 'intake', label: 'Intake', owner: 'Uday' },
    { id: 'review', label: 'Review & Triage', owner: 'Bharat, Dylan, Jeff' },
    { id: 'audience_creation', label: 'Audience Creation', owner: 'Chauncey' },
    { id: 'escalation', label: 'Escalation', owner: 'parked' }
  ] },
  list_mcp_servers: [
    { id: 'adobe-aec', label: 'Adobe Experience Cloud MCP', practice: 'aep', endpoint: 'https://x/mcp', active: true, auth_configured: false, auth_source: null, instance: null, notes: ['238 tools.'] },
    { id: 'workfront-adobe', label: 'Workfront MCP (Adobe)', practice: 'workfront', endpoint: 'https://y/mcp', active: false, auth_configured: false, auth_source: '${WORKFRONT_TOKEN}', instance: 'tap.my.workfront.com', notes: [] }
  ],
  list_users: [{ id: 'bharat.dudeja@tapcxm.com' }],
  list_user_roles: {},
  get_segmentation_config: { levels: [{ key: 'project', label: 'Programme' }] }
}


export { RUNS, STEPS, TOOLS }
