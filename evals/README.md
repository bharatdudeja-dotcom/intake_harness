# Evals

Separate from `src/**/*.test.ts` (`npm test`) on purpose. Unit tests use a
stubbed `LlmClient` to test this app's own code paths deterministically -
validation, fallback, provenance-threading - and stay fast, free, and in CI.
These call the **real, configured** LLM provider against **hand-reviewed
fixtures**, to measure something unit tests structurally can't: whether the
model's output is actually *good*, not just correctly *handled*.

They are a manual step, not a CI gate, until the suite is stable enough to
trust on every PR.

## Running

Requires `LLM_PROVIDER` set in `.env.local` (bedrock/anthropic/ollama) - an
eval file with no provider configured skips itself with a clear message
rather than failing.

```bash
npm run eval:intake       # extractIntake / extractFromAnswer
npm run eval:review       # detectRejectionLlm / triageRejectionLlm
npm run eval:audience     # synthesizePql
npm run eval:safety       # adversarial input vs. the deterministic guardrails
npm run eval:trajectory   # rules over the tool-call trace (path, not answer)
npm run eval:calibration  # judge-vs-human agreement (calibrate before trusting the judge)
npm run eval:all          # all of the above
```

`eval:trajectory` needs a live MCP endpoint (`MCP_ENDPOINT_URL` or
`MCP_GATEWAY_URL`), not an LLM - it grades deterministic probe reads. It skips
cleanly when neither is set.

### Online evals (sampled from real traffic)

```bash
npm run eval:online intake --limit 100     # or review / audience_creation
```

`eval:online` (scripts/online-eval.mjs) samples the most recent real
`task_runs` for one agent and records a summary into the same
`eval_runs`/`eval_results` tables, tagged `source='online'`. It reports the
**LLM-path rate** (how many recent runs used the real model vs. silently fell
back to the deterministic parser - the earliest drift signal for this app) and
the **model distribution** (flagging model drift when more than one model
answered in the window).

A crucial honesty point: online data has no hand-labeled expected answer, so
"passed" here means "completed on the real LLM path", a HEALTH signal, not a
correctness grade against a golden answer. To turn a real run INTO a correctness
fixture, use `eval:scaffold` (a human then labels it). The `/evals` UI marks
online runs with a badge and this caveat so the two are never confused.

### pass^k (reliability)

A single run of a non-deterministic model tells you little. Set `EVAL_REPEAT`
to run each fixture k times; a fixture only counts as passed when it passes on
**every** attempt (pass^k), and the k-of-n tally shows in its notes. Persisted
per run (`eval_runs.repeat_count`/`passk_count`) and per fixture
(`eval_results.attempts`/`passed_attempts`).

```bash
EVAL_REPEAT=5 npm run eval:audience   # each fixture 5x; reports pass^5
```

### Growing the set from real runs

`npm run eval:scaffold <task_run_id>` pulls a real `task_runs` row's
input/output into a fixture skeleton in the right `fixtures/<dir>`, with every
`expected`/`rubric` field marked `TODO`. A fixture records what SHOULD happen,
not what did — so correct the TODOs by hand before checking it in. (See "Where
fixtures come from" below.)

### Calibrating the judge

`npm run eval:calibration` grades the `fixtures/judge-calibration` set — each a
(question, rubric, answer, `humanVerdict`) — with the real judge and reports how
often it agrees with the human label. Run it (and grow the set toward the 50–100
the guide recommends) before trusting the judge, and re-run it whenever the
judge prompt or model changes.

## Eval levels

Following the eval guide's stack (unit / trajectory / outcome / safety /
online):

- **Outcome** (`eval:intake`, `eval:review`, `eval:audience`) - does the
  model's output actually satisfy the task, graded structurally with a judge
  only where quality can't reduce to a comparison. This is the bulk of what's
  here today.
