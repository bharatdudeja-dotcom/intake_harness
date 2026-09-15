import { NextResponse } from "next/server";
import { listTasks } from "@/lib/pipeline/orchestrator";

/** The static task catalog (db/schema.sql, kept in sync with src/lib/pipeline/registry.ts). */
export async function GET() {
  try {
    const tasks = await listTasks();
    return NextResponse.json({ tasks });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
