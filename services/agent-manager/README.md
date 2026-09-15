# Agent Manager

A fork of the TAP Company Cookbook, rebranded and extended for Comcast/Xfinity
Workfront creative intake.

Same engine, same knowledge graph, new meaning. A client should be able to open
this and see their agentic pipeline running — which agent touched which run, and
exactly where a human stepped in and decided.

| Cookbook | Agent Manager |
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
app/     the fork. Node on Adobe I/O Runtime, forked from
         TAP-CXM/TAP-Cookbook@98617f6 (tap-portability-layer/connector)
docs/    COOKBOOK-FORK.md  what was forked, how it works, what was renamed
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
`docs/COOKBOOK-FORK.md` for the honest state.

## The original is read-only

`TAP-CXM/TAP-Cookbook`, its deployed connector and its storage are never
modified. If something there looks broken it goes in `docs/DECISIONS.md` and to
Bharat.

**Before any deploy:** change the App Builder namespace and the package name in
`app/app.config.yaml`. The package key sets the deploy URL segment, so deploying
as-is would land on top of the original connector.
