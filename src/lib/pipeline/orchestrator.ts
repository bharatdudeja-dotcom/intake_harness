import { query } from "@/lib/db";
import { ALL_TASKS, ESCALATION, PIPELINE } from "./registry";
import { decisionFor, gateFor, type GateDecision, type GateId } from "./gates";
import type { AgentName, AgentRequest, AgentResponse, RunRow, TaskRow, TaskRunRow } from "./types";

/**
 * Runs exactly the NEXT agent for a run — never more than one — over real
 * HTTP to that agent's own route (a dev can `curl
 * localhost:3000/api/agents/audience-creation` on its own without spinning
 * up the rest of the pipeline). Every call is recorded as a task_runs row.
 *
 * The pipeline stops after every step, not just a failed/paused one: a
 * step that completes with more agents left to run puts the run into
 * "awaiting_approval" rather than calling the next agent automatically —
 * the per-agent equivalent of a tool call waiting for permission before it
 * runs. POST /api/runs/[runId]/continue is what actually advances it.
 *
 * Each agent only ever receives the slice of `priorOutputs` its registry
 * entry declares via `contextAccess` — filtered from the full accumulated
 * history before every HTTP call, so an agent never receives a prior
 * agent's output it isn't scoped to see (paired with the tool allowlist
 * enforced in lib/mcp-client.ts).
 *
 * A "failed" step additionally triggers Agent 4 — Escalation (B9: "the
 * process terminates without an audience, and nothing is captured").
 * "needs_input" does NOT trigger it — that's an expected, resumable pause.
 */
/**
 * What this stage spent, and whether anyone would know.
 *
 * `usage` is set only by an agent that genuinely called a model. None of the
 * four do today - they are deterministic parsers plus MCP tool calls - so the
 * honest value for tokens is null rather than a fabricated 0.
 *
 * Null alone is ambiguous downstream, though: a reader cannot tell "no model
 * was called" from "a model was called and nobody counted". So the metadata
 * says which. An agent that starts calling a model reports usage, and this
 * flips to true without anything else changing.
 */
function executionMetadata(response: AgentResponse): Record<string, unknown> {
  return {
    ...(response.metadata ?? {}),
    model_called: response.usage ? true : false,
  };
}

async function advanceOneStep(
  run: RunRow,
  stepIndex: number,
  currentInput: unknown,
  priorOutputs: Partial<Record<AgentName, unknown>>,
  baseUrl: string,
): Promise<RunRow> {
  const agent = PIPELINE[stepIndex];
  const startedAt = new Date();

  const scopedPriorOutputs: Partial<Record<AgentName, unknown>> = {};
  for (const visibleAgent of agent.contextAccess) {
    if (visibleAgent in priorOutputs) {
      scopedPriorOutputs[visibleAgent] = priorOutputs[visibleAgent];
    }
  }

  let response: AgentResponse;
  try {
    response = await callAgent(baseUrl, agent.path, {
      runId: run.run_id,
      input: currentInput,
      priorOutputs: scopedPriorOutputs,
    });
  } catch (err) {
    response = { status: "failed", message: (err as Error).message };
  }

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();

  // Everything from here on just RECORDS the outcome above; callAgent's own
  // try/catch already turned an agent failure into an ordinary "failed"
  // response. If recording itself throws (a dropped DB connection, a query
  // timeout), the run must still not be left at "running" — that status
  // accepts neither resumeRun nor continueRun, so a run stuck there has no
  // way back in short of someone hand-editing the database (see the outer
  // catch below).
  try {
    await query<TaskRunRow>(
      `INSERT INTO task_runs
         (run_id, task_id, step_index, status, input, output, message, metadata,
          tokens_used, model, started_at, finished_at, duration_ms)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10, $11, $12, $13)`,
      [
        run.run_id,
        agent.name,
        stepIndex,
        response.status,
        JSON.stringify(currentInput),
        JSON.stringify(response.output ?? null),
        response.message ?? null,
        JSON.stringify(executionMetadata(response)),
        response.usage?.tokens ?? null,
        response.usage?.model ?? null,
        startedAt.toISOString(),
        finishedAt.toISOString(),
        durationMs,
      ],
    );

    if (response.status !== "completed") {
      if (response.status === "failed") {
        await runEscalation(run.run_id, baseUrl, {
          failedTask: agent.name,
          failedStepIndex: stepIndex,
          message: response.message ?? null,
          input: currentInput,
        }, priorOutputs, stepIndex + 1);
      }

      const [updated] = await query<RunRow>(
        `UPDATE runs SET status = $2, current_step = $3, updated_at = NOW()
         WHERE run_id = $1 RETURNING *`,
        [run.run_id, response.status, stepIndex],
      );
      return updated;
    }

    const nextStepIndex = stepIndex + 1;
    const isLastStep = nextStepIndex >= PIPELINE.length;
    const [updated] = await query<RunRow>(
      `UPDATE runs SET status = $2, current_step = $3, updated_at = NOW()
       WHERE run_id = $1 RETURNING *`,
      [run.run_id, isLastStep ? "completed" : "awaiting_approval", nextStepIndex],
    );
    return updated;
  } catch (err) {
    const [failed] = await query<RunRow>(
      `UPDATE runs SET status = 'failed', current_step = $2, updated_at = NOW()
       WHERE run_id = $1 RETURNING *`,
      [run.run_id, stepIndex],
    );
    await runEscalation(run.run_id, baseUrl, {
      failedTask: agent.name,
      failedStepIndex: stepIndex,
      message: `Recording this step's result failed: ${(err as Error).message}`,
      input: currentInput,
    }, priorOutputs, stepIndex + 1).catch(() => {});
    return failed;
  }
}

