import { query } from "@/lib/db";
import { ESCALATION, PIPELINE } from "./registry";
import { decisionFor, gateFor, type GateDecision, type GateId } from "./gates";
import type { AgentName, AgentRequest, AgentResponse, RunRow, TaskRow, TaskRunRow } from "./types";

/**
 * Runs the pipeline for a single submission: calls each agent's own API
 * route in order over real HTTP (not a direct function call), so every
 * agent stays an independently testable, independently deployable endpoint
 * - a dev can `curl localhost:3100/api/agents/audience-creation` on its own
 * without spinning up the rest of the pipeline.
 *
 * Every call is recorded as a task_runs row (run_id, task_id, step_index,
 * started_at/finished_at) - the traceability trail: what ran, per run, and
 * when. Stops at the first "needs_input" or "failed" step, matching the
 * doc's finding that most of the process is fine and the real problem is
 * silent waiting - a paused run is visible in `runs`, not a black box.
 *
 * Each agent also only ever receives the slice of `priorOutputs` its
 * registry entry declares via `contextAccess` - this function filters the
 * full accumulated history down to that allowlist before every HTTP call,
 * so an agent never receives a prior agent's output it isn't scoped to see
 * (paired with the tool allowlist enforced in lib/mcp-client.ts).
 *
 * A "failed" step additionally triggers Agent 4 - Escalation (B9 in the
 * requirements doc: "the process terminates without an audience, and
 * nothing is captured"). "needs_input" does NOT trigger it - that's an
 * expected, resumable pause, not a terminated run.
 *
 * AND IT STOPS AT GATES.
 *
 * The map has a decision at 1.5 ("Approved?") between phase 1 and phase 2,
 * and phase 3 is entered only from 2.7's Yes branch. This used to run all
 * three agents in one pass, ignoring both. The consequence was not cosmetic:
 * Agents 2 and 3 ran on unapproved briefs and reported `completed` having
 * respectively swallowed a failed comment read and built nothing at all.
 *
 * A gated agent is NOT CALLED and writes NO task_runs row. See gates.ts for
 * why that, rather than a "skipped" status, is the correct behaviour.
 */
export async function runPipeline(initialInput: unknown, baseUrl: string): Promise<RunRow> {
  const [run] = await query<RunRow>(
    `INSERT INTO runs (input) VALUES ($1::jsonb) RETURNING *`,
    [JSON.stringify(initialInput)],
  );

  return advance(run.run_id, 0, initialInput, {}, baseUrl);
}

/**
 * Continue a run that was waiting at a gate.
 *
 * Rebuilds the accumulated state from task_runs rather than keeping it in
 * memory, because the thing that opens a gate is a human deciding, and that
 * can happen days after the request was raised and in a different process.
 * The database is the only honest place for that state to live.
 */
export async function resumeRun(runId: string, baseUrl: string): Promise<RunRow> {
  const [run] = await query<RunRow>(`SELECT * FROM runs WHERE run_id = $1`, [runId]);
  if (!run) throw new Error(`No run ${runId}`);

  const rows = await query<TaskRunRow>(
    `SELECT * FROM task_runs WHERE run_id = $1 ORDER BY step_index, task_run_id`,
    [runId],
  );

  /*
   * Rebuild priorOutputs from what actually ran.
   *
   * Only `completed` rows contribute. A needs_input row's output is a
   * half-finished thing carrying questions, and feeding it forward as though
   * it were a result is how a paused run turns into a wrong one.
   */
  const priorOutputs: Partial<Record<AgentName, unknown>> = {};
  let lastOutput: unknown = run.input;
  let resumeAt = 0;
  for (const row of rows) {
    if (row.task_id === "escalation") continue;
    if (row.status !== "completed") continue;
    priorOutputs[row.task_id] = row.output;
    lastOutput = row.output;
    const idx = PIPELINE.findIndex((a) => a.name === row.task_id);
    if (idx >= 0) resumeAt = Math.max(resumeAt, idx + 1);
  }

  if (resumeAt >= PIPELINE.length) {
    // Everything already ran. Nothing to resume; report the run as it stands.
    return run;
  }

  return advance(runId, resumeAt, lastOutput, priorOutputs, baseUrl);
}

/**
 * Run the pipeline from `startStep` until it completes, pauses, fails or
 * reaches a closed gate. The one step loop both the initial run and every
 * resume go through, so the two cannot drift apart in what they enforce.
 */
