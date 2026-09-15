# STORY.md

The Agentic Hero's Journey, as Josh Smith actually wrote it, and how Agent
Manager uses it.

**Source:** *Agentic Hero's Journey Master Presentation*, TAP CXM (Josh Smith).
Read directly. This file replaces the beats I previously inferred — see
`docs/BRAIN-GAP.md` §3 for what was wrong and why.

**Still unread:** *Story Coach Report 2*, *It's Not Magic, It's Method — TAP
Analyst Playbook*, *TAP Story Coach (Claude Skill)*. If any of them contradicts
this file, they win.

---

## Who is who

Josh's deck lists Hero, Ally and Trickster as the three agentic roles, with
seven human mentor roles around them. Josh and Bharat then sharpened it, and
this is what the product uses:

| Role | Who | Where it lives |
|---|---|---|
| **Hero** | **The data.** Not a person, not an agent. What accumulates. | The append-only event log |
| **Author** | **The humans, collectively.** They edit and approve the artifacts. | `users.is_human`, gate decisions, `promoted_by` |
| **Hero Agent** | Carries what earlier runs learned and hands it over when needed. **Proposes only.** | Where the cookbook let a head chef approve |
| **Ally** | Extends what the hero can do — prep, enrichment | Intake, Audience Creation |
| **Trickster** | Introduces friction deliberately — adversarial checks | Review/Triage, Escalation |

Deck principle 3 states it outright: *"The data is the hero; the team is the
author."* That is why the curating agent is the **Hero Agent** and not a mentor:
"hero" has to mean one thing everywhere, and the deck already decided what.

The seven human mentor roles — visionary, governor, steward, driver, informer,
gate keeper, facilitator — are the `AUTHOR_ROLES`. Gate Keeper is the default:
*"approves what crosses each threshold into production."*

## Stages are artifacts

Bharat: *"to me, the stages in each act are the digital artifacts."*
Josh: *"True, I agree."*

This is the load-bearing idea, because it makes the framework executable rather
than decorative. Each stage names the artifact it produces, the agent role that
plays it, and the human role that approves it.

---

## The beats, exactly as Josh has them

**Corrected.** I previously used "Meeting with the Mentor" — that is Vogler's
Act 1 beat and it is not in Josh's deck. I also put "Belly of the Whale" in
Act 2; Josh closes Act 1 with it.

### Prologue — Setting the Stage
*Vision, cost and value made visible before any agent is introduced.*

| Beat | Deliverable | Framework |
|---|---|---|
| The Dream | Goals, Objectives, Moments & Outcomes; Use Case Narratives | VSMO · UML |
| Cost Landscape | Data Architecture; System Architecture | DAMA-DMBOK + Microservices |
| Value Landscape | Value-Based Outcomes; VBO Hierarchy | TAP CXM proprietary |
| The Plan for Separation | Ideal Business Case; Prioritized Use Cases; Roadmap | TAP CXM proprietary |

### Act 1 · Separation
*First agents enter a still-manual system. "Does the data exist, is it
accessible, and what does it mean?"*

Call to Adventure · Refusal of the Call · Supernatural Aid ·
Crossing the Threshold · Belly of the Whale

### Act 2 · Initiation
*Multiple agents coordinate for the first time. Cohesion becomes the real work.*

Road of Trials · Meeting w/ the Goddess · Woman as Temptress ·
Atonement w/ the Father · Apotheosis · Ultimate Boon

### Act 3 · Return
*"Return with new mastery." Humans move from operating agents to governing them.*

Magic Flight · Crossing the Return Threshold · Master of the Two Worlds

**Act 3 is the product.** Bharat: *"the recursive learning is the Act 3 'return
with new mastery' — realizing the dream of a truly recursive learning closed
loop system."* A run that submits a request and teaches the organisation nothing
has not finished Act 3.

---

## The naming problem, unresolved

Two of Josh's Act 2 beats are Campbell's originals: **"Woman as Temptress"** and
**"Atonement w/ the Father"**. Correct scholarship, and fine in a methodology
deck.

They are not fine as headings on a dashboard a Comcast marketer opens daily.

**Recommendation:** keep Josh's beats as the internal methodology, and give the
UI plain stage names taken from the process itself. The story earns the sale;
the dashboard has to survive daily use by someone who was not in the session.
`config/` carries both, so this is a label swap and not a rebuild.

**This is Bharat and Josh's decision, not mine.** Until it is made, the UI uses
the process names below and the beats stay in this file.

### The working mapping

Josh's beats against David Ross's numbered process, with the plain UI label.

| Act | Josh's beat | Process step | UI label | Agent |
|---|---|---|---|---|
| Prologue | The Dream | 1.1 marketer's prompt | **Brief** | — |
| Act 1 | Call to Adventure | 1.2 build intake | **Intake** | Intake |
| Act 1 | Supernatural Aid | 1.2 grounding in AEP schemas | **Grounding** | Intake |
| Act 1 | Refusal of the Call | 1.2a bounce back to marketer (B1) | **Clarification** | Intake |
| Act 2 | Road of Trials | 1.5a rejection and rework (B2) | **Triage** | Review |
| Act 2 | Meeting w/ the Goddess | 2.3–2.7 audience build (B3, B4) | **Audience Build** | Audience Creation |
| Act 2 | Atonement w/ the Father | 3.1 FAC vs rule builder (B5) | **Build Route** | Audience Creation |
| Act 2 | Apotheosis | 3.3–3.5 counts and approval (B6) | **Count Validation** | Audience Creation |
| Act 2 | Ultimate Boon | 3.2 activation to channels | **Activation** | — |
| Act 3 | Magic Flight | 4.1–4.4 reconciliation (B7, B8) | **Reconciliation** | — |
| Act 3 | Crossing the Return Threshold | 4.6 escalation classified (B9) | **Escalation** | Escalation |
| Act 3 | Master of the Two Worlds | promotion into the shared graph | **Promotion** | Hero Agent proposes; a human decides |

Two things this mapping makes visible:

- **Act 3 has no agent owner in Chauncey's system.** B7, B8 and B9 are
  unclaimed or unassigned. That is Agent Manager's territory.
- **"Belly of the Whale" and "Woman as Temptress" have no process step.** Rather
  than invent one, they are left unmapped. An honest gap beats a forced fit.

---

## The four principles, and where each is enforced

1. **Performance is variable, and must be discovered.** No metric is cached into
   its own table; every figure derives from events at read time.
2. **Diversity of tests drives performance.** The registry is dynamic and the
   process is data, so adding an agent or a stage needs no deploy.
3. **The data is the hero; the team is the author.** The log is append-only; the
   humans decide.
4. **Governance-through-transparency is the precondition.** *"No agent gets more
   autonomy than the organization can see, explain, and correct."* This is why
   the Hero Agent has no promotion code path, and why a stage badge is derived
   from evidence rather than from an upstream status field.
