# TAP Cookbook — end-to-end validation report

**Date:** 2026-08-13
**Target:** live stage deployment (`110557-tapmcpconnector-stage`, workspace `application`)
**Branch:** `feature/e2e-validation-and-docs` → PR into `develop` (not merged to `main`)
**Method:** every registered MCP tool driven over HTTPS against the deployed action, as four
different real identities — not mocks, not unit tests.

## 1. Verdict

The Cookbook works end to end and is usable by a real team today. Four people share one
deployment, each sees their own private work, and knowledge only becomes shared when a human
says so.

| Gate | Result |
|---|---|
| Behaviour assertions (live stage) | **23 / 23 pass** |
| MCP tools exercised | **48 / 48 pass** |
| Unit + integration tests | **458 pass, 31 suites** |
| Lint (`eslint`) | **0 errors** (12 pre-existing warnings) |
| Portability check (D21/D34) | **pass** — 16 core files, 0 coupling markers |
| Secrets in the repo | **none** — keys live only in `.env` / git-ignored `keys.local.json`; verified with `git check-ignore` and a value-level grep across every committed file |

Full call-by-call log: [`e2e-transcript.md`](./e2e-transcript.md) (keys redacted).
Re-runnable with `node validation/e2e.mjs`.

## 2. What was actually proved on the live stage

Not "the endpoint responded" — these are behavioural claims, each with a live assertion:

**Identity is real.** Four keys resolve to four distinct owners with distinct roles. An unmapped
key is refused with 401. `bharat` holds chef + head-chef + admin; `viewer` resolves to exactly
`["viewer"]` and never widens.

**Privacy holds.** alice cannot see bob's un-approved job and bob cannot see alice's — proved
from both directions, because one-directional isolation is a coin flip, not a guarantee. The
moment alice's job is baked and approved, bob sees it. This is the whole product promise:
private until you choose otherwise.

**The bake gate is not decorative.** Baking a job with zero approved ingredients is refused
with an explanation of what to do instead. It succeeds once an ingredient is certified.

**The CX graph is approved-only, and cross-user.** A baked-but-unadmitted job is absent from
the graph. A plain chef cannot admit anything. After the head chef admits it, it appears (8
nodes). bob's private work is *not* in the graph. `headchef_reject` refuses jobs that never
reached the queue.

**Capture is complete.** All 12 ingredient kinds were appended and read back: message, code,
diagram (mermaid *and* raw SVG), image, decision, doc, handoff, config, and the three steering
kinds (affirm / reject / correct), with model and token counts recorded.

**Reuse works, duplication doesn't.** `search_resources` finds captured work; calling
`save_resource` again with an existing id updates in place (1 → 1 job), rather than spawning a
near-duplicate.

**Practices partition knowledge.** alice's job inherits `practice=aem` and bob's inherits
`braze` with no extra effort, and the AEM filter returns only AEM work.

**Read-only means read-only.** The viewer identity reads jobs and the CX graph but is refused
every write, with an error that explains how to get access.

## 3. Ranked issue log

Severity is by user consequence, not by how hard it was to find. Everything P0–P2 is **fixed and
re-verified live** in this pass.

### P0 — silent data loss

**1. `save_resource` evicted jobs from the Company CX Graph.** Updating a job in place
rebuilt it from a literal that omitted `cx_approved`, `cx_approved_by`, `cx_approved_at`. So the
normal, encouraged act of refining a job *after* the head chef admitted it silently removed it
from the shared graph — no error, no log, and the head chef would have to notice its absence to
know. Same bug dropped `practice`, so the job also disappeared from its own discipline's
filter. A pre-existing D64 integrity bug, found only because the E2E ran
`save → approve → admit → save again` in one sequence. **Fixed**: both preserved across update,
with regression tests that reproduce the exact sequence.

### P1 — permission boundary

**2. `headchef_reject` had no candidate gate.** `headchef_approve` checked that a job was baked
before touching it; its opposite did not. A head chef could therefore write rejection metadata onto
another owner's private, un-baked draft — work that was never submitted for review and that the
head chef should not have been able to affect at all. **Fixed**: refuses anything not baked, with a
message explaining that only baked jobs reach the queue. Live-asserted.

