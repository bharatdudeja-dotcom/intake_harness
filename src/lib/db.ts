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
    const raw = process.env.DATABASE_URL;
    if (!raw) {
      throw new Error(
        "DATABASE_URL is not set. Copy .env.local.example to .env.local.",
      );
    }

    // Parse out any ssl/sslmode query params and strip them from the string
    // before handing it to Pool. If they're left in, pg's own connection-
    // string parser (pg-connection-string) independently derives its own
    // strict ssl config from e.g. "sslmode=require" and that can win over
    // the explicit `ssl` option below, producing a hard-to-debug
    // SELF_SIGNED_CERT_IN_CHAIN error against RDS even though we asked for
    // rejectUnauthorized: false. Stripping them means our explicit `ssl`
    // object below is the only source of truth.
    const url = new URL(raw);
    const sslMode = url.searchParams.get("sslmode");
    const sslFlag = url.searchParams.get("ssl");
    const wantsSsl = sslMode === "require" || sslMode === "verify-ca" || sslMode === "verify-full" || sslFlag === "true";
    url.searchParams.delete("sslmode");
    url.searchParams.delete("ssl");

    pool = new Pool({
      connectionString: url.toString(),
      // RDS's cert chain isn't in Node's default trust store, so this
      // encrypts the connection without verifying the certificate/hostname
      // (matches sslmode=require's actual guarantee, not verify-full's).
      // For real hostname+CA verification, pass `ca: fs.readFileSync(...)`
      // here with the RDS combined CA bundle instead of rejectUnauthorized.
      ssl: wantsSsl ? { rejectUnauthorized: false } : undefined,
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
