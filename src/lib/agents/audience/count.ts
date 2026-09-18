import { Client } from "pg";
import { callMcpTool } from "@/lib/mcp-client";
import type { TaskId } from "@/lib/pipeline/types";

/**
 * A real member count, over the PSQL interface to Adobe Query Service.
 *
 * WHY NOT THE ESTIMATE TOOL
 *
 * `adobe_create_segment_estimate` posts to
 * /ups/segment/definitions/{id}/estimate and gets a 404 from nginx, because
 * AEP has no such endpoint - an estimate there belongs to a PREVIEW of a
 * definition rather than to a saved segment. So every run said "no count yet"
 * and the number went to the nightly job, which is B3 and B6 arriving together
 * for a reason that turned out to be a wrong URL.
 *
 * WHY NOT THE ASYNC QUERY API EITHER
 *
 * `query_run` works and returns a real query id, but `query_get_results` also
 * 404s (/query/queries/{id}/results does not exist), and the async path took
 * nearly two minutes to leave SUBMITTED. Adobe serves results over its PSQL
 * interface, and `query_get_connection_parameters` hands out the host, port,
 * database, user and a token.
 *
 * This harness already speaks Postgres. Connecting directly answered in
 * seconds and returned real numbers, so that is what this does.
 *
 * WHAT IT COUNTS
 *
 * Profiles. If AEP_ACCOUNT_ID_FIELD names an account or household identifier,
 * it counts distinct values of that as well - which is the identity gap turned
 * into two numbers instead of a caveat. One household resolving to several
 * profiles is not an error, but nobody can reconcile a figure they cannot see.
 */

export type AudienceCount = {
  profiles: number | null;
  accounts: number | null;
  sql: string | null;
  /** How the number was obtained, or why it was not. Always set. */
  basis: string;
};

type ConnectionParams = {
  host: string;
  port: number;
  database: string;
  username: string;
  token: string;
};

/**
 * PQL is very nearly SQL already, but three differences matter and all three
 * are silent if you get them wrong.
 *
 *   "New York"    in SQL a double-quoted token is an IDENTIFIER, so the
 *                 predicate would look for a COLUMN called New York and fail,
 *                 or worse, match nothing quietly
 *   != null       SQL has no inequality against null; it needs IS NOT NULL,
 *                 and `x != null` is never true, so the count would be 0
 *   = null        likewise IS NULL
 *
 * Everything else - the dotted XDM paths, `= true`, `and`, `or`, parentheses -
 * Query Service accepts as written.
 */
export function pqlToSql(pql: string): string {
  return String(pql)
    .replace(/!=\s*null\b/gi, "is not null")
    .replace(/=\s*null\b/gi, "is null")
    .replace(/"([^"]*)"/g, (_m, inner: string) => `'${inner.replace(/'/g, "''")}'`);
}

/** Host, port, database, user and a token, from the connector. */
async function connectionParams(taskId: TaskId): Promise<ConnectionParams> {
  const raw = await callMcpTool<unknown>(taskId, "query_get_connection_parameters", {
    sandbox: process.env.AEP_SANDBOX || undefined,
  });
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Record<string, unknown>;

  const host = String(parsed.host || "");
  const token = String(parsed.token || parsed.password || "");
  if (!host || !token) throw new Error("Query Service returned no host or no token");

  return {
    host,
    port: Number(parsed.port || 80),
    database: String(parsed.database || "prod:all"),
    username: String(parsed.username || parsed.user || ""),
    token,
  };
}

/**
 * Count the people this audience would reach.
 *
 * Returns a basis rather than throwing: a run without a count is worth
 * continuing, and the reason belongs in the record next to the definition it
 * failed to size. A count of zero is a real answer and is reported as one - the
 * demo data has states with no matching profiles at all, and "0" is the thing a
 * marketer most needs to know before launch.
 */
export async function countAudience(taskId: TaskId, pql: string): Promise<AudienceCount> {
  const table = (process.env.AEP_PROFILE_TABLE || "").trim();
  if (!table) {
    return {
      profiles: null,
      accounts: null,
      sql: null,
      basis:
        "No direct count was attempted: AEP_PROFILE_TABLE is not set, so the dataset holding these " +
        "attributes is not known here. The count comes from the nightly segmentation run.",
    };
  }

  const account = (process.env.AEP_ACCOUNT_ID_FIELD || "").trim();
  const sql =
    `select count(*) as profiles` +
    (account ? `, count(distinct ${account}) as accounts` : "") +
    ` from ${table} where ${pqlToSql(pql)}`;

  let client: Client | null = null;
  try {
    const p = await connectionParams(taskId);
    client = new Client({
      host: p.host,
      port: p.port,
      database: p.database,
      user: p.username,
      password: p.token,
      ssl: { rejectUnauthorized: false },
      // Adobe's interactive endpoint answers in seconds; a minute is generous
      // and still far short of a stage timeout.
      connectionTimeoutMillis: 20000,
      query_timeout: 60000,
      statement_timeout: 60000,
    });
    await client.connect();
    const res = await client.query(sql);
    const row = (res.rows?.[0] || {}) as Record<string, unknown>;
    const num = (v: unknown) => (v == null ? null : Number(v));

    const profiles = num(row.profiles);
    const accounts = account ? num(row.accounts) : null;

    return {
      profiles,
      accounts,
      sql,
      basis:
        accounts != null
          ? `counted directly in Adobe Query Service: ${profiles} profile(s) across ${accounts} account(s). ` +
            "The two differ because one account can resolve to several profiles - that difference is " +
            "identity resolution, and this is both numbers rather than a caveat."
          : `counted directly in Adobe Query Service against ${table}` +
            (profiles === 0
              ? ". No profiles match this definition, so there is nobody to send to yet - worth " +
                "resolving before launch rather than after"
              : ""),
    };
  } catch (err) {
    return {
      profiles: null,
      accounts: null,
      sql,
      basis: `a direct count could not be taken: ${(err as Error).message}`,
    };
  } finally {
    if (client) await client.end().catch(() => {});
  }
}