async function advance(
  runId: string,
  startStep: number,
  initialInput: unknown,
  initialPriorOutputs: Partial<Record<AgentName, unknown>>,
  baseUrl: string,
): Promise<RunRow> {
  let currentInput: unknown = initialInput;
  const priorOutputs: Partial<Record<AgentName, unknown>> = { ...initialPriorOutputs };

  // Read once per advance: a gate decision cannot be made mid-pass, because
  // nothing in this loop waits for a human.
  const decisions = await listDecisions(runId);

  for (let stepIndex = startStep; stepIndex < PIPELINE.length; stepIndex++) {
    const agent = PIPELINE[stepIndex];

    // --- The gate, before anything else ------------------------------------
    const gate = gateFor(agent.name);
    if (gate) {
      const verdict = gate.check({ decisions, input: currentInput, priorOutputs });
      if (!verdict.open) {
        return block(runId, stepIndex, {
          gate_id: gate.id,
          map_step: gate.mapStep,
          label: gate.label,
          step_index: stepIndex,
          agent: agent.name,
          awaiting: verdict.awaiting,
          needs: verdict.needs,
          ref: verdict.ref,
        });
      }
    }

    const startedAt = new Date();

    const scopedPriorOutputs: Partial<Record<AgentName, unknown>> = {};
    for (const visibleAgent of agent.contextAccess) {
      if (visibleAgent in priorOutputs) {
        scopedPriorOutputs[visibleAgent] = priorOutputs[visibleAgent];
      }
    }

    /*
     * The gate decision travels WITH the input.
     *
     * Agent 2 has two jobs and the decision at 1.5 is what picks between them:
     * approved goes to 2.1 (issue converted to project form), rejected goes to
     * 1.5a and triages the rejection. Handing it the decision means it does not
     * have to infer which it is, and - the part that matters - it does not have
     * to go looking for the rejection reason in a Workfront comment stream it
     * may not be able to read. B2 says nothing reads the rejection reason; the
     * fix is to carry it, not to hunt for it.
     */
    const agentInput = withGateDecision(currentInput, gate?.id, decisions);

    let response: AgentResponse;
    try {
      response = await callAgent(baseUrl, agent.path, {
        runId,
        input: agentInput,
        priorOutputs: scopedPriorOutputs,
      });
    } catch (err) {
      response = { status: "failed", message: (err as Error).message };
    }

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    await query<TaskRunRow>(
      `INSERT INTO task_runs
         (run_id, task_id, step_index, status, input, output, message, metadata,
          started_at, finished_at, duration_ms)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10, $11)`,
      [
        runId,
        agent.name,
        stepIndex,
        response.status,
        JSON.stringify(agentInput),
        JSON.stringify(response.output ?? null),
        response.message ?? null,
        JSON.stringify(response.metadata ?? {}),
        startedAt.toISOString(),
        finishedAt.toISOString(),
        durationMs,
      ],
    );

    if (response.status !== "completed") {
      if (response.status === "failed") {
        await runEscalation(runId, baseUrl, {
          failedTask: agent.name,
          failedStepIndex: stepIndex,
          message: response.message ?? null,
          input: agentInput,
        }, priorOutputs, stepIndex + 1);
      }

      const [updated] = await query<RunRow>(
        `UPDATE runs SET status = $2, current_step = $3, blocked_on = NULL, updated_at = NOW()
         WHERE run_id = $1 RETURNING *`,
        [runId, response.status, stepIndex],
      );
      return updated;
    }

    priorOutputs[agent.name] = response.output;
    currentInput = response.output;
  }

  const [completed] = await query<RunRow>(
    `UPDATE runs SET status = 'completed', current_step = $2, blocked_on = NULL, updated_at = NOW()
     WHERE run_id = $1 RETURNING *`,
    [runId, PIPELINE.length],
  );
  return completed;
}

/** Park the run at a gate. No task_runs row is written: nothing ran. */
async function block(
  runId: string,
  stepIndex: number,
  blockedOn: NonNullable<RunRow["blocked_on"]>,
): Promise<RunRow> {
  const [updated] = await query<RunRow>(
    `UPDATE runs SET status = 'awaiting_approval', current_step = $2,
            blocked_on = $3::jsonb, updated_at = NOW()
     WHERE run_id = $1 RETURNING *`,
    [runId, stepIndex, JSON.stringify(blockedOn)],
  );
  return updated;
}

