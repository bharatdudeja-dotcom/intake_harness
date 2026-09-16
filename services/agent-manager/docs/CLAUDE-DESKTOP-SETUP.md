# Connecting Claude Desktop to CX Agent Manager

Written for: Bharat, to test the whole thing end to end.

Everything below has been run against the live stack. Where something does not
work yet, it says so and why, rather than leaving you to find out.

---

## 1. The MCP config

Claude Desktop reads one JSON file:

- **Windows** — `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS** — `~/Library/Application Support/Claude/claude_desktop_config.json`

Add the `cx-agent-manager` entry. If you already have a `company-cookbook`
entry, **leave it** — they are different servers and you want both.

```json
{
  "mcpServers": {
    "cx-agent-manager": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "http://localhost:3000/mcp",
        "--header", "x-cookbook-login:admin:Tapadmin@123"
      ]
    }
  }
}
```

Then **quit Claude Desktop completely and reopen it** — it only reads that file
at startup, and "restart" from the menu is not always enough on Windows.

### Checking it worked

Ask Claude: *"list the agent systems"*. You should get four agents back —
Intake, Review / Triage, Audience Creation, Escalation — read live from the
harness's own catalog, not from anything hardcoded.

If you get nothing, in order of likelihood:

| Symptom | Cause |
|---|---|
| "no tools available" | Claude Desktop was not fully quit. Kill it from the tray. |
| 401 | The login header is wrong. It is `id:password`, one colon, no spaces. |
| connection refused | The container is not running — see §4. |
| tools appear but every call 500s | `STORAGE_ROOT` is mangled. See §4, and the note about Git Bash. |

### Why `mcp-remote` and not a URL

Claude Desktop speaks stdio to local servers. `mcp-remote` is the standard
bridge to an HTTP MCP server and handles the header, which is how the server
knows which user you are. Your runs are private to you; approved runs and the
Shared Knowledge Graph are visible to everyone.

---

## 2. The system prompt

Paste this into a Claude Project's custom instructions. You do **not** strictly
need it — the server sends its own instructions over MCP, and those are what
actually govern behaviour. This is here to set the framing for a working
session.

```text
You have CX Agent Manager connected over MCP. It is the record of what
Comcast's Workfront creative-intake agents did, across runs, and the gateway
through which those agents' own tools reach you.

It is NOT a place to file your own work. Do not capture diagrams, documents,
code or summaries you produced in conversation. That belongs in the company
cookbook, which is a different server. Agent Manager will refuse it anyway —
if a save is refused, do not retry it or look for another tool, you have the
wrong server.

WHAT TO DO HERE

- start_intake({brief}) runs a marketer's brief through the pipeline and
  records the whole run: the brief verbatim, one artifact per agent stage, and
  a time ledger. get_intake reads one back.
- list_agent_systems / list_system_agents show the estate. Read it, never
  assume it — an agent added upstream appears without a deploy.
- list_recipes / get_recipe / search_resources answer "has this failed
  before", which no single run can. That is the point of the layer.
- list_gateway_tools shows what other MCP servers are being re-exposed through
  Agent Manager.

READING A RUN HONESTLY

A stage that returns "completed" while the tool it called failed is the known
failure in this pipeline, and it is why nothing downstream ever escalates. When
a run shows "reported completed, actually faulted", say so in those words. Do
not summarise it as a success because its status field says so — repeating the
status is repeating the lie. If two of three stages faulted, lead with that.

WHAT YOU MAY WRITE

- append_step with kind "steering" and a signal (affirm / reject / correct) to
  record how a human steered or corrected a run. Corrections are the most
  valuable thing in the store.
- approve_step / approve_steps to mark the parts of a run worth keeping, then
  bake_recipe to hand it to the Hero Agent, which reads it against every
  earlier run and PROPOSES what should be learned. A named human always
  decides.

Always report model and tokens_used on anything you write. An omitted
tokens_used is recorded as "not reported", never as zero.
```

---

## 3. Testing it — in the order that isolates failures

**A. The estate reads.** *"List the agent systems and their agents."*
Expect 4 agents with owners. This only touches Agent Manager.

**B. The gateway works.** *"List the gateway tools."*
Expect 238 from `adobe-aec` and 96 from `workfront-adobe`, named
`adobe-aec__*` and `workfront-adobe__*`. This proves Agent Manager is
re-exposing two other MCP servers to you. Then:
*"Search Adobe knowledge for audience segmentation."*
Expect real Experience League results.

**C. A full run.** *"Start an intake for: Fall Switch and Save. Growth/Upsell
for Subscriber - Existing Customers in Residential (RES). Audience Build-Only.
Launch November. Upgrade journey. Email and SMS."*

Expect all three stages and a time ledger. Then open
<http://localhost:3000> → **Event Log** and read the artifacts. Any Workfront
object an agent created is linked from the artifact that created it.

Approvals live in **Agents → the Hero Agent card**, not a panel of their own:
the Hero Agent proposes and a named human decides, so both sit together.

**D. B1, the loop.** *"Start an intake for: we want to do something for our
existing customers next quarter."*

Expect `needs_input` asking for exactly **two** things — not the whole form.
That cap is the feature: re-asking eleven fields is what makes the rework loop
unbounded.

**E. The capture block.** Ask Claude to save an architecture diagram to Agent
Manager. Expect a refusal pointing you at the cookbook. This is deliberate.

---

## 4. Running the stack

```bash
# Agent Manager
docker run -d --name agent-manager -p 3000:8080 \
  -e DASHBOARD_REQUIRE_IDENTITY=true \
  -e BOOTSTRAP_ADMINS=bharat.dudeja@tapcxm.com \
  -e SERVICE_API_KEY=harness-service-key-local \
  -v agent-manager-data:/data agent-manager:latest