/**
 * Recovers a run stuck at "running" — the state resumeRun/continueRun set
 * just before calling advanceOneStep, meant to be transitional within a
 * single request. If that request died before advanceOneStep resolved it
 * (a hung downstream call outliving even AGENT_CALL_TIMEOUT_MS, a killed
 * process), the row is left there with no way back in through either of
 * those functions, since both require a different starting status. This
 * re-attempts `current_step` from scratch using the same "what's already
 * completed" reconstruction resumeRun/continueRun use, so retrying costs
 * nothing but time — it is not a guess at what the dead attempt was doing.
 */
export async function retryRun(runId: string, baseUrl: string): Promise<RunRow> {
  const [run] = await query<RunRow>(`SELECT * FROM runs WHERE run_id = $1`, [runId]);
  if (!run) {
    throw new Error(`No run found for run_id ${runId}.`);
  }
  if (run.status !== "running") {
    throw new Error(`Run ${runId} is "${run.status}", not "running" — nothing to retry.`);
  }

  const { priorOutputs, allOutputs, lastCompleted } = await completedTaskRunsFor(runId);
  const currentInput = lastCompleted ? lastCompleted.output : run.input;

  return advanceOneStep(run, run.current_step, currentInput, priorOutputs, baseUrl);
}

/** Starts a run and executes only its first agent (Intake). */
export async function runPipeline(initialInput: unknown, baseUrl: string): Promise<RunRow> {
  // An optional `programme` name on the submission groups this run under
  // that Programme, upserted by name (see lib/programmes.ts) so submitting
  // the same name twice reuses the row rather than duplicating it.
  const programmeName = (initialInput as { programme?: unknown } | null)?.programme;
  let programmeId: string | null = null;
  if (typeof programmeName === "string" && programmeName.trim()) {
    const { upsertProgrammeByName } = await import("@/lib/programmes");
    const { programme } = await upsertProgrammeByName({ name: programmeName.trim() });
    programmeId = programme.programme_id;
  }

  const [run] = await query<RunRow>(
    `INSERT INTO runs (input, programme_id) VALUES ($1::jsonb, $2) RETURNING *`,
    [JSON.stringify(initialInput), programmeId],
  );

  return advanceOneStep(run, 0, initialInput, {}, baseUrl);
}

/**
 * Answers a paused run's "needs_input" step and re-runs that SAME step —
 * the "a human resolves it and the run is resumed" half of the needs_input
 * contract (see types.ts). Re-enters at the exact step that paused
 * (`run.current_step`), rebuilding `priorOutputs` from every already-
 * completed task_run so a resumed run sees the same context a same-request
 * run would have. If the answer resolves it, the run lands in
 * "awaiting_approval" like any other completed step — answering a question
 * is not the same act as approving the next agent.
 */
