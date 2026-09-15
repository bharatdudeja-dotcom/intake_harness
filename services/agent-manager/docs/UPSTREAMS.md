# UPSTREAMS.md — phase 0 discovery

**Probed:** 15 September 2026, ~17:30 UTC. Read-only HTTP (`GET`/`OPTIONS`) only; no run was started, nothing was written to any upstream.

Three upstreams were named in the kickoff brief. One is reachable and was fully characterised. One is reachable but locked. One could not be found at all.

| Upstream | Status | Blocking on |
|---|---|---|
| Chauncey's system, `34.203.238.63:3000` | **Reachable, unauthenticated, characterised** | nothing |
| Workfront tenant, `taplondonptrsd.my.workfront.com` | **HTTP 401** — no credentials | Chauncey / Workfront admin |
| Josh's story files | **Not found** in any Tap SharePoint or OneDrive we can read | Josh, directly |

---

## 1. Chauncey's system

### It is not a repository

The brief calls `http://34.203.238.63:3000/` "Chauncey's repo ... self-hosted, not github.com". It is not a git host. It is **the running application**: a Next.js app titled **"Agentic Harness"**, `<meta name="description">` = *"3-agent audience-creation pipeline orchestrator"*.

There is no Gitea/Forgejo API on it (`/api/v1/version` → 404). **We have not read his source code.** Everything below is inferred from the live HTTP surface and from real data in his database. Ask him separately for the actual repo.

### Transport and auth

**Plain HTTP JSON over Next.js route handlers. There is no MCP server, and there is no authentication.**

| Route | Methods | Notes |
|---|---|---|
| `/` | GET | UI; lists the four agents |
| `/runs` | GET | UI |
| `/api/runs` | GET, POST | list runs / start a run |
| `/api/runs/{run_id}` | GET | run + its task_runs |
| `/api/agents/intake` | POST | Agent 1 |
| `/api/agents/review` | POST | Agent 2 |
| `/api/agents/audience-creation` | POST | Agent 3 |
| `/api/agents/escalation` | POST | Agent 4 |

404 on `/mcp`, `/api/mcp`, `/sse`, `/api/tools`, `/api/agents`, `/health`.

The home page states the design in its own words: *"Submits a request through the 3-agent pipeline, **one HTTP call per agent, in order**. A 4th agent handles escalation if a run fails."* Ownership shown in the UI: intake = Dev 1, review = Dev 2, audience-creation = Dev 3, escalation = **Unassigned**.

**No API key, no bearer token, no session.** Anyone who can route to that IP can read every run and start new ones. See §4.

### The join key — the thing that mattered most

Confirmed, and better than hoped. Two identifiers, both stable:

- `run_id` — a UUID, one per intake. **This is our join key.** It is what `POST /api/runs` returns and what `/api/runs/{id}` accepts.
- `task_run_id` — a serial integer (`"7"`, `"8"`, `"9"`), **globally sequential across all runs**, not per-run. One per agent step.

Both are exposed in the API response, so Agent Manager can attach cross-run memory without any change on his side. `runs.upstream_task_run_id` in the brief's schema is the wrong shape: the grain is wrong (his `task_run` is per *step*, our `run` is per *intake*) and the name implies one id where there are many. It should be `runs.upstream_run_id` (uuid, unique), plus `events.upstream_task_run_id` (the per-step integer). That is a one-line schema fix now and a migration later.

### Observed schema

`GET /api/runs/{id}` returns `{run, taskRuns[]}`:

```jsonc
run: {
  run_id: uuid,
  status: "running" | "completed",        // "failed" presumed, not observed
  current_step: 0..3,
  input: { brief: string },               // the marketer's raw prompt
  created_at, updated_at                  // ISO-8601 UTC
}
taskRuns[]: {
  task_run_id: "7",                        // serial, as a string
  run_id: uuid,
  task_id: "intake" | "review" | "audience_creation",   // note: underscore here,
                                                        // hyphen in the URL path
  step_index: 0 | 1 | 2,
  status: "completed",
  input: {...}, output: {...},             // each step's output is the next step's input
  message: null,
  metadata: { loopCount: 0 },              // intake only; {} on review
  started_at, finished_at, duration_ms, created_at
}
```

Four runs exist in his database. Three completed, one has been stuck `running` at `current_step: 0` with **zero** task_runs since 02:22 on 15 September — a crashed run that nothing reaps.

Agent 3's stub output is exactly as the brief describes:

```json
{"buildPath":"aep_rule_builder","identityGap":{"hasGap":false,"details":null},
 "statusMessage":"Stub: audience creation not yet implemented.","predictedCount":null,
 "attributesAvailable":true,"openAttributeRequest":{"status":"not_opened","requestId":null,"ageSeconds":null}}
```

