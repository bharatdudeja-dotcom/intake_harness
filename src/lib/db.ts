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
    let raw = process.env.DATABASE_URL;
    if (!raw) {
      throw new Error(
        "DATABASE_URL is not set. Copy .env.local.example to .env.local.",
      );
    }
    raw = raw.trim();
    // A DATABASE_URL copied out of a quoted shell command (e.g.
    // `export DATABASE_URL='postgresql://...sslmode=require'`) commonly
    // brings a stray leading and/or trailing quote character into the .env
    // file, since dotenv only strips a quote pair wrapping the ENTIRE
    // value, not one accidentally left on just one end. Strip a matched
    // wrapping pair here, and see the per-param cleanup below for the
    // unmatched case (a lone trailing quote stuck to the last param value).
    if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
      raw = raw.slice(1, -1);
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
    // Also strip stray quote chars from the individual value: a lone
    // trailing quote (no matching leading one, so the check above doesn't
    // catch it) turns "require" into "require'", which silently fails the
    // exact-match check below, disables SSL, and produces a confusing
    // unrelated-looking "no pg_hba.conf entry ... no encryption" error
    // instead of an obvious one.
    const clean = (v: string | null) => v?.replace(/['"]/g, "") ?? null;
    const sslMode = clean(url.searchParams.get("sslmode"));
    const sslFlag = clean(url.searchParams.get("ssl"));
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

/**
 * Why this does not just await the pool.
 *
 * When Postgres is unreachable, `pg` rejects with an **AggregateError** - one
 * error per address it tried, IPv6 and IPv4. An AggregateError's own `.message`
 * is the empty string: the detail lives in `.errors[]`. So every route that
 * reported `(err as Error).message` returned:
 *
 *     {"error":""}
 *
 * A container whose database is switched off answering with a blank error is
 * the worst possible thing to hand an operator, and it cost real time here: the
 * app looked broken when the only fault was a stopped Postgres. It is also
 * precisely the failure mode this project exists to argue against - an error
 * that reports nothing is indistinguishable from one that was never raised.
 *
 * So the aggregate is flattened into something that names the cause and, where
 * it can, what to check. The host and port come from DATABASE_URL rather than
 * from the error, because the error does not carry them either.
 */
function describeDbError(err: unknown): Error {
  const e = err as { name?: string; message?: string; code?: string; errors?: unknown[] };
  if (e?.name !== "AggregateError" || !Array.isArray(e.errors) || !e.errors.length) {
    return err as Error;
  }

  const parts = e.errors.map((inner) => {
    const i = inner as { code?: string; message?: string; address?: string; port?: number };
    const where = i.address ? ` (${i.address}${i.port ? `:${i.port}` : ""})` : "";
    return `${i.code || "error"}${where}${i.message ? `: ${i.message}` : ""}`;
  });

  let target = "";
  try {
    const u = new URL(String(process.env.DATABASE_URL || "").trim().replace(/^['"]|['"]$/g, ""));
    target = ` Postgres at ${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    target = " Postgres (DATABASE_URL is unset or unparseable)";
  }

  const refused = parts.some((p) => p.startsWith("ECONNREFUSED"));
  return new Error(
    `Could not reach${target} - ${parts.join("; ")}.` +
      (refused
        ? " Nothing is listening there. Check the database is running and that this host can " +
          "reach it: from a container, the host's own ports are not `localhost` - " +
          "use host.docker.internal locally, or the RDS endpoint when deployed."
        : ""),
  );
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  try {
    const { rows } = await getPool().query<T>(text, params);
    return rows;
  } catch (err) {
    throw describeDbError(err);
  }
}
