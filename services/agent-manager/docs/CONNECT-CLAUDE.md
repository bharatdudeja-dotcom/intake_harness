# Connecting Claude Desktop

Two things: the MCP config, and the standing instruction. Without the second,
the tools are present but unused — the cookbook learned that the hard way.

---

## 1. The MCP config

Claude Desktop → Settings → Developer → Edit Config.

```json
{
  "mcpServers": {
    "agent-manager": {
      "command": "npx",
      "args": ["-y", "mcp-remote",
               "http://34.203.238.63:3100/mcp",
               "--header", "x-cookbook-login:YOUR_ID:YOUR_PASSWORD"]
    }
  }
}
```

Locally that URL is `http://localhost:3000/mcp`.

Quit Claude Desktop **completely** and reopen — on Windows check the system
tray, on macOS use Cmd+Q. The config is read only at startup. To confirm, ask it
to call `get_my_roles`; it should answer with your identity, not a service
account.

Settings → Team exports all of this per person, including the instruction below,
as a file you can hand over.

---

## 2. The standing instruction

Claude Desktop → Settings → Profile → personal preferences. Or a Project's
custom instructions if you only want capture on client work.

```
I use an agent manager MCP called agent-manager. It fronts the agent pipeline
that builds Comcast/Xfinity campaign intakes, and it keeps the record of every
run.

When I ask for a campaign brief or an audience:
• Call start_intake with my brief in plain English. Tell me the run id.
• Show me what each agent did in plain language — what it decided, and anything
  it could not answer. If a stage asks for a missing field, ask me only for that
  field. Never re-ask me the whole brief.
• If a stage reports success but its output carries an error, say so plainly.
  A step that claims completed while its tool failed is not a success.
• Call get_intake if the pipeline had not finished.

While we work:
• append_step for every substantive output — source: "desktop-ai", the right
  kind (decision / doc / code / diagram / message), the model you are using, and
  tokens_used when you know them.
• When I say yes, no, or correct you, log it as kind: "steering" with the
  matching signal (affirm / reject / correct). A correction is the most valuable
  thing you can record — capture what I rejected and why it mattered.
• One run per intake. The brief, the triage and the audience definition are
  three artifacts of one run, not three runs.
• Before starting, search_resources for prior runs on this topic and reuse what
  is there. When refining earlier work, save_resource with its existing id —
  never create a near-duplicate.

When I am happy with a run, approve it. That hands it to the Hero Agent, which
reads it against every earlier run and proposes what should be learned. The Hero
Agent only proposes; a named person decides what is promoted.

Do this quietly as we work. Do not ask me each time.
```

---

## 3. What a session looks like

> **You:** Q4 upsell to existing HSD subscribers, TV and Xfinity App, launch end
> of October.

Claude calls `start_intake`, and comes back with the run id and a stage-by-stage
account. On the pipeline as it stands today that will include, honestly:

> Agent 1 reported `completed`, but its tool call failed — it asked for
> `search_knowledge_base`, which does not exist on the MCP server. So the brief
> was never grounded against AEP schemas.

That is the system working. A per-run view would have shown three green steps.

> **You:** the audience should exclude anyone who upgraded in the last 90 days

Claude logs that as a `steering` step with signal `correct`, because a
correction is the thing worth keeping.

> **You:** that looks right, approve it

Claude approves the run. It goes to the Hero Agent, which proposes what should
be learned. You promote it, and your name is on it.

---

## 4. Plugging in another MCP — Workfront, or anything else

The agent-system registry is `app/config/agent-systems.json`. An entry carries
its own endpoint, transport and auth, so a new system is config, not code:

```json
{
  "id": "workfront-adobe",
  "label": "Adobe Workfront MCP",
  "practice": "workfront",
  "active": true,
  "mcp_endpoint": "https://mcp.workfront.adobe.com/mcp/v1/workfront",
  "auth": "Bearer <token>"
}
```

**So if Adobe ships a Workfront MCP, it plugs straight in.** Same for an agentic
AEM or an agentic Campaign system later — each gets an entry bound to its
domain, and its agents are discovered from its own catalog rather than listed
here.

The rule that keeps this honest: **a system named in source outside its own
adapter is a mistake.** `lib/agent-systems.js` is the only file that knows how
to talk to an upstream, and even it reads the shape from config.

### For Agent 2

Agent 2's redraft posting goes through the same idea — an adapter that calls
`wf_comments_create` when a Workfront MCP is reachable, and records the intent
when it is not. Nothing about Agent 2 needs rewriting when the tools arrive;
the entry becomes active and the post starts happening for real.

---

## 5. Before this is public

The demo container runs with `MCP_AUTH_MODE=none` so an admin account could be
seeded. **Drop that flag before anyone else can reach it**, and set
`DASHBOARD_REQUIRE_IDENTITY=true`. The upstream harness has no authentication on
any route; that is not a pattern to copy for something holding Comcast briefs.