/**
 * Attach the decision that opened this agent's gate to its input.
 *
 * Returns the input untouched when there is no gate or no decision, so an
 * agent without a gate sees exactly what it saw before this change.
 */
function withGateDecision(input: unknown, gateId: GateId | undefined, decisions: GateDecision[]): unknown {
  if (!gateId) return input;
  const decided = decisionFor(decisions, gateId);
  if (!decided) return input;
  if (input == null || typeof input !== "object" || Array.isArray(input)) return input;

  const base = input as Record<string, unknown>;
  return {
    ...base,
    gateDecision: {
      gate_id: decided.gate_id,
      decision: decided.decision,
      decided_by: decided.decided_by,
      reason: decided.reason,
      decided_at: decided.decided_at,
    },
    // The rejection reason, under the name Agent 2's triage already reads. A
    // rejection recorded at the gate needs no comment-stream lookup.
    ...(decided.decision === "rejected" && decided.reason
      ? { rejectionReason: decided.reason }
      : {}),
  };
}

/** Every decision recorded against this run, oldest first. */
export async function listDecisions(runId: string): Promise<GateDecision[]> {
  return query<GateDecision>(
    `SELECT gate_id, step_index, decision, decided_by, reason, evidence, decided_at
       FROM run_gates WHERE run_id = $1 ORDER BY decided_at, gate_run_id`,
    [runId],
  );
}

/**
 * Record a decision at a gate, then carry on.
 *
 * The decision is written BEFORE the pipeline advances, and written whether or
 * not the advance then succeeds. A decision a human made is a fact about the
 * process; losing it because the next agent threw would be losing the one piece
 * of this the blockers doc says is not captured anywhere structured today.
 */
export async function decideGate(
  runId: string,
  input: {
    gateId?: string;
    decision: "approved" | "rejected";
    decidedBy: string;
    reason?: string | null;
    evidence?: Record<string, unknown>;
  },
  baseUrl: string,
): Promise<{ run: RunRow; decision: GateDecision }> {
  const [run] = await query<RunRow>(`SELECT * FROM runs WHERE run_id = $1`, [runId]);
  if (!run) throw new Error(`No run ${runId}`);

  /*
   * Which gate is being decided.
   *
   * Defaulting to the gate the run is actually waiting at means a caller does
   * not have to know the gate vocabulary to approve something - which matters,
   * because the caller is an assistant relaying a human. An explicit gateId
   * still wins, and a decision on a run that is not waiting is refused rather
   * than recorded against a guess.
   */
  const gateId = input.gateId || run.blocked_on?.gate_id;
  if (!gateId) {
    throw new Error(
      `Run ${runId} is not waiting at a gate (status "${run.status}"), so there is nothing to decide. ` +
      "Pass gateId explicitly if you mean to record a decision anyway.",
    );
  }

  /*
   * A GATE IS DECIDED ONCE.
   *
   * Two approvals arrived about thirty seconds apart - a client-side abort and
   * a retry - and each one recorded a decision and then advanced the pipeline.
   * Agent 3 therefore ran twice on the same brief, produced the same
   * needs_input twice, and the run carried two identical stages. Nothing
   * errored, so nothing showed it had happened twice except the duplicate rows.
   *
   * That is not just untidy. Downstream of this the agents WRITE - 2.1 creates
   * a Workfront project - so a non-idempotent approve is a duplicate-record
   * generator waiting for a flaky connection. Re-deciding is refused rather
   * than silently ignored, because a caller sending a second, DIFFERENT answer
   * (approve then reject) needs to be told it did not take effect.
   */
  const already = decisionFor(await listDecisions(runId), gateId as GateId);
  if (already) {
    if (already.decision !== input.decision) {
      throw new Error(
        `Gate ${gateId} on run ${runId} was already ${already.decision} by ${already.decided_by} ` +
        `at ${already.decided_at}. It cannot now be ${input.decision}: the pipeline has already acted ` +
        "on the first decision. Start a new run if the request has changed.",
      );
    }
    // Same answer again - an abort and a retry. Report the run as it stands
    // WITHOUT advancing it a second time.
    const [current] = await query<RunRow>(`SELECT * FROM runs WHERE run_id = $1`, [runId]);
    return { run: current, decision: already };
  }

  const stepIndex = run.blocked_on?.step_index ?? run.current_step;

  const [decision] = await query<GateDecision>(
    `INSERT INTO run_gates (run_id, gate_id, step_index, decision, decided_by, reason, evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING gate_id, step_index, decision, decided_by, reason, evidence, decided_at`,
    [
      runId,
      gateId,
      stepIndex,
      input.decision,
      input.decidedBy,
      input.reason ?? null,
      JSON.stringify(input.evidence ?? {}),
    ],
  );

  const resumedRun = await resumeRun(runId, baseUrl);
  return { run: resumedRun, decision };
}