- **Safety** (`eval:safety`) - adversarial input (prompt injection in the
  brief, in a rejection comment, in a rejection reason, and at the PQL write
  boundary). A pass means this app's OWN deterministic guardrail caught it -
  provenance stayed honest, only real field keys/values survived validation,
  no unverified field reached a synthesized expression - NOT that the model
  was polite. Grading is entirely structural; there is deliberately no judge,
  because a guardrail either held or it didn't. These are the fixtures under
  `fixtures/safety-*`.

- **Trajectory** (`eval:trajectory`) - grades the PATH, not the answer: did the
  agent probe the union schema view, stay inside its read-only tool set (no
  `_create`/`_update`/`_delete`), and stay under a call budget. Graded with
  RULES over the trace (`evals/lib/trajectory.ts`: `mustCall`, `mustNotCall`,
  `mustNotCallMatching`, `mustPrecede`, `maxCalls`), not an exact reference
  sequence - because the probes are response-dependent (aep.ts asks the union
  view first and only falls through to list+sample when it's empty), so a
  fixed sequence would be brittle against a live sandbox. The trace itself is
  the SAME `withToolCallLog` output production records to
  `task_runs.metadata.toolCalls` - no new instrumentation. Fixtures under
  `fixtures/trajectory-*`.

- **Online** (`eval:online`) - production behavior over time: samples recent
  real `task_runs`, records the LLM-path rate and model distribution as an
  `eval_runs` row tagged `source='online'`, and surfaces both in `/evals`. Its
  "pass" is a health signal ("ran on the LLM path"), not a correctness grade -
  see `scripts/online-eval.mjs`.

All five levels from the guide (unit → trajectory → outcome → safety → online)
now exist. `npm test` remains the unit level; the rest are the manual
`npm run eval:*` steps above.

Each run prints a per-fixture pass/fail table with why, plus an overall
score, in addition to vitest's own summary.

## Viewing results

Every run also writes its results to Postgres (`eval_runs`/`eval_results`,
`db/schema.sql`), best-effort - a DB failure is logged but never fails the
eval itself, and a run with `DATABASE_URL` unset just isn't saved. Browse
the history at `/evals` in the app (list of runs, and each run's
fixture-by-fixture pass/fail with notes) instead of scrolling back through
a terminal. This is view-only: nothing in the UI re-runs an eval or reaches
the LLM provider, it only reads what `npm run eval:*` already wrote.

## Adding a fixture

Drop a new `*.json` file in the right `fixtures/<dir>` - see any existing
fixture for the shape, and each `.eval.ts` file's own top for exactly which
fields it reads. A fixture needs an `id` (or the filename is used), the
input the real function takes, and an `expected`/`rubric` describing what a
correct answer looks like. No code change needed to pick it up.

**Where fixtures come from**: prefer real run history first -
`task_runs.input`/`output`/`metadata` in Postgres already has real briefs,
rejections, and PQL syntheses from real usage. Pull a candidate, read what
the app actually produced, correct it by hand if it's wrong (a fixture
records what SHOULD happen, not what happened), and check it in. A few
current fixtures (see their `note` field) exist specifically because a real
run got something wrong - `line_of_business` extracted as "Business (SMB)"
for an entirely residential/Xfinity brief, a stated field mislabeled as
"stated" - and are there to catch that exact regression. `review-rejection`/
`review-triage` fixtures are synthetic today (no real run has hit an actual
Workfront rejection yet) - swap in real ones as they happen.

## Grading philosophy

- **Structural first, judge only where structural genuinely can't tell.**
  Field-value matches, provenance (`stated` vs `derived`/`inferred`),
  `mustContain`/`mustNotContain` substring checks, and PQL's own
  fields-used-are-verified-present gate are all plain comparisons - no LLM
  judge is more reliable than an exact match when an exact match is possible.
- **The judge (`lib/judge.ts`) is reserved for genuine quality questions**:
  is this PQL expression's logic actually right, is this correction's
  explanation clear and correctly targeted. It costs a real LLM call per
  judged fixture - don't reach for it when a string comparison would do.
- **A hard structural gate can override a would-be judge call.** The PQL
  eval never asks the judge to grade an expression that referenced an
  unverified field or that the model should have declined to write - that's
  the app's own safety gate working (or failing), not a style question.