export async function resumeRun(runId: string, resumedInput: unknown, baseUrl: string): Promise<RunRow> {
  const [run] = await query<RunRow>(`SELECT * FROM runs WHERE run_id = $1`, [runId]);
  if (!run) {
    throw new Error(`No run found for run_id ${runId}.`);
  }
  if (run.status !== "needs_input") {
    throw new Error(`Run ${runId} is "${run.status}", not "needs_input" — nothing to resume.`);
  }

  const { priorOutputs } = await completedTaskRunsFor(runId);

  const [running] = await query<RunRow>(
    `UPDATE runs SET status = 'running', updated_at = NOW() WHERE run_id = $1 RETURNING *`,
    [runId],
  );

  return advanceOneStep(running, running.current_step, resumedInput, priorOutputs, baseUrl);
}


/**
 * The process gate, in front of the per-agent loop.
 *
 * Returns null when the next agent may run, or the blocked_on record when it
 * may not. A blocked agent is NOT called and writes NO task_runs row, so an
 * absent stage cannot be mistaken for a finished one.
 */
async function gateBlocking(
  runId: string,
  stepIndex: number,
  currentInput: unknown,
  priorOutputs: Partial<Record<AgentName, unknown>>,
  allOutputs?: Partial<Record<AgentName, unknown[]>>,
): Promise<NonNullable<RunRow["blocked_on"]> | null> {
  const agent = PIPELINE[stepIndex];
  if (!agent) return null;
  const gate = gateFor(agent.name);
  if (!gate) return null;

  const verdict = gate.check({
    decisions: await listDecisions(runId),
    input: currentInput,
    priorOutputs,
    allOutputs,
  });
  if (verdict.open) return null;

  return {
    gate_id: gate.id,
    map_step: gate.mapStep,
    label: gate.label,
    step_index: stepIndex,
    agent: agent.name,
    awaiting: verdict.awaiting,
    needs: verdict.needs,
    ref: verdict.ref,
  };
}

/** Park the run at a gate. Nothing ran, so nothing is recorded as having run. */
async function block(runId: string, blockedOn: NonNullable<RunRow["blocked_on"]>): Promise<RunRow> {
  const [updated] = await query<RunRow>(
    `UPDATE runs SET status = 'awaiting_approval', current_step = $2,
            blocked_on = $3::jsonb, updated_at = NOW()
     WHERE run_id = $1 RETURNING *`,
    [runId, blockedOn.step_index, JSON.stringify(blockedOn)],
  );
  return updated;
}

/** Every decision recorded for this run, oldest first. */
export async function listDecisions(runId: string): Promise<GateDecision[]> {
  return query<GateDecision>(
    `SELECT gate_id, step_index, decision, decided_by, reason, evidence, decided_at
       FROM run_gates WHERE run_id = $1 ORDER BY decided_at, gate_run_id`,
    [runId],
  );
}

/**
 * Attach the decision that opened a gate to the agent's input.
 *
 * Agent 2 has two jobs and the decision picks between them: approved goes to
 * the conversion, rejected goes to triage. Carrying the reason means it does
 * not have to hunt for the rejection in a comment stream it may not be able to
 * read - which the blockers doc calls the largest unclaimed gap in the map.
 */
function withGateDecision(input: unknown, gateId: GateId | undefined, decisions: GateDecision[]): unknown {
  if (!gateId) return input;
  const decided = decisionFor(decisions, gateId);
  if (!decided) return input;
  if (input == null || typeof input !== "object" || Array.isArray(input)) return input;
  return {
    ...(input as Record<string, unknown>),
    gateDecision: {
      gate_id: decided.gate_id,
      decision: decided.decision,
      decided_by: decided.decided_by,
      reason: decided.reason,
      decided_at: decided.decided_at,
    },
    ...(decided.decision === "rejected" && decided.reason ? { rejectionReason: decided.reason } : {}),
  };
}

