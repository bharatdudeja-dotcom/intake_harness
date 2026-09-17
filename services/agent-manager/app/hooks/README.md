# Steering capture — the three tiers (D41 / D47 / D62)

> **Recommended install:** `npx @tap/cookbook-connect --url <mcp-url> --key <api-key>`
> (`tools/cookbook-connect/`) wires Tier 1 below into `~/.claude/settings.json` + a
> `~/.tap-cookbook/` config once, for every folder, automatically. What follows documents what
> that installer wires up and why; do the manual steps yourself only if you're not using it.

A human's **yes / no / correction** on an AI's work is the highest-signal thing to capture
(especially corrections — they show *how* the work was steered). But that click happens in
the **AI client's own UI**, and MCP has no native "user clicked yes" event. We do **not**
intercept host chat UIs (D41: capture is cooperative, not interception). So we capture
steering deterministically where a client gives us a hook, and best-effort elsewhere:

## Tier 1 — Claude Code hooks (deterministic, coding-agent side)
`steering-capture.mjs` is wired to `PreToolUse` / `PostToolUse` / `Notification` and POSTs
**every** event to `append_step(kind:"steering")` on the active recipe:

- permission **allow / approve** → `signal: "affirm"` (green)
- permission **deny / block** → `signal: "reject"` (red)
- tool input **edited / updated** → `signal: "correct"` (amber — prime capture)

Because it fires on every event, no steering decision is dropped on the coding-agent side.

**Setup:**
1. Merge `claude-code-settings.snippet.json`'s `hooks` block into your `.claude/settings.json`.
2. Export before launching Claude Code:
   ```
   export TAP_MCP_URL="https://<ns>.adobeioruntime.net/api/v1/web/tap-mcp-connector/mcp-server"
   export TAP_API_KEY="<SERVICE_API_KEY>"
   export TAP_PROJECT="My Engagement"        # or TAP_RECIPE_ID="recipe-…"
   export TAP_SOURCE="cli-agent"             # optional label
   export TAP_MODEL="opus-4.8"               # optional label
   ```
   The hook resolves the task thread via `TAP_RECIPE_ID`, else `get_active_recipe(TAP_PROJECT)`.
   It never blocks Claude Code — any failure is swallowed and it exits 0.

## Tier 2 — MCP elicitation (deterministic, connector's own approvals)
When the **connector itself** asks the user to confirm something, it uses MCP *elicitation*:
the response returns in-session and is logged natively as a steering step — no host-UI
interception needed. (Wired into the connector's own approval prompts.)

## Tier 3 — cooperative logging (best-effort, chat apps)
For consumer chat clients with no hook API, the server `instructions` ask the AI to log the
user's steering as a `kind:"steering"` step. This is best-effort — the AI must choose to
send it. For **guaranteed** chat-side capture, the enterprise option is audit-log ingestion
(D41 option 2), not this kit.

> We never claim to intercept a host client's UI clicks. Tier 1 is deterministic because
> Claude Code *invokes* the hook; tiers 2–3 are in-session or cooperative by nature.
