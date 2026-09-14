import { Pool, type QueryResultRow } from "pg";

/**
 * Shared Postgres pool for this harness's own observability tables
 * (see db/schema.sql: `runs`, `tasks`, `task_runs`). This is the SAME RDS
 * instance the Python MCP server (chaunceyplum/mcp) uses for pgvector, but
 * a DIFFERENT set of tables, kept distinct from that repo's Python
 * orchestrator tables (`executions` / `execution_resources`) so the two
 * orchestration layers never collide.
 */

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL is not set. Copy .env.local.example to .env.local.",
      );
    }
    pool = new Pool({
      connectionString,
      ssl: connectionString.includes("sslmode=require") || connectionString.includes("ssl=true")
        ? { rejectUnauthorized: false }
        : undefined,
    });
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const { rows } = await getPool().query<T>(text, params);
  return rows;
}