/**
 * Record a decision at a gate, then let the run continue by ONE step.
 *
 * Decided once: two approvals thirty seconds apart, from a client abort and a
 * retry, each advanced the pipeline, and Agent 3 ran twice. Since the agents
 * write to Workfront, a non-idempotent approve is a duplicate-record generator.
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
   * blocked_on is set only when OUR gate check parked the run. But the
   * per-agent loop also parks a run at awaiting_approval after every completed
   * step, with blocked_on null - so after intake finishes, the run is waiting
   * to run Agent 2 and has no blocked_on at all. Reading only blocked_on made
   * approve_intake answer 409 "not waiting at a gate" for a request that
   * Workfront had genuinely approved, and the pipeline could never leave
   * step 1. The gate that matters is the one in front of the step the run is
   * about to take, whichever mechanism parked it there.
   */
  const nextAgent = PIPELINE[run.current_step]?.name;
  const gateId = input.gateId || run.blocked_on?.gate_id || (nextAgent ? gateFor(nextAgent)?.id : undefined);
  if (!gateId) {
    throw new Error(
      `Run ${runId} is at step ${run.current_step} (status "${run.status}") and nothing there is gated, ` +
      "so there is no decision to record. Use /continue to advance it.",
    );
  }

  const already = decisionFor(await listDecisions(runId), gateId as GateId);
  if (already) {
    if (already.decision !== input.decision) {
      throw new Error(
        `Gate ${gateId} was already ${already.decision} by ${already.decided_by} at ${already.decided_at}. ` +
        "The pipeline has acted on that; start a new run if the request has changed.",
      );
    }
    const [current] = await query<RunRow>(`SELECT * FROM runs WHERE run_id = $1`, [runId]);
    return { run: current, decision: already };
  }

  const [decision] = await query<GateDecision>(
    `INSERT INTO run_gates (run_id, gate_id, step_index, decision, decided_by, reason, evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING gate_id, step_index, decision, decided_by, reason, evidence, decided_at`,
    [
      runId,
      gateId,
      run.blocked_on?.step_index ?? run.current_step,
      input.decision,
      input.decidedBy,
      input.reason ?? null,
      JSON.stringify(input.evidence ?? {}),
    ],
  );

  /*
   * Clear the block, then advance exactly ONE step.
   *
   * The gate is a precondition on Continue, not a replacement for it - so a
   * decision does not run the pipeline to completion, it unlocks the next
   * agent and stops again like every other step.
   */
  await query(`UPDATE runs SET blocked_on = NULL WHERE run_id = $1`, [runId]);
  const resumed = await continueRun(runId, baseUrl);
  return { run: resumed, decision };
}

/**
 * Approves an "awaiting_approval" run and runs the next agent — the actual
 * "yes, go ahead" action behind the per-agent approval gate. `current_step`
 * already points at the next agent to run (advanceOneStep advanced it past
 * the one that just completed), and its input is that prior agent's output.
 */
export async function continueRun(runId: string, baseUrl: string): Promise<RunRow> {
  const [run] = await query<RunRow>(`SELECT * FROM runs WHERE run_id = $1`, [runId]);
  if (!run) {
    throw new Error(`No run found for run_id ${runId}.`);
  }
  if (run.status !== "awaiting_approval") {
    /*
     * Say which state it IS in, and do not call this an approval.
     *
     * This read "nothing to approve" on a /continue call, which is a message
     * from a different endpoint: by the time anyone continues a run, the
     * approval has already happened. A caller was told the opposite of the
     * truth about the one manual step in this pipeline.
     *
     * "completed" in particular is not a problem at all - the run finished, and
     * the caller wants its outcome rather than another step.
     */
    throw new Error(
      run.status === "completed"
        ? `Run ${runId} has already finished - every step is done, so there is nothing further to advance. Read the run to see what it produced.`
        : `Run ${runId} is "${run.status}", so there is no step waiting to be run. Only a run that has finished a step and is waiting can be advanced.`,
    );
  }

  const { priorOutputs, allOutputs, lastCompleted } = await completedTaskRunsFor(runId);
  const currentInput = lastCompleted ? lastCompleted.output : run.input;

  /*
   * A CLICK IS NOT AN APPROVAL.
   *
   * Continue means "yes, run the next agent". It does not mean the review queue
   * approved the request - only Workfront knows that - and conflating the two
   * is what let Agent 2 run on an unapproved brief and report completed. If a
   * process gate is shut, the run goes back to awaiting_approval with
   * blocked_on set and no agent is called.
   */
  const blocked = await gateBlocking(runId, run.current_step, currentInput, priorOutputs, allOutputs);
  if (blocked) return block(runId, blocked);

  const [running] = await query<RunRow>(
    `UPDATE runs SET status = 'running', blocked_on = NULL, updated_at = NOW() WHERE run_id = $1 RETURNING *`,
    [runId],
  );

  // The decision that opened the gate travels with the input.
  const gate = gateFor(PIPELINE[running.current_step]?.name);
  const input = withGateDecision(currentInput, gate?.id, await listDecisions(runId));

  return advanceOneStep(running, running.current_step, input, priorOutputs, baseUrl);
}

