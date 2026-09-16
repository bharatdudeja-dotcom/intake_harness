# Local-only, not for the PR

## Agent 1

Agent 1 (Intake) is **Uday's**. What is here is ours, built only so the 1 → 2 → 3
flow can be exercised end to end before his lands. It is git-ignored on purpose:
`src/lib/agents/intake/` and this folder.

To test with it:

```bash
cp local/agent1/route.ts src/app/api/agents/intake/route.ts
```

and add these to intake's `allowedTools` in `src/lib/pipeline/registry.ts`:

```
"search_adobe_knowledge",            # replaces search_knowledge_base, which does not exist
"wf_core_issue_set_custom_fields",   # DE: values, after the record carries its categoryID
```

To put it back before committing:

```bash
git checkout origin/claude/nextjs-scaffold -- src/app/api/agents/intake/route.ts src/lib/pipeline/registry.ts
```

...and then re-apply the review-only allowlist change, which IS ours.

## What it does

`parse.ts` reads a brief into the Campaign Brief fields, marking every value
`stated`, `derived` or `inferred`, and asks for the **two** things actually
missing rather than the whole form — B1's loop count is the metric, and past two
rounds the agent has failed, not the marketer.

`workfront.ts` creates the intake issue in two calls, in the order the tool
requires: create with `categoryID`, then set the DE: custom fields. Pluggable —
while the Workfront routes 404 it records the exact payload it would have sent.

## Worth passing to Uday either way

Two findings that apply to his build regardless of whose code ships:

1. `search_knowledge_base` **does not exist**. The tool is
   `search_adobe_knowledge`. Verified against the live endpoint, 238 tools.
2. The stub catches that error, writes it into its output, and still returns
   `completed`. Because `failed` never fires, Agent 4 is never invoked — so
   escalation has never once run.
