# STORY.md — the Agentic Hero's Journey, as this product uses it

Source: *Agentic Hero's Journey Master Presentation*, TAP CXM (Josh Smith), read
15 September 2026. Plus Josh's and Bharat's own reading in chat that same day,
which settles two things the deck leaves open.

The framework is a **useful analogy, not a taxonomy to implement exhaustively**.
Bharat: *"we don't need to map all of it."* What follows is the part that earns
its place in the product, and nothing more.

---

## Who is who

The deck lists Hero, Ally and Trickster as the three agentic roles, with seven
human mentor roles around them. Josh and Bharat then made it sharper, and this
is the reading the product uses:

| Role | Who | Where it lives in the build |
|---|---|---|
| **Hero** | **The data.** Not a person, not an agent. | The append-only event log. What accumulates across runs *is* the hero. |
| **Author** | **The humans, collectively.** They edit and approve artifacts as the process runs. | `users.is_human`, gate decisions, `graph_nodes.promoted_by` |
| **Mentor** | Agent that carries what previous runs learned and hands it over | `mentor/curator.py`, agent role `mentor` |
| **Ally** | Agent that extends what the hero can do — prep, enrichment | Intake, Audience Creation |
| **Trickster** | Agent that introduces friction deliberately — adversarial checks | Review/Triage, Escalation |

Deck principle 3 states it outright: *"The data is the hero; the team is the
author."* That is why **the brief's "Hero Agent" is called the Mentor Agent
here.** The brief already described it as *"the mentor who accompanies the hero,
carries what every previous hero learned, and hands it over at the moment it is
needed"* — which is Vogler's Mentor exactly: *"all the characters who teach and
protect heroes and give them gifts."* Only the label changed, and it changed so
that "hero" can mean the data, consistently, everywhere.

The seven human mentor roles — visionary, governor, steward, driver, informer,
gate keeper, facilitator — are `AUTHOR_ROLES` in `journey/model.py`, and a
stage's `approver_role` names which one signs off. Gate Keeper is the default:
*"approves what crosses each threshold into production."*

## Stages are artifacts

Bharat: *"to me, the stages in each act are the digital artifacts."* Josh: *"True,
I agree."*

This is the single most load-bearing idea in the whole build, because it makes
the framework executable rather than decorative. Each stage in
`config/journey.*.yaml` names the artifact it produces, the agent role that
plays it, and the human role that authors or approves it. The dashboard's stage
badges are those artifacts, and a gate is the Author editing one.

## The arc

| Act | Deck's intent | What it is here |
|---|---|---|
| **Prologue** — Setting the Stage | Vision, cost and value made visible before any agent is introduced | The marketer's raw brief, event 0, captured verbatim |
| **Act 1 · Separation** | First agents enter a still-manual system; *"does the data exist, is it accessible, what does it mean?"* | Intake and grounding |
| **Act 2 · Initiation** | Agents coordinate; cohesion becomes the real work | Review, audience creation, the Workfront write, escalation |
| **Act 3 · Return** | *"Return with new mastery."* Humans move from operating agents to governing them | Proposal and promotion into the knowledge graph |

**Act 3 is the product.** Bharat: *"I think we always position the data as the
hero agent as the recursive learning is the Act 3 'return with new mastery' —
realizing the dream of a truly recursive learning closed loop system."*

A run that ends with a submitted Workfront request and teaches the organisation
nothing has not finished Act 3. That is why `promotion` is a stage with a gate
on it and not a reporting view.

## The four guiding principles, and where each one is enforced

1. **Performance is variable, and must be discovered.** No metric is cached into
   its own table; every figure derives from events at read time.
2. **Diversity of tests drives performance.** The registry is dynamic and the
   journey is data, so adding an agent or a stage does not require a deploy.
3. **The data is the hero; the team is the author.** The event log is
   append-only; the humans decide.
4. **Governance-through-transparency is the precondition.** *"No agent gets
   more autonomy than the organization can see, explain, and correct."* This is
   the reason the Mentor Agent has no promotion code path, and the reason a
   stage badge is derived from evidence rather than from an upstream status
   field.

## Reusability — why the process is data

Bharat: *"we should be able to take any as-is process, imagine a future process
and feed it into this solution we're building. should be highly reusable."*

So the process is a YAML file, not code:

- `config/journey.*.yaml` — acts, stages, artifacts, approver roles, gates
- `config/artifact.*.yaml` — the fields of an artifact and what makes it complete
- `config/agents.yaml` — which agents exist, discovered live where possible
- `config/workfront.yaml` — the system-of-record object model

Nothing in `src/` names an act, a stage, an agent or a client. To onboard a
different process — a different client, a different as-is-to-future-state
mapping — write those files and restart. The maturity ladder on deck slide 17
(L0–L4) is the honest way to say which act a given client's process is
currently in, and the journey file is where that judgement gets written down.

## Still open

The other three files are still unread: the *Story Coach Report 2*, the *TAP
Analyst Playbook*, and the *TAP Story Coach (Claude Skill)* zip. The master
presentation was enough to fix the naming and the arc. If the Story Coach report
contradicts anything above, it wins — correct this file and the journey YAML
together, since the UI reads its language from the YAML.
