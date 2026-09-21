/**
 * Online eval (guide §5.4/§5.6): grade PRODUCTION behavior over time, not a
 * curated fixture. Samples the most recent real task_runs for one agent and
 * records a summary row into the SAME eval_runs/eval_results tables the
 * offline suites use, tagged source='online' so the /evals UI can tell
 * "graded against a golden fixture" apart from "sampled from real traffic".
 *
 * WHAT "PASSED" MEANS HERE, AND WHY IT'S HONEST: online data has no
 * hand-labeled expected answer, so we do NOT invent a pass/fail against one -
 * that would be grading the model against itself. Instead each sampled run is
 * scored on a concrete, checkable production signal:
 *
 *   passed  ==  the run completed AND used the real LLM path (did not fall
 *               back to the deterministic parser).
 *
 * That directly measures the two things §5.4 calls out as the earliest drift
 * signals for THIS app: the fallback rate (an LLM quietly failing and the
 * deterministic path silently taking over is exactly the "reported success
 * while actually degraded" failure the harness exists to surface) and, via the
 * recorded model, model drift. It is a health metric, not a correctness claim -
 * turning a real run into a correctness fixture is what scripts/scaffold-
 * fixture.mjs is for (a human then labels it).
 *
 * The LLM-path signal is read per agent from the metadata each route already
 * writes (see the agent routes):
 *   intake            -> metadata.extractionSource === "llm"
 *   review            -> metadata.triageEngine === "llm" || detectionEngine === "llm"
 *   audience_creation -> model column present (usage.model set only on LLM synth)
 *
 * Plain node .mjs (no tsx in this repo; needs only pg + the .env.local reader).
 * Run:
 *   node scripts/online-eval.mjs <task_id> [--limit 50]
 *   node scripts/online-eval.mjs intake --limit 100
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GRADABLE = new Set(["intake", "review", "audience_creation"]);

function loadEnv() {
  const envPath = path.join(ROOT, ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

function makePool() {
  let raw = (process.env.DATABASE_URL || "").trim().replace(/^['"]|['"]$/g, "");
  if (!raw) {
    console.error("DATABASE_URL is not set (checked .env.local). Cannot read task_runs.");
    process.exit(1);
  }
  const url = new URL(raw);
  const sslmode = (url.searchParams.get("sslmode") || "").replace(/['"]/g, "");
  url.searchParams.delete("sslmode");
  url.searchParams.delete("ssl");
  return new Pool({
    connectionString: url.toString(),
    ssl: ["require", "verify-ca", "verify-full"].includes(sslmode) ? { rejectUnauthorized: false } : undefined,
  });
}

/** Did this run use the real LLM path? Read from the metadata each agent route already writes. */
function usedLlm(taskId, row) {
  const md = row.metadata || {};
  if (taskId === "intake") return md.extractionSource === "llm";
  if (taskId === "review") return md.triageEngine === "llm" || md.detectionEngine === "llm";
  if (taskId === "audience_creation") return !!row.model; // usage.model set only when synthesis called a model
  return false;
}

function fallbackReasonOf(taskId, row) {
  const md = row.metadata || {};
  if (taskId === "intake") return md.extractionFallbackReason || null;
  if (taskId === "review") return md.triageFallbackReason || null;
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const taskId = args.find((a) => !a.startsWith("--"));
  const limIdx = args.indexOf("--limit");
  const limit = limIdx !== -1 ? Math.max(1, Math.min(Number(args[limIdx + 1]) || 50, 500)) : 50;

  if (!taskId || !GRADABLE.has(taskId)) {
    console.error(`Usage: node scripts/online-eval.mjs <${[...GRADABLE].join("|")}> [--limit N]`);
    process.exit(1);
  }

  loadEnv();
  const pool = makePool();
  try {
    const { rows } = await pool.query(
      `SELECT task_run_id, task_id, status, model, metadata, started_at
       FROM task_runs WHERE task_id = $1 ORDER BY started_at DESC LIMIT $2`,
      [taskId, limit],
    );
    if (!rows.length) {
      console.log(`No task_runs found for task_id "${taskId}" - nothing to sample.`);
      return;
    }

    const startedAt = new Date();
    const results = rows.map((row) => {
      const completed = row.status === "completed";
      const llm = usedLlm(taskId, row);
      const passed = completed && llm;
      const bits = [`status=${row.status}`, llm ? "llm" : "fell-back-to-deterministic"];
      const fb = fallbackReasonOf(taskId, row);
      if (fb) bits.push(`reason: ${fb}`);
      if (row.model) bits.push(`model=${row.model}`);
      return { id: `run-${row.task_run_id}`, passed, notes: bits.join("; ") };
    });

    const passed = results.filter((r) => r.passed).length;
    const total = results.length;
    const rate = Math.round((passed / total) * 100);

    // Model distribution (drift signal).
    const modelCounts = {};
    for (const row of rows) {
      const key = row.model || "(none)";
      modelCounts[key] = (modelCounts[key] || 0) + 1;
    }

    console.log(`\n=== ONLINE eval: ${taskId} — ${passed}/${total} on the LLM path (${rate}%) ===`);
    console.log(`  window: ${total} most recent runs, ${new Date(rows[total - 1].started_at).toLocaleString()} → ${new Date(rows[0].started_at).toLocaleString()}`);
    console.log(`  models seen: ${Object.entries(modelCounts).map(([m, n]) => `${m} (${n})`).join(", ")}`);
    if (Object.keys(modelCounts).filter((m) => m !== "(none)").length > 1) {
      console.log("  ⚠ MODEL DRIFT: more than one model answered in this window.");
    }
    console.log("");

    // Persist as an eval_runs row, source='online'. attempts=1 per sampled run;
    // passk_count == passed since each run is graded once.
    try {
      const runIns = await pool.query(
        `INSERT INTO eval_runs
           (suite, provider, passed_count, total_count, started_at, finished_at, repeat_count, passk_count, source)
         VALUES ($1, $2, $3, $4, $5, NOW(), 1, $6, 'online')
         RETURNING eval_run_id`,
        [taskId, process.env.LLM_PROVIDER ?? null, passed, total, startedAt.toISOString(), passed],
      );
      const evalRunId = runIns.rows[0].eval_run_id;

      await pool.query(
        `INSERT INTO eval_results (eval_run_id, fixture_id, passed, notes, attempts, passed_attempts)
         SELECT $1, fid, p, note, 1, CASE WHEN p THEN 1 ELSE 0 END
         FROM UNNEST($2::text[], $3::boolean[], $4::text[]) AS t(fid, p, note)`,
        [evalRunId, results.map((r) => r.id), results.map((r) => r.passed), results.map((r) => r.notes)],
      );

      console.log(`Saved online eval run ${evalRunId} (source=online). Browse it at /evals.`);
    } catch (err) {
      // 42703 = undefined_column, 42P01 = undefined_table. The metrics above
      // are still valid and already printed; only the /evals persistence needs
      // the eval-levels migration in db/schema.sql (source/repeat_count/
      // passk_count on eval_runs). Say that plainly instead of dumping a stack.
      if (err.code === "42703" || err.code === "42P01") {
        console.error(
          "\nNOT SAVED to /evals: the eval-levels columns aren't in the database yet " +
            `(${err.message}).\nApply db/schema.sql (the ALTER TABLE eval_runs ... ADD COLUMN source/repeat_count/` +
            "passk_count block) as a DB owner, then re-run. The metrics above are still accurate.",
        );
      } else {
        throw err;
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