Runs complete in **~2 seconds**, essentially all of it a fixed 2s inside intake. There is no real agent latency yet.

---

## 2. Where the brief and the upstream disagree

Five contradictions. The first two change the architecture.

### 2.1 There is no `tools/list` to build a registry from — **blocking**

The brief: *"Agent registry — dynamic, from `tools/list`"*, the facade *"mounts Chauncey's agent MCP"*, and *"If you type four agent names into source code, you have made a mistake."*

His agents are not MCP tools. They are four hardcoded Next.js route paths, and **he exposes no index of them** — `/api/agents` is a 404. The only machine-readable enumeration of the four agents anywhere is the hardcoded list rendered in his home page HTML.

The constraint is still right; the mechanism named for it does not exist. Three options:

1. **Ask Chauncey to add `GET /api/agents`** returning `{id, name, version, capabilities, path}`. Cheapest, correct, and it is his system's own job to describe itself. **Recommended — raise this today.**
2. **A registry seeded from config, not source.** Agent Manager's `agents` table is populated from a YAML/env descriptor, editable without a deploy, and `adapters/chauncey.py` maps `agent_id → path`. Honours the spirit of the constraint (dashboard filters still read the registry; adding a fifth agent is config, not code) while we wait for (1).
3. Scrape his home page. No.

Take (2) now so nothing is blocked, and (1) when he can.

### 2.2 The pipeline is 3 agents, not 4 — and a failure cannot currently reach Agent 4

The brief describes four agents in a row. His own description: three in the pipeline, *"a 4th agent handles escalation **if a run fails**"*.

That branch has never fired, and the observed data shows why it cannot. In run `f152405e`, intake's grounding call failed outright:

```json
"groundingHits": {"error": "MCP tool \"search_knowledge_base\" failed: Unknown tool: search_knowledge_base"}
```

**The step still reported `status: "completed"`, and the error was passed downstream as data.** Review passed it through. Audience-creation swallowed it. The run is recorded as a clean success. `search_knowledge_base` — the one real tool Agent 1 calls — is **broken on the live system right now**, and no status anywhere reflects that.

Two consequences:

- Agent 4's brief ("a real taxonomy once the other three produce real errors") is further off than it looks: errors are not being *raised*, they are being *embedded*. Until failures set `status: "failed"`, the escalation path is unreachable and there is nothing for a taxonomy to classify.
- **It is also the clearest possible evidence for Agent Manager's thesis.** A per-run view says this run succeeded. Only something reading across runs and reconciling asserted against observed notices that the same tool has failed silently every time. We should show exactly this in the first demo.

Raise the `search_knowledge_base` failure with Chauncey as a bug, separately from our project.

### 2.3 Our capture cannot be "a property of the call path" for agent traffic

The brief's strongest design claim is that routing everything through one MCP means *"the marketer cannot forget to log and an agent cannot skip it."*

That holds for **Workfront** traffic — we proxy the official connector and see every call. It does **not** hold for **intra-pipeline** traffic. His orchestrator calls agent 1 then 2 then 3 server-side. We invoke the pipeline and see the boundary; we do not see what happens inside it except through his `/api/runs/{id}` response.

