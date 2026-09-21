/**
 * Pure types for the MCP servers registry — no `@/lib/db` import, same
 * split as resources-types.ts vs resources.ts. Client components (the
 * Settings MCP servers card) must import from THIS file, never from
 * mcp-servers.ts, which pulls in `pg`.
 */

export interface McpServerSafe {
  id: string;
  label: string;
  practice: string | null;
  endpoint: string;
  instance: string | null;
  active: boolean;
  gateway: boolean;
  /** Whether *some* credential (static or OAuth) is set — never the value itself. */
  auth_configured: boolean;
  auth_source: "oauth" | "inline" | "env" | null;
  oauth_connected: boolean;
  oauth_connected_at: string | null;
  oauth_expires_at: string | null;
}