```

**On Windows, run that from PowerShell, or prefix it with
`MSYS_NO_PATHCONV=1`.** Git Bash rewrites POSIX-looking values into Windows
paths, so `-e STORAGE_ROOT=/data` silently becomes
`C:/Program Files/Git/data`, and every request returns 500 with a path nobody
recognises. Do not pass `STORAGE_ROOT` at all — the image sets it. If you get it
wrong the container now refuses to start and says exactly this.

The harness runs separately on `:3100` with its own Postgres. Agent Manager
reaches it at `host.docker.internal:3100`, set in **Settings → Agent systems**.

### The shared login

```
id        admin
password  Tapadmin@123
roles     chef + head-chef + admin
```

The same credential works on the dashboard and in the `x-cookbook-login` header
(`id:password`, one colon, no spaces).

**It is written down here on purpose, and that has a limit.** A shared password
in a repository is a reasonable trade for a container on a laptop or a box
behind a VPN, where the thing it protects is a demo. It stops being reasonable
the moment this has a public URL: anyone with read access to the repo can then
sign in as an admin, and admin can change MCP servers, roles and settings.

So before this is exposed to anything beyond the team:

1. `change_my_password` on the `admin` account, and take the new one out of this
   file.
2. Give each person their own login with `create_user`. Runs are private per
   user, so a shared account also means everybody sees one shared view - which
   defeats a feature, not just a security control.

Your own first account comes from `BOOTSTRAP_ADMINS`, which is why that
variable is on the `docker run` above.

---

## 5. Workfront links in the artifacts

When an agent creates something in Workfront, the narrated artifact carries a
direct link above the field table:

```markdown
**In Workfront**

- [OPTASK 5f2a1b](https://taplondonptrsd.my.workfront.com/issue/5f2a1b) — open it to review what the agent actually wrote.
```

The tenant comes from whichever Workfront MCP server is registered, so changing
tenant is a Settings change and the links follow.

Three rules it holds to:

- A link only when it can be built from a known object code. An unrecognised
  code gets **no** link, because a URL that 404s teaches you not to trust the
  next one.
- When the object is known but no tenant is configured, it names the object and
  says why there is no link. Silence would read as "nothing was created", which
  is a different and much worse claim.
- A **faulted** stage still gets its link, because that is exactly when you want
  to look.

---

## 6. Workfront: what works, verified

**Writes are on, and a real object exists.** Signed in as Bharat Dudeja against
`taplondonptrsd.my.workfront.com`, the connector exposes **96 tools** including
`workflow_create_any_object`, and Agent 1 created:

<https://taplondonptrsd.my.workfront.com/issue/6aaabb590007c6f855b8cd1d9f00ba9c>

In `CSC - Intake Queue`, named from the brief, the brief as its description, and
`DE:Campaign Name` written onto it.

If you sign out, or the token expires, the Authenticate button is in
**Settings → MCP servers → Workfront MCP (Adobe official)**. It opens Adobe's
own login; the token is stored server-side and is **never sent to the browser**
— all the page is ever told is whether one exists. Signing out is logged, with
who and when.

### Three things about this tenant that shape what an agent can write

1. **An issue needs a parent project.** Workfront refuses a parentless issue
   (`projectID cannot be null`). The queue is resolved by NAME
   (`CSC - Intake Queue`) rather than a stored id, because a hardcoded GUID is
   right until somebody rebuilds the queue and then it is silently wrong.

2. **The brief's fields are split across forms, and mostly are not on the
   issue.** `CSC Intake - Issue` carries `Campaign Name`;
   `CSC Campaign - Project` carries `Name of the Campaign` and
   `Objective of the campaign`; `Audience_to_be_Targeted` and
   `Requested_Launch_Date` are on neither. So an intake issue can carry ONE
   field of the brief today.

   Workfront also rejects the whole update when any single field is not on an
   attached form, naming only the first offender — so the agent writes field by
   field, keeps what lands, and **reports what was refused** rather than leaving
   a record that looks complete.

   **This is a configuration decision, not a code one:** either the issue form
   gains the brief's fields, or intake creates a project directly. The process
   map converts issue → project at 2.1 anyway.

3. **The in-house Workfront estate is not deployed.** Every `/mcp/workfront/*`
   and `/mcp/fusion/*` route returns 404. That is why the agents use Adobe's
   connector, and nothing is lost by it — every operation they use has an
   official equivalent.

## 7. What is still genuinely open

**Agent 3's attribute check reports *undetermined*, honestly.**
`adobe_get_schema` does not expand XDM `allOf`/`$ref` structures, so field-level
attribute availability cannot be determined with the current tools. The agent
says *undetermined* and, critically, does **not** open a GTO attribute request
off an inconclusive probe — an earlier version did, which would have started the
quarter-long tail for a question it had never actually asked.

Also: the AEP sandbox is `taplondonptrsd` — Tap's, not Comcast's. Assessing
Comcast's attributes there is not a meaningful check, and the agent surfaces the
sandbox name so you can see that rather than assume otherwise.

**Two credentials still need rotating, and neither is in this file.** An old
cookbook login that was pasted into chat and still sits in plaintext in
`~/.claude.json`, and Chauncey's RDS connection string. Both were exposed in
conversation, both need a human to rotate them, and I have deliberately not
written either one down here - see `docs/DECISIONS.md` for the exposure log.