/**
 * Best-effort call to the Escalation agent when a run fails. Never throws:
 * a broken escalation path must not mask the original failure, but it IS
 * still recorded as its own task_run - even escalation failing is
 * something B9 says must be captured, not silently dropped.
 */
async function runEscalation(
  runId: string,
  baseUrl: string,
  failure: { failedTask: AgentName; failedStepIndex: number; message: string | null; input: unknown },
  priorOutputs: Partial<Record<AgentName, unknown>>,
  stepIndex: number,
): Promise<void> {
  const scopedPriorOutputs: Partial<Record<AgentName, unknown>> = {};
  for (const visibleAgent of ESCALATION.contextAccess) {
    if (visibleAgent in priorOutputs) {
      scopedPriorOutputs[visibleAgent] = priorOutputs[visibleAgent];
    }
  }

  const startedAt = new Date();
  let response: AgentResponse;
  try {
    response = await callAgent(baseUrl, ESCALATION.path, {
      runId,
      input: failure,
      priorOutputs: scopedPriorOutputs,
    });
  } catch (err) {
    response = { status: "failed", message: (err as Error).message };
  }
  const finishedAt = new Date();

  await query<TaskRunRow>(
    `INSERT INTO task_runs
       (run_id, task_id, step_index, status, input, output, message, metadata,
        started_at, finished_at, duration_ms)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10, $11)`,
    [
      runId,
      ESCALATION.name,
      stepIndex,
      response.status,
      JSON.stringify(failure),
      JSON.stringify(response.output ?? null),
      response.message ?? null,
      JSON.stringify(response.metadata ?? {}),
      startedAt.toISOString(),
      finishedAt.toISOString(),
      finishedAt.getTime() - startedAt.getTime(),
    ],
  );
}

async function callAgent(baseUrl: string, path: string, body: AgentRequest): Promise<AgentResponse> {
  const res = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Agent at ${path} returned HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  return (await res.json()) as AgentResponse;
}

/**
 * A single run plus every task_runs row recorded for it, in step order, plus
 * the gate decisions and what it is waiting for.
 *
 * `gates` and `blocked_on` are part of the run's state, not decoration: a
 * reader who sees one stage and no second needs to be told the second is
 * waiting on an approval, otherwise an absent stage reads as a lost one.
 */
export async function getRun(runId: string): Promise<{
  run: RunRow;
  taskRuns: TaskRunRow[];
  gates: GateDecision[];
} | null> {
  const [run] = await query<RunRow>(`SELECT * FROM runs WHERE run_id = $1`, [runId]);
  if (!run) return null;
  const taskRuns = await query<TaskRunRow>(
    `SELECT * FROM task_runs WHERE run_id = $1 ORDER BY step_index`,
    [runId],
  );
  const gates = await listDecisions(runId);
  return { run, taskRuns, gates };
}

/** Most recent runs, for a status/observability listing. */
export async function listRuns(limit = 50): Promise<RunRow[]> {
  return query<RunRow>(`SELECT * FROM runs ORDER BY created_at DESC LIMIT $1`, [limit]);
}

/** The static task catalog (see db/schema.sql - kept in sync with registry.ts). */
export async function listTasks(): Promise<TaskRow[]> {
  return query<TaskRow>(`SELECT * FROM tasks ORDER BY task_id`);
}

/** Every execution of a single task across all runs - "when did audience_creation run, and how did it go each time." */
export async function listTaskRuns(taskId: string, limit = 50): Promise<TaskRunRow[]> {
  return query<TaskRunRow>(
    `SELECT * FROM task_runs WHERE task_id = $1 ORDER BY started_at DESC LIMIT $2`,
    [taskId, limit],
  );
}
