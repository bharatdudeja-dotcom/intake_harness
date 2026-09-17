import { query } from "@/lib/db";
import type { RunRow } from "@/lib/pipeline/types";

/** A named grouping runs can belong to — see db/schema.sql for the port note. */
export interface ProgrammeRow {
  programme_id: string;
  name: string;
  note: string | null;
  owner: string | null;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
}

export async function listProgrammes(): Promise<ProgrammeRow[]> {
  return query<ProgrammeRow>(`SELECT * FROM programmes ORDER BY created_at DESC`);
}

export async function getProgramme(programmeId: string): Promise<ProgrammeRow | null> {
  const [row] = await query<ProgrammeRow>(`SELECT * FROM programmes WHERE programme_id = $1`, [programmeId]);
  return row ?? null;
}

/** Create a programme, or return the existing one with the same name — idempotent, no duplicates. */
export async function upsertProgrammeByName(input: {
  name: string;
  note?: string | null;
  owner?: string | null;
}): Promise<{ programme: ProgrammeRow; created: boolean }> {
  const [existing] = await query<ProgrammeRow>(`SELECT * FROM programmes WHERE name = $1`, [input.name]);
  if (existing) return { programme: existing, created: false };

  const [created] = await query<ProgrammeRow>(
    `INSERT INTO programmes (name, note, owner) VALUES ($1, $2, $3) RETURNING *`,
    [input.name, input.note ?? null, input.owner ?? null],
  );
  return { programme: created, created: true };
}

/** Runs belonging to a programme, most recent first — used by the programme detail view. */
export async function listRunsForProgramme(programmeId: string): Promise<RunRow[]> {
  return query<RunRow>(`SELECT * FROM runs WHERE programme_id = $1 ORDER BY created_at DESC`, [programmeId]);
}