**3. The dashboard showed one shared cookbook to everyone.** The proxy fell back to the server-side
`SERVICE_API_KEY` whenever no IMS token was present. Since browser IMS login is not provisioned
yet, that fallback *was* the normal path — so every user opened the service identity's cookbook
(in practice, mine), which contradicts the product's core privacy claim. **Fixed**: the dashboard
asks for the viewer's own access key and forwards it upstream; requiring identity is now the
default, and a deployment must explicitly opt out to get the old shared behaviour. Verified live:
alice and bob open the same URL and see 2 and 3 jobs respectively.

### P2 — ergonomics that block a correct workflow

**4. `certify` hard-errored on the documented happy path.** Approving any step promotes its job
to `approved`. So a user who followed the instructions — capture, approve the good ingredients,
then certify the job — got `Job '…' is already approved`, an error for requesting a state the
job was already in. An agent seeing `isError` reasonably concludes something went wrong and
retries or reports failure. **Fixed**: idempotent, returning `already_approved: true` and naming
who recorded the original consent, so nothing is reported as a fresh approval.

### P3 — accepted, documented, not fixed in this pass

**5. `mcp-remote` cannot discover this server's authorization metadata.** It resolves AS metadata
only at the issuer's *origin root*, and Adobe I/O Runtime cannot serve a file at its origin root
(App Builder deploys only web-src assets referenced from `index.html` — control-tested with an
unreferenced probe file, which was also not deployed). This is why per-user browser OAuth is not
the CLI path today. Three options are recorded in `knowledge/DECISION-LOG.md` (D78): use the
Claude.ai connector UI, host AS metadata on a root-capable origin via the existing
`OAUTH_ISSUER_URL` seam, or keep API keys for CLI plus login for the dashboard. This pass takes
the third, which is a genuine workaround, not a stub: keys carry real per-user identity and roles.

**6. The interim static passcode is weak by construction.** A short shared code gates the
deployment; it is compared in a length-independent way to avoid leaking length, but it is not a
cryptographic control. It gates *access to the deployment*, not identity — identity is the access
key. Superseded when browser login lands.

**7. Practice filtering is backend-complete but not yet a dashboard control.** The MCP tools filter
by practice; the dashboard has no practice dropdown yet. Consultants filtering from their AI client
are served; dashboard users are not. Tracked for the UI pass.

### Non-issues (investigated, correct as designed)

- `approve_resource` on a baked job reports "already approved" — correct; bake is downstream of
  approval, so there is nothing to consent to.
- `find_similar` requires `query`, not `title` — correct; my first harness call was wrong, not the
  tool.
- Jobs appear in bob's list once alice bakes and approves them — correct; that is the sharing
  model working.

## 4. What I changed, in one place

| File | Change |
|---|---|
| `actions/mcp-server/tools.js` | preserve `cx_approved*` + `practice` on update; `headchef_reject` candidate gate; idempotent certify; single read-only choke point; `practice` param + filters; `list_practices` / `set_practices` / `set_user_practices` |
| `actions/dashboard-api/index.js` | per-user identity (`x-cookbook-user-key`), identity required by default, CORS + info advertisement |
| `web-src/index.html` | key gate modal, per-request identity header, "whose cookbook" in the header, switch-user |
| `lib/auth/apiKeys.js`, `lib/auth/index.js` | rich key → identity mapping (back-compatible with the string shape) |
| `lib/settings.js` | exclusive `viewer` role; practice helpers |
| `lib/store.js`, `config/settings.json` | practice storage, projection, filtering; seeded practices |
| `test/*` | +75 tests, including regressions for every fix above and a guard-integrity test asserting no mutating tool escapes the read-only gate |

## 5. How to re-verify

```bash
cd tap-portability-layer/connector
npx jest --coverage=false      # 458 tests
npx eslint actions lib test    # 0 errors
node scripts/portability-check.mjs
node validation/e2e.mjs        # live stage: 23/23 assertions, 48/48 tools
```

`validation/e2e.mjs` reads identities from git-ignored `keys.local.json` and redacts every key
before writing the transcript, so its output is safe to commit.