That response is, fortunately, rich — full input/output/timing per step. So the capture is good; it is **polled and reconstructed**, not intercepted. Say so plainly rather than claiming an interception we do not have. `AgentResult.sub_calls` in the adapter contract can only be filled from his `taskRuns[]`, and the sub-calls of the *tools* each agent called (his `search_knowledge_base` call, Agent 3's AEP calls) are **not visible to us at all** — they appear only as embedded output, if at all.

### 2.4 `AgentResult.status` — half the vocabulary is aspirational

The contract lists `completed | needs_input | blocked | failed`. Only `completed` has ever been observed on a task_run; only `running`/`completed` on a run. `needs_input` is Agent 1's *gap*, not its behaviour. Fine to code the full enum — just do not build the gate flow on the assumption that `needs_input` will arrive before Dev 1 implements it. **`loop_count` will read 0 forever until then**, which means B1's health metric ("more than two rounds means the agent failed") has nothing to measure yet. Build the measurement; expect a flat line at first.

### 2.5 `metadata.loopCount` exists but is per-step and inconsistent

Present as `{"loopCount": 0}` on intake, `{}` on review, and on audience-creation `metadata` is a full echo of `input` instead. Read `loopCount` defensively from the intake step only; do not assume a uniform metadata shape.

---

## 3. Workfront

### The tenant

`https://taplondonptrsd.my.workfront.com/` returns **HTTP 401**. We have no credentials. Access was requested from Chauncey; still outstanding. The `wf_core_project_*` / `wf_core_issue_*` names that Agents 1 and 2 use remain, in Chauncey's own words, *"a draft guess, not confirmed against Comcast's real Workfront object model"* — **and they are still unverified.** Nothing may be built that depends on their shape.

### The official connector — confirmed to exist, and it constrains us

Adobe does publish an official Workfront MCP server, which settles the section 10 posture question in our favour.

- **Endpoint:** `https://mcp.workfront.adobe.com/mcp/v1/workfront`
- **Transport:** streamable HTTP
- **Auth:** OAuth 2.0 (default), or service-to-service tokens via Adobe Developer Console; `Authorization: Bearer <token>`, plus a `wf-url: <subdomain>.my.workfront.com` header to select the instance
- **Scope:** projects, tasks, issues, approvals, Planning records, reporting queries — acting as the signed-in user, under that user's own permissions

Four prerequisites, each a way this could stall, and all four need an answer from a Workfront admin before the first build's step 3:

1. **Write tools are OFF by default.** Read-only tools are on; write tools must be explicitly enabled by an admin. Our first vertical slice creates a Workfront request. **Without this toggle, step 3 of the first build cannot run at all.** Ask before the slice is written, not after.
2. **The instance must be enabled on Adobe IMS.** Unconfirmed for this tenant.
3. **Availability has been limited to AWS-hosted customers.** Unconfirmed for this tenant.
4. **One connection authenticates to a single instance.** Relevant if a Tap sandbox and Comcast production are ever both in play.

Adobe does not publish the tool names in the overview or configuration pages. We get them from `tools/list` on first authenticated connect — so **the actual tool surface is still unknown**, and `adapters/workfront.py` must be written against whatever that returns, not against the `wf_core_*` guesses.

Note also that OAuth "as the signed-in user" sits in tension with the brief's section 13 first build, where a *reconciler* and a *Cloud Scheduler sweep* read Workfront outside any user's session. A service-to-service token is the mechanism for that, and it does **not** act as the user. Decide deliberately which identity does the reconciling and record it in `DECISIONS.md` — it is a data-access question Comcast will ask.

**Sources:** [MCP server overview](https://experienceleague.adobe.com/en/docs/workfront/using/basics/workfront-mcp-server/workfront-mcp-server-overview) - [Configure the MCP server](https://experienceleague.adobe.com/en/docs/workfront/using/basics/workfront-mcp-server/configure-workfront-mcp-server) - [Use the MCP server](https://experienceleague.adobe.com/en/docs/workfront/using/basics/workfront-mcp-server/use-workfront-mcp-server)

---

## 4. One thing to raise outside our scope

`34.203.238.63:3000` sits on a public IP with **no authentication on any route**, including `POST /api/runs` and the four agent endpoints. Today it holds four test briefs and no client data. The moment it touches a real Workfront tenant or real Comcast briefs, it becomes an open endpoint holding client data and an open endpoint that can spend money against Adobe APIs.

Not ours to fix, and not a reason to slow down now. But Agent Manager's entire pitch is a record defensible to Comcast, and we would be building that on top of a system anyone can write to. Flag it to Chauncey before the first run against a real tenant.

---

## 5. Open questions, owned

| # | Question | Ask | Blocks |
|---|---|---|---|
| 1 | Can you add `GET /api/agents` returning id/name/version/capabilities? | Chauncey | dynamic registry (workaround in place) |
| 2 | `search_knowledge_base` fails on every live run and the step still reports `completed`. Bug? | Chauncey | Agent 1 grounding; Agent 4 having anything to classify |
| 3 | Will failures ever set `status: "failed"` on a run or task_run? | Chauncey | escalation path, gates |
| 4 | Where is the actual source repo? | Chauncey | adapter fidelity |
| 5 | Workfront tenant access | Chauncey | section 3 entirely |
| 6 | Are **write** MCP tools enabled on the tenant? Is it IMS-enabled and AWS-hosted? | Workfront admin | first build, step 3 |
| 7 | Which identity reconciles — user OAuth or service-to-service? | us, then record | reconciler, scheduler sweep |
| 8 | The four story files | Josh | `docs/STORY.md`, all UI copy |

---

## 6. Josh's story files

Searched every SharePoint site and OneDrive readable from this account for "Agentic Hero's Journey". **Zero matches.** The four named files — `Agentic Hero's Journey Master Presentation.pptx`, `Agentic Hero's Journey - Story Coach Report 2.pdf`, `It's Not Magic, It's Method - TAP Analyst Playbook 1.pptx` and `TAP Story Coach (Claude Skill) 4.zip` — are not in any Tap tenant location we can reach. The brief's "unverified" flag stands, unchanged. He has to send them.

Per the brief, **no story-derived copy goes into the UI until those files are read.** Until then use plain descriptive labels (Runs, Queue, Knowledge) and rename once `docs/STORY.md` exists.