/** Every completed task_run for a run, as the `priorOutputs` map plus the most recent one — shared by resumeRun/continueRun. */
async function completedTaskRunsFor(
  runId: string,
): Promise<{
  priorOutputs: Partial<Record<AgentName, unknown>>;
  allOutputs: Partial<Record<AgentName, unknown[]>>;
  lastCompleted: TaskRunRow | undefined;
}> {
  const completedTaskRuns = await query<TaskRunRow>(
    `SELECT * FROM task_runs WHERE run_id = $1 AND status = 'completed' ORDER BY step_index`,
    [runId],
  );
  const priorOutputs: Partial<Record<AgentName, unknown>> = {};
  for (const taskRun of completedTaskRuns) {
    priorOutputs[taskRun.task_id] = taskRun.output;
  }

  /*
   * EVERY ATTEMPT, not just the completed ones.
   *
   * A stage can run more than once - that is the shape of this pipeline, with
   * questions and gates between steps - and a later run does not undo what an
   * earlier one did. On run 9b8e39ee the review that CREATED the project is
   * marked needs_input, because it also asked the marketer a question, and the
   * row marked completed is a lighter preflight pass with no conversion in it.
   *
   * Reading only completed rows therefore told the 2.7 gate that the request
   * had never been through review, in front of the project it had just
   * created, and Agent 3 could never run.
   *
   * priorOutputs keeps its old meaning - what an AGENT is handed, which should
   * be a completed result - and gates get the full history to reason over.
   */
  const everyTaskRun = await query<TaskRunRow>(
    `SELECT * FROM task_runs WHERE run_id = $1 ORDER BY step_index, task_run_id`,
    [runId],
  );
  const allOutputs: Partial<Record<AgentName, unknown[]>> = {};
  for (const taskRun of everyTaskRun) {
    const list = allOutputs[taskRun.task_id] || [];
    list.push(taskRun.output);
    allOutputs[taskRun.task_id] = list;
  }

  return { priorOutputs, allOutputs, lastCompleted: completedTaskRuns[completedTaskRuns.length - 1] };
}

/**
 * Best-effort call to the Escalation agent when a run fails. Never throws:
 * a broken escalation path must not mask the original failure, but it IS
 * still recorded as its own task_run — even escalation failing is
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
        tokens_used, model, started_at, finished_at, duration_ms)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10, $11, $12, $13)`,
    [
      runId,
      ESCALATION.name,
      stepIndex,
      response.status,
      JSON.stringify(failure),
      JSON.stringify(response.output ?? null),
      response.message ?? null,
      JSON.stringify(executionMetadata(response)),
      response.usage?.tokens ?? null,
      response.usage?.model ?? null,
      startedAt.toISOString(),
      finishedAt.toISOString(),
      finishedAt.getTime() - startedAt.getTime(),
    ],
  );
}

/**
 * Past this, give up rather than hang. Without a bound here, an agent
 * whose own MCP call hangs (an unresponsive Workfront/AEP endpoint, a
 * dead TCP connection nothing ever times out) leaves this fetch pending
 * indefinitely — and with it, the run stuck at "running" forever, since
 * neither resumeRun nor continueRun accept that status to try again. A
 * bounded timeout turns that into an ordinary caught error instead, which
 * the caller already converts into a normal "failed" task_run.
 */
const AGENT_CALL_TIMEOUT_MS = 60_000;

