/**
 * Scaffold an eval fixture from a REAL task_run - the "grow the set from
 * production" step the eval guide (§5.5) calls for. Pulls one task_runs row's
 * actual input/output/metadata from Postgres and writes a fixture skeleton
 * into the right evals/fixtures/<dir>, pre-filled with what the app really
 * produced, for a human to CORRECT into what SHOULD happen.
 *
 * A fixture records the RIGHT answer, not the observed one - so this only
 * gets you the input and a starting point; the `expected`/`rubric` fields
 * come out marked TODO precisely so a green-looking fixture that just
 * enshrines a past bug can't slip in unreviewed. (See evals/README.md's
 * "Where fixtures come from".)
 *
 * Plain node .mjs, not a TS script: this repo has no tsx, and the scaffolder
 * needs nothing from src/ - just pg and the same .env.local reader
 * evals/setup-env.ts uses. Run:
 *
 *   node scripts/scaffold-fixture.mjs <task_run_id>
 *   node scripts/scaffold-fixture.mjs <task_run_id> --out my-fixture-id
 *
 * task_id -> fixture dir mapping matches each .eval.ts's loadFixtures(dir):
 *   intake            -> fixtures/intake        (brief -> extractIntake)
 *   review            -> fixtures/review-triage (rejection reason -> triage)
 *   audience_creation -> fixtures/pql-synth     (criteria -> synthesizePql)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── .env.local loader (mirrors evals/setup-env.ts; never overrides real env) ─
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
    ssl: sslmode === "require" || sslmode === "verify-ca" || sslmode === "verify-full" ? { rejectUnauthorized: false } : undefined,
  });
}

// task_id -> { dir, build(input, output, metadata) -> fixture skeleton }
const SCAFFOLDERS = {
  intake: {
    dir: "intake",
    build: (input) => ({
      brief: typeof input === "string" ? input : input?.brief ?? input?.text ?? JSON.stringify(input),
      known: {},
      expected: {
        fields: { "TODO_field_key": "TODO expected value" },
        stated: ["TODO_field_that_should_be_stated"],
        inferred: ["TODO_field_that_should_be_inferred"],
      },
      mustNotContain: {},
      note: "SCAFFOLDED from a real task_run - correct expected/* by hand before trusting.",
    }),
  },
  review: {
    dir: "review-triage",
    build: (input) => ({
      rejectionReason:
        typeof input === "string" ? input : input?.rejectionReason ?? input?.reason ?? JSON.stringify(input),
      current: input?.current ?? {},
      expected: {
        findingKinds: ["invalid_value", "missing_field", "wrong_data_source"],
        fieldKey: "TODO_field_key",
        rubric: "TODO: describe what a correct, clearly-targeted correction looks like for this rejection.",
      },
      note: "SCAFFOLDED from a real task_run - correct expected/* by hand before trusting.",
    }),
  },
  audience_creation: {
    dir: "pql-synth",
    build: (input, output) => ({
      criteria:
        typeof input === "string" ? input : input?.criteria ?? input?.audienceCriteria ?? JSON.stringify(input),
      availableFields: Array.isArray(output?.availableFields) ? output.availableFields : ["TODO_field_a", "TODO_field_b"],
      rubric: "TODO: describe the correct PQL logic for this audience.",
      shouldSynthesize: true,
      note: "SCAFFOLDED from a real task_run - correct availableFields/rubric by hand before trusting.",
    }),
  },
};

async function main() {
  const args = process.argv.slice(2);
  const taskRunId = args.find((a) => !a.startsWith("--"));
  const outIdx = args.indexOf("--out");
  const outId = outIdx !== -1 ? args[outIdx + 1] : undefined;

  if (!taskRunId) {
    console.error("Usage: node scripts/scaffold-fixture.mjs <task_run_id> [--out <fixture-id>]");
    process.exit(1);
  }

  loadEnv();
  const pool = makePool();
  try {
    const { rows } = await pool.query(
      `SELECT task_run_id, task_id, input, output, metadata FROM task_runs WHERE task_run_id = $1`,
      [taskRunId],
    );
    if (!rows.length) {
      console.error(`No task_run found with task_run_id ${taskRunId}.`);
      process.exit(1);
    }
    const row = rows[0];
    const scaffolder = SCAFFOLDERS[row.task_id];
    if (!scaffolder) {
      console.error(`task_id "${row.task_id}" has no fixture scaffolder (only intake/review/audience_creation are gradable).`);
      process.exit(1);
    }

    const id = outId || `from-run-${taskRunId}`;
    const fixture = { id, ...scaffolder.build(row.input, row.output, row.metadata) };
    const dir = path.join(ROOT, "evals", "fixtures", scaffolder.dir);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${id}.json`);
    if (fs.existsSync(dest)) {
      console.error(`Refusing to overwrite existing fixture ${dest}. Pass a different --out id.`);
      process.exit(1);
    }
    fs.writeFileSync(dest, JSON.stringify(fixture, null, 2) + "\n");
    console.log(`Scaffolded ${path.relative(ROOT, dest)} from task_run ${taskRunId} (task_id=${row.task_id}).`);
    console.log("NEXT: open it and replace every TODO with what SHOULD happen, not what did.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
