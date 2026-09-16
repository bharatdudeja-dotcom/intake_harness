# CX Agent Manager

Cross-run memory, review and a knowledge graph over Comcast/Xfinity's Workfront
creative-intake agents — plus an MCP gateway that re-exposes those agents' own
tools to whatever is connected to it.

A client should be able to open this and see their agentic pipeline running:
which agent touched which run, where it reported success while actually
failing, and exactly where a human stepped in and decided.

It began from the TAP Company Cookbook's storage and graph engine and has since
diverged into its own product — its own domain model, its own MCP surface, its
own instructions to connected clients. That lineage still shows in some internal
names (a run is stored with `type: "recipe"`, because renaming a stored value
would orphan every record written before the rename), so this table is the
translation between what is stored and what things are called.

| Stored as | Called |
|---|---|
| Project | Programme |
| Recipe | Run — one Workfront intake |
| Step / ingredient | Event |
| Chef | Marketer |
| Head chef | **Hero Agent** — proposes only, never approves |
| Practice | Agent — from the registry, never hardcoded |
| Company CX Graph | Shared Knowledge Graph |
| Active tasks | Live Queue |
| Cook-off | removed |

The rule that does not move: **the Hero Agent proposes, a named human decides.**
Ask "who decided this was true" and the answer is always a person.

## Layout

```
app/     the service. Node, host-neutral, originally built on
         TAP-CXM/TAP-Cookbook@98617f6 (tap-portability-layer/connector)
docs/    LINEAGE.md        where the engine came from, and what is ours
         DECISIONS.md      decided, why, rejected — and what is still open
```

## Run it

```bash
cd app
npm install
npm run dev          # aio app run   — needs the aio CLI and Adobe I/O credentials
npm test
```

**It has not been deployed yet, and the UI has not been rendered** — that needs
an Adobe I/O namespace we do not have. See *Not yet verified* in
`docs/LINEAGE.md` for the honest state.

## The original is read-only

`TAP-CXM/TAP-Cookbook`, its deployed connector and its storage are never
modified. If something there looks broken it goes in `docs/DECISIONS.md` and to
Bharat.

**Before any deploy:** change the App Builder namespace and the package name in
`app/app.config.yaml`. The package key sets the deploy URL segment, so deploying
as-is would land on top of the original connector.
