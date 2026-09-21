/**
 * Trajectory evals (guide §5.2) - grading the PATH, not the answer. Did the
 * agent probe before deciding, stay inside its read-only tool set, and avoid
 * thrashing? These are the invariants that outcome evals structurally cannot
 * see: an agent can reach the right conclusion for the wrong reason (a lookup
 * that failed but was read as "absent"), and only the trace shows it.
 *
 * HOW THE TRACE IS CAPTURED: no new instrumentation. The production path
 * already wraps every agent step in withToolCallLog (mcp-client.ts), which
 * returns { toolCalls } - every MCP call in order, with args - and the
 * orchestrator persists exactly that to task_runs.metadata.toolCalls. This
 * eval wraps the SAME probe functions in the SAME withToolCallLog and grades
 * the SAME list with rules over the trace (evals/lib/trajectory.ts). So a
 * passing trajectory eval is a statement about what the real code does, not
 * about a mock.
 *
 * GATED ON THE MCP ENDPOINT, NOT AN LLM. Unlike the outcome/safety suites,
 * the probes here are deterministic MCP reads (no model), so this skips when
 * neither MCP_ENDPOINT_URL nor MCP_GATEWAY_URL is set - there is nothing to
 * call - rather than on isLlmConfigured(). It hits a live sandbox, so the
 * exact call SEQUENCE is response-dependent (probeSchemas asks the union view
 * first and only falls through to list+sample when it's empty); the rules are
 * written to hold across whichever branch the live data takes.
 */

import { describe, it, expect, afterAll } from "vitest";
import { withToolCallLog } from "@/lib/mcp-client";
import { gatherAepContext } from "@/lib/agents/review/aep-context";
import { probeSchemas, findExistingSegment, neededAttributes, criteriaKeywords } from "@/lib/agents/audience/aep";
import { loadFixtures } from "./lib/fixtures";
import { report, type EvalOutcome } from "./lib/report";
import { runRepeated } from "./lib/repeat";
import { checkTrajectory, type TrajectoryRules } from "./lib/trajectory";

type TrajectoryFixture = {
  id: string;
  agent: "review" | "audience_creation";
  fields: Record<string, string>;
  brief: string;
  rules: TrajectoryRules;
};

function mcpConfigured(): boolean {
  return !!(process.env.MCP_ENDPOINT_URL?.trim() || process.env.MCP_GATEWAY_URL?.trim());
}

const results: EvalOutcome[] = [];
const startedAt = new Date();
afterAll(() => report("trajectory", "Trajectory (rules over the tool-call trace)", results, startedAt));

/** Run the agent's real read-probe under the production trace wrapper and return the recorded calls. */
async function traceFor(fixture: TrajectoryFixture) {
  if (fixture.agent === "review") {
    const { toolCalls } = await withToolCallLog(`eval-${fixture.id}`, "review", async () => {
      await gatherAepContext(fixture.fields, fixture.brief);
    });
    return toolCalls;
  }
  // audience_creation: mirror the route's own read probe (probeSchemas + findExistingSegment)
  const { toolCalls } = await withToolCallLog(`eval-${fixture.id}`, "audience_creation", async () => {
    const attrs = neededAttributes(fixture.fields, fixture.brief);
    const terms = [
      fixture.fields.campaign_name,
      fixture.fields.line_of_business,
      ...criteriaKeywords([fixture.brief, fixture.fields.audience_description].filter(Boolean).join(" ")),
    ].filter(Boolean).map(String);
    await Promise.all([
      probeSchemas("audience_creation", attrs),
      findExistingSegment("audience_creation", terms),
    ]);
  });
  return toolCalls;
}

describe.skipIf(!mcpConfigured())("Trajectory eval", () => {
  const fixtures = [
    ...loadFixtures<TrajectoryFixture>("trajectory-review"),
    ...loadFixtures<TrajectoryFixture>("trajectory-audience"),
  ];

  it.each(fixtures)("$id", async (fixture) => {
    const outcome = await runRepeated(async () => {
      const calls = await traceFor(fixture);
      return checkTrajectory(calls, fixture.rules);
    });

    results.push({ id: fixture.id, passed: outcome.passed, notes: outcome.notes, attempts: outcome.attempts, passedAttempts: outcome.passedAttempts });
    expect.soft(outcome.passed, outcome.notes).toBe(true);
  });
});
