# Deploying Agent Manager next to the harness

**Goal:** Agent Manager on a public URL the whole of Tap can open, beside
Chauncey's harness, so a marketer can drive it from Claude Desktop.

`http://34.203.238.63:3000/` is Chauncey's Next.js app from
`chaunceyplum/intake_harness` (`src/app/runs/page.tsx` is that `/runs` page),
running on an EC2 instance in `us-east-1`. Same account as the MCP estate at
`cryuy4x9n5.execute-api.us-east-1.amazonaws.com`.

Agent Manager is a container and does not care where it runs. Putting it on the
same box is the shortest path: one host, one security group, no new account.

---

## What I need from Chauncey

Pick one. I cannot do any of them without access.

1. **SSH to the box** (key + user), and port **3100** opened in the security
   group. Then it is the four commands below.
2. **He runs the commands himself.** They are copy-paste and touch nothing of
   his.
3. **A separate EC2 instance** in the same VPC, if he would rather keep his host
   clean. Same commands, port 3000.

---

## The commands

From the repo, on the box:

```bash
git clone -b agent-manager https://github.com/chaunceyplum/intake_harness.git
cd intake_harness/services/agent-manager

docker build -t agent-manager:latest ./app

# A key the harness will use to reach Agent Manager's gateway. Keep it.
SERVICE_KEY="$(openssl rand -hex 24)"

docker run -d --name agent-manager --restart unless-stopped \
  -p 3100:8080 \
  -e STORAGE_DRIVER=fs \
  -e DASHBOARD_REQUIRE_IDENTITY=true \
  -e BOOTSTRAP_ADMINS=bharat.dudeja@tapcxm.com \
  -e INTERNAL_TOKEN="$(openssl rand -hex 24)" \
  -e SERVICE_API_KEY="$SERVICE_KEY" \
  -v agent-manager-data:/data \
  agent-manager:latest

curl -s localhost:3100/healthz
echo "harness should use SERVICE_API_KEY=$SERVICE_KEY"
```

Do **not** pass `STORAGE_ROOT`. The image sets it to `/data`, and overriding it
from a shell that rewrites POSIX paths (Git Bash on Windows, notably) produces a
container that starts, answers `/healthz` with 200, and returns 500 to every
real request with a path nobody recognises. The container now refuses to start
in that state and says so, but the simplest fix is not to pass it.

### Then, once: create the shared login

```bash
curl -s -X POST localhost:3100/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "x-api-key: $SERVICE_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_user",
       "arguments":{"id":"admin","password":"Tapadmin@123","display_name":"Tap Admin",
       "roles":["chef","head-chef","admin"]}}}'
```

`admin` / `Tapadmin@123`. **Change it before this has a public URL** - see the
note in `CLAUDE-DESKTOP-SETUP.md`. Runs are private per user, so a shared
account also means one shared view, which costs a feature as well as a control.

---

## Pointing the harness at the gateway

This is the part that makes the agents use Agent Manager rather than an MCP
estate directly, so which real server backs a tool becomes a Settings change
instead of a redeploy of the harness.

In the harness's own environment (`.env.local`, or however the service is
configured on the box):

```bash
# The agents reach their tools THROUGH Agent Manager.
MCP_GATEWAY_URL=http://localhost:3100/mcp
MCP_GATEWAY_HEADER=x-api-key
MCP_GATEWAY_TOKEN=<the SERVICE_KEY printed above>

# Which registered server serves which tool family. The estate is not one
# server: knowledge search is on the Adobe Experience Cloud one, Workfront
# objects are on Workfront's connector. A single prefix sent every Workfront
# call to the wrong server, where it failed while the run still read completed.
MCP_GATEWAY_ROUTES=adobe-aec:adobe_,search_adobe,knowledge_;workfront-adobe:workflow_,comment-stream_,approvals_,planning_,insights_

# Adobe's official Workfront connector, not the in-house estate - every
# /mcp/workfront/* route on that one returns 404.
WORKFRONT_MCP_FLAVOUR=adobe-official

# Where intake issues land. Resolved by NAME, so rebuilding the queue does not
# silently point this at a project that still exists and is no longer the one
# in use.
WORKFRONT_INTAKE_QUEUE=CSC - Intake Queue

# Still read by the legacy path, and the code throws without it.
MCP_ENDPOINT_URL=https://cryuy4x9n5.execute-api.us-east-1.amazonaws.com/mcp
```

Then, in Agent Manager at `http://<host>:3100`:

1. **Settings → Agent systems → Xfinity Creative Intake** — set the base URL to
   wherever the harness answers on the box (`http://localhost:3000` if it is on
   the same host). **Check** asks it for its own agent list; four agents come
   back if it is wired.
2. **Settings → MCP servers → Workfront MCP (Adobe official) → Authenticate** -
   opens Adobe's login. The token is stored server-side and is never sent to the
   browser. Turn on **on** and **to Claude**.
3. Same for **Adobe Experience Cloud MCP** (no sign-in needed).

`MCP_CONNECT_REDIRECT_URI` only needs setting if the box sits behind a proxy or
a domain - otherwise the callback is derived from the Host header the browser
actually used, which is what makes 3100-behind-8080 work without configuration.

### One thing to check before the OAuth round trip

Adobe redirects back to `<whatever the browser used>/mcp-connect/callback`. On a
public host that is `http://34.203.238.63:3100/mcp-connect/callback`, so **3100
has to be reachable from the browser doing the sign-in**, not just from the box.
If the security group only allows the office IP, sign in from the office.

Then `http://34.203.238.63:3100/`.

**Nothing here touches the harness.** Different port, different container, its
own volume. `docker rm -f agent-manager` removes every trace.

### Two settings that are not optional in the open

- `DASHBOARD_REQUIRE_IDENTITY=true` — the harness has no auth on any route, and
  copying that for something holding Comcast briefs would be a mistake.
- `INTERNAL_TOKEN` — a real random value, not the `change-me` I use locally.

### Storage

`STORAGE_DRIVER=fs` on a Docker volume is right to start. It is on one box, so
if the instance goes, the log goes. When that matters, switch to S3 with no code
change:

```
-e STORAGE_DRIVER=s3 -e STORAGE_BUCKET=agent-manager-log -e AWS_REGION=us-east-1
```

and give the instance role `s3:GetObject/PutObject/ListBucket/DeleteObject` on
that bucket. The S3 driver uses the default credential chain, so no key is
needed in the environment.

### Keeping the jobs running

Retention and the graph rebuild were cron on the old host. As HTTP endpoints,
`cron` drives them:

```
0 3 * * * curl -s -XPOST localhost:3100/internal/purge -H "x-internal-token: $TOKEN"
0 4 * * * curl -s -XPOST localhost:3100/internal/cx-refresh -H "x-internal-token: $TOKEN"
```

---

## Connecting Claude Desktop

Settings → Developer → Edit Config:

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

Quit Claude Desktop completely and reopen — the config is read only at startup.
Ask it to call `get_my_roles`; it should answer with your identity.

Your login comes from Settings → Team, which exports the whole of this as a file
per person, including the standing instruction.

---

## What will work on day one, and what will not

Being straight about this, because "create a brief in Workfront" is the thing
being asked for and **it cannot work yet.**

**Works:**
- Claude Desktop drives Agent Manager over MCP
- A brief starts a run on Chauncey's pipeline
- Intake, review and audience-creation execute
- Every stage is captured as artifacts of one run, visible in the dashboard
- Approve hands the run to the Hero Agent; a named human promotes

**Does not work yet, and neither is ours to fix:**

1. **No Workfront object is created.** Verified 16 Sep against the live
   endpoint: `/mcp/workfront/*` return **zero tools**, and no `wf_*` name appears
   among the 238 on `/mcp`. The code exists in `chaunceyplum/mcp`, so either the
   Workfront Lambdas are not deployed to that API Gateway or they are behind
   another one. **Until they are reachable, nothing can write to Workfront** —
   not Agent 1, not our Agent 2.

2. **Grounding fails on every run.** The tool is `search_adobe_knowledge`;
   `search_knowledge_base` does not exist. Agent 1 calls the wrong name, catches
   the error, writes it into its payload and returns `completed`. One string in
   `intake/route.ts` plus its allowlist entry in `registry.ts`.

Agent Manager will show both of these honestly rather than reporting a green
run — which is the point of it, but it is a poor first demo. **Both are one-line
fixes on Chauncey's side and worth doing before any demo.**

---

## Suggested order

1. Chauncey fixes the tool name — minutes, and every run stops silently failing
2. Chauncey confirms where the Workfront tools are deployed
3. Deploy Agent Manager on 3100
4. Create logins, hand out the kit from Settings → Team
5. A marketer writes a brief in Claude Desktop and we watch it land

Steps 3 to 5 do not depend on 1 and 2 — the log, the dashboard and the Hero
Agent all work without Workfront. But the demo is much better with them done.