async function callAgent(baseUrl: string, path: string, body: AgentRequest): Promise<AgentResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_CALL_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`Agent at ${path} did not respond within ${AGENT_CALL_TIMEOUT_MS / 1000}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Agent at ${path} returned HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  return (await res.json()) as AgentResponse;
}

/** A single run plus every task_runs row recorded for it, in step order. */
export async function getRun(runId: string): Promise<{ run: RunRow; taskRuns: TaskRunRow[]; gates: GateDecision[] } | null> {
  const [run] = await query<RunRow>(`SELECT * FROM runs WHERE run_id = $1`, [runId]);
  if (!run) return null;
  const taskRuns = await query<TaskRunRow>(
    `SELECT * FROM task_runs WHERE run_id = $1 ORDER BY step_index`,
    [runId],
  );
  // The decisions too: a reader who sees one stage and no second needs
  // to be told the second is behind a gate, or absent reads as lost.
  return { run, taskRuns, gates: await listDecisions(runId) };
}

/** Most recent runs, for a status/observability listing. */
export async function listRuns(limit = 50): Promise<RunRow[]> {
  return query<RunRow>(`SELECT * FROM runs ORDER BY created_at DESC LIMIT $1`, [limit]);
}

/** The static task catalog (see db/schema.sql — kept in sync with registry.ts). */
export async function listTasks(): Promise<TaskRow[]> {
  const rows = await query<TaskRow>(`SELECT * FROM tasks`);

  /*
   * PIPELINE ORDER, not alphabetical.
   *
   * `ORDER BY task_id` gave audience_creation, escalation, intake, review -
   * so anything that treats this catalog as the running order puts Escalation
   * second. The dashboard did exactly that: a job that had only finished Intake
   * reported "Agent 4 - Escalation, step 2 of 4", and the progress bar coloured
   * the wrong segments. Escalation is not step 2 of anything; it is not in the
   * pipeline at all, it is what runs when the pipeline fails.
   *
   * The registry is the one place that knows the order, so it decides here too.
   * Anything not in it sorts to the end rather than being dropped - a task
   * added upstream should still appear.
   */
  const order = new Map(ALL_TASKS.map((t, i) => [t.name as string, i]));
  return rows.sort((a, b) =>
    (order.get(a.task_id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.task_id) ?? Number.MAX_SAFE_INTEGER) ||
    a.task_id.localeCompare(b.task_id));
}

/** Every execution of a single task across all runs — "when did audience_creation run, and how did it go each time." */
export async function listTaskRuns(taskId: string, limit = 50): Promise<TaskRunRow[]> {
  return query<TaskRunRow>(
    `SELECT * FROM task_runs WHERE task_id = $1 ORDER BY started_at DESC LIMIT $2`,
    [taskId, limit],
  );
}

export interface RunStats {
  total: number;
  running: number;
  needsInput: number;
  completed: number;
  failed: number;
  approved: number;
  promoted: number;
}

/** Dashboard tile counts. Cast to ::int so the pg driver returns numbers, not bigint strings. */
export async function getRunStats(): Promise<RunStats> {
  const [row] = await query<{
    total: number; running: number; needs_input: number;
    completed: number; failed: number; approved: number; promoted: number;
  }>(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'running')::int AS running,
      COUNT(*) FILTER (WHERE status = 'needs_input')::int AS needs_input,
      COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
      COUNT(*) FILTER (WHERE approved)::int AS approved,
      COUNT(*) FILTER (WHERE promoted)::int AS promoted
    FROM runs
  `);
  return {
    total: row.total,
    running: row.running,
    needsInput: row.needs_input,
    completed: row.completed,
    failed: row.failed,
    approved: row.approved,
    promoted: row.promoted,
  };
}

export interface TaskCounts {
  total: number;
  completed: number;
  needsInput: number;
  failed: number;
}

/** Per-task execution counts across every run — the Agents page's "how has each one done" row. */
export async function getTaskCounts(): Promise<Record<string, TaskCounts>> {
  const rows = await query<{ task_id: string; total: number; completed: number; needs_input: number; failed: number }>(`
    SELECT
      task_id,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
      COUNT(*) FILTER (WHERE status = 'needs_input')::int AS needs_input,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
    FROM task_runs
    GROUP BY task_id
  `);
  const byTask: Record<string, TaskCounts> = {};
  for (const row of rows) {
    byTask[row.task_id] = { total: row.total, completed: row.completed, needsInput: row.needs_input, failed: row.failed };
  }
  return byTask;
}

/** Runs that need a human right now: paused, waiting on approval, or stuck — the Live Queue's "what needs attention." */
export async function listActiveRuns(limit = 100): Promise<RunRow[]> {
  return query<RunRow>(
    `SELECT * FROM runs WHERE status IN ('needs_input', 'awaiting_approval', 'running')
     ORDER BY updated_at ASC LIMIT $1`,
    [limit],
  );
}
