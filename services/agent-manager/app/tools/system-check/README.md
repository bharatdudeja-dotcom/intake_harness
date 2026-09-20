# System check

Answers one question in about fifteen seconds: **is the CX demo going to work
right now?**

```
tools\system-check\check.cmd          double-click it
python tools/system-check/check.py    same thing
python tools/system-check/check.py --json   machine readable, for CI
```

It prints a checklist, writes `status.html` next to itself, and opens that in
the browser. Exit code is non-zero if anything failed, so it can gate a deploy.

## What it checks, and why

| Check | Why it is here |
|---|---|
| The box is reachable | Nothing else can be true if the ports are shut. |
| The harness is answering | It runs the agents; if it is down, no intake can be filed. |
| The dashboard is being served | This is what you and the client actually look at. |
| The MCP endpoint is up and locked | Claude Desktop connects here. **A 200 without a credential is the alarm, not the pass.** |
| Claude Desktop can discover sign-in | Without OAuth discovery, connecting fails before it starts. |
| Workfront and AEP are connected | The important one - see below. |
| Recent runs look healthy | Whether the pipeline has been working, not just whether it is up. |
| What main is at | A fix that is merged but not deployed is not a fix. |

**The gateway check is the one that earns its keep.** `list_gateway_tools`
reports a tool count per MCP server, and a count only comes back if the server
was reached *and* its tools were listed - which for Adobe means the OAuth token
was accepted. An expired Adobe token is the most common way this demo dies
quietly, and here it shows up as a server with an error and no tools, ten
seconds before the demo rather than twenty minutes into it.

Expect `workfront-adobe: 97 tools` and `adobe-aec: 239 tools`. The check allows
drift upward - Adobe add tools without telling anyone - but flags a collapse.

## Credentials

The deep checks need a dashboard login, and it is **not** stored in this
directory's tracked files. Put it in `local.env` beside the script:

```
AM_USER=admin
AM_PASS=your-password
```

`local.env` is gitignored. Or set `AM_USER` / `AM_PASS` in the environment.
Without either, the deep checks report SKIPPED with that instruction - they do
not pass silently, because a check that cannot run must not look like a check
that passed.

## Pointing it somewhere else

`AM_HOST` overrides the box address (default `34.203.238.63`), and `AM_REPO`
overrides which repo's `main` the version check reads.

## What it deliberately does not do

It does not SSH anywhere, so it needs no key and can be run by anyone. That
means it reports what `main` *should* be, not what the box *is* running -
confirming the deployed commit needs a shell on the box.
