# BRAIN-GAP.md

What the central brain is being asked to do, what exists, and what is missing.

**Sources actually read**, not paraphrased:

| Source | Status |
|---|---|
| `Blockers_and_Agent_Intervention_Points-4.pdf` (David Ross) | **Read.** v4 — newer than the v2 the brief asked for. Includes the full end-to-end flow diagram and all nine blockers. |
| `Agentic Hero's Journey Master Presentation` (Josh Smith) | **Read.** |
| `chaunceyplum/intake_harness` source + live API | **Read.** |
| `chaunceyplum/mcp` source | **Read.** |
| Story Coach Report 2, TAP Analyst Playbook, Story Coach skill zip | **Not found.** Not in Downloads, not in any readable SharePoint or OneDrive. |
| A document from David defining "the central brain" | **Does not exist that I can find.** See §2 — this matters. |

---

## 1. The nine blockers, as David numbered them

The process is four phases: **1 Intake and Approval · 2 Audience Build ·
3 Audience Creation, Activation and Count Validation · 4 Reconciliation and
Escalation.**

David's framing, verbatim, because it changes what Agent Manager is for:

> *"Agents already sit on the happy path. The value is at the points where the
> process stalls, loops, or hands off between teams... Because the manual effort
> has largely been designed out already, what is left to attack is **waiting
> time** — the review queue, the nightly job, the DPG response, and the two
> undefined branches at 2.7a and 3.1b."*

**The product is not automation. It is the elimination of waiting.** Every
number below is a clock, not a task.

| B | Step | The blocker | Agent | Owner today |
|---|---|---|---|---|
| **B1** | 1.2a | Agent cannot build intake from the prompt; bounces to marketer. Loop is **unbounded**. | Agent 1 Intake | Uday |
| **B2** | 1.5a | Review queue rejects; nothing reads the rejection reason; marketer guesses. *"The largest unclaimed gap in the map."* | Agent 2 Review/Triage | **Us** — Bharat, Dylan, Jeff |
| **B3** | 2.5 | Marketer validates audience **by eye**. One of only three human steps left, and the only value-adding one. Expected-vs-actual disputes start here and surface too late to be cheap. | Agent 3 | Chauncey |
| **B4** | 2.7a | Attributes unavailable → leaves the process into a separate GTO workflow, returns at 2.7. *"Still the quarter-long tail."* | Agent 3 + a separate agent | Chauncey + GTO |
| **B5** | 3.1b | FAC branch is a workflow **not yet defined**. Uday's point that the FAC APIs are not open sits unresolved underneath it. | Agent 3 upstream at 3.1 | Chauncey; discovery unowned |
| **B6** | 3.3 | Segmentation job runs **once a night at 9:45pm**. Every rework cycle past this point costs a minimum of one full day. | Agent 3 | Chauncey |
| **B7** | 4.1 | DPG request is now raised automatically; what remains is **DPG's turnaround** and whether the request carries enough to act on. | — | **Unclaimed** |
| **B8** | 4.3 | DPG and GTO reconcile source data by hand, with no shared context package and **no record of what was already ruled out**. | — | **Unclaimed** |
| **B9** | 4.6 | Full escalation. Process terminates without an audience, **and nothing is captured**. | Agent 4 Escalation | **Unassigned** |

### Corrections to the briefs

- The kickoff briefs listed B1, B2, B4, B5, B6, B8, B9. **B3 and B7 were missing
  entirely.** Both are Agent Manager work — see §4.
- The briefs said Agent 4 handles B9 only. David ties B9 explicitly to *"the
  crawl, walk, run loop in section 10"* — the learning loop. That is not an
  error handler. **That is the knowledge graph.**
- B4's return path *"is now defined"* in v4. Earlier material treated it as open.

### Phase 4 is an unresolved scope question

David: *"Is phase 4 in or out of the first build? It was parked in the session
but is fully drawn here, so the scope decision is now implicit rather than
deliberate."* B7 and B8 are both in phase 4, and both are Agent Manager's
natural work. **Somebody has to decide this.**

---

## 2. What the central brain is asked to do

**There is no document from David defining "the central brain."** I have looked.
His blockers map describes what agents must do at nine points; it never names a
brain, and neither does anything else I can read. The brief says David and
Dhanesh own that piece — so this section is derived from the blockers, and
**must be checked with them before anyone builds to it.**

What the nine blockers actually demand, once you separate per-run work from
work that only exists across runs:

**Per-run, and already Chauncey's:** parsing a brief (B1), deciding FAC vs rule
builder (B5), predicting a count (B6), checking attribute availability (B4).

**Cross-run, and nobody's today:**

1. **Loop count as a health metric (B1).** *"More than two rounds means the
   agent failed, not the marketer."* A round is invisible from inside one run.
2. **Request age (B7).** *"Track the request's age, so it cannot sit unanswered
   with nobody owning it."* Age is a clock that outlives the run that started it.
3. **An evidence pack (B7, B8).** *"The brief, the audience definition, the
   counts at each stage and the identity model in play"* and *"no record of what
   was already ruled out."* That record is the thing.
4. **Failure classification that accumulates (B9).** *"Without it, the same
   class of failure recurs indefinitely and the agents never improve."*
5. **Visible status during a hand-off (B4).** *"Give the marketer a visible
   status instead of silence"* while a sub-workflow runs for a quarter.

Every one of those is memory. **The brain is the memory, and the waiting is
what the memory is for.**

---

## 3. Josh's story beats — and a correction I have to own

I inferred stage names from a second-hand description and **got one wrong.**
Against the master presentation:

| Act | Josh's actual beats |
|---|---|
| **Prologue** — Setting the Stage | The Dream · Cost Landscape · Value Landscape · The Plan for Separation |
| **Act 1 · Separation** | Call to Adventure · Refusal of the Call · Supernatural Aid · Crossing the Threshold · Belly of the Whale |
| **Act 2 · Initiation** | Road of Trials · Meeting w/ the Goddess · Woman as Temptress · Atonement w/ the Father · Apotheosis · Ultimate Boon |
| **Act 3 · Return** | Magic Flight · Crossing the Return Threshold · Master of the Two Worlds |

**"Meeting with the Mentor" is not in Josh's deck.** It is Vogler's Act 1 beat,
and I used it for audience creation. Josh's Act 2 beat in that position is
"Meeting w/ the Goddess". I also placed "Belly of the Whale" in Act 2; Josh has
it closing Act 1. Both are now corrected in `docs/STORY.md`.

Confirmed correct: The Dream (Prologue), Call to Adventure (Act 1 opener),
Road of Trials (Act 2 opener).

### A problem nobody has raised yet

Josh's Act 2 beats are Campbell's originals: **"Woman as Temptress"** and
**"Atonement w/ the Father"**. They are correct scholarship and they are fine in
a methodology deck.

They are not fine as column headings on a dashboard a Comcast marketer opens
every day.

Three options, and this is Bharat and Josh's call, not mine:

1. Keep Josh's beats as the **internal methodology**, and give the UI plain
   stage names drawn from the process itself (Intake, Triage, Audience Build,
   Activation, Reconciliation). The story stays in the deck where it persuades.
2. Use Josh's beats but retitle the two awkward ones, accepting that the
   framework is then quoted loosely.
3. Use them verbatim and accept the risk.

**Recommendation: option 1.** The story earns the sale; the dashboard has to
survive daily use by someone who did not attend the session. `config/` keeps
both, so the choice is a label swap, not a rebuild.

---

## 4. The gap list

What the brain needs that **neither Chauncey's system nor CX Agent Manager**
provides today.

### Confirmed: Chauncey's database holds nothing cross-run

Three tables, and I checked the schema and the live API rather than assuming:

```
runs       one row per pipeline invocation
tasks      STATIC catalog, 4 rows, seeded from his pipeline registry
task_runs  one row per agent step within a run
```

No classification store, no history, no aggregates, no knowledge. `task_runs.metadata`
is per-step JSONB and dies with its run. **We are adding, not duplicating** —
§3 of the brief is confirmed, and Chauncey said as much himself: Agent 4 needs
*"somewhere persistent to accumulate classifications across runs, since today's
version only lives inside that one run's `task_runs` row."*

### The gaps

| # | Gap | B | Fork status |
|---|---|---|---|
| 1 | **Loop count across rounds.** Nothing increments or compares it. | B1 | Not built. Needs the ingest port. |
| 2 | **Request age with an owner.** No clock on an open GTO or DPG request. | B4, B7 | **Nothing anywhere.** Biggest unclaimed gap. |
| 3 | **Evidence pack.** Counts at each stage, audience definition, identity model, and what was ruled out. | B7, B8 | The step model holds it; the composition does not exist. |
| 4 | **Failure classification that accumulates and counts recurrence.** | B9 | Built in the Python app, **not yet ported.** |
| 5 | **Visible status during a hand-off**, so a quarter-long wait is not silence. | B4 | Not built. Needs a blocked state with a named owner. |
| 6 | **A marketer identity.** Every ingested run reads `unattributed@tapcxm.com`. | B1, B3 | **Defect.** CX Agent Manager's `owner` resolution fixes it; not yet wired. |
| 7 | **A status that tells the truth.** Runs reach `submitted` carrying a silent intake error. | B9 | **Defect, and the more serious one.** See below. |
| 8 | **Cross-domain hub.** One shape for Workfront, AEM and Campaign agent systems. | — | Designed, not built. |

### On gap 7, because the brief asked directly

The brief is right that this implicates the reconciler. It is worse than a
display bug.

Upstream, `intake/route.ts` catches a tool failure, writes it into the payload,
and returns `status: "completed"`. Because `failed` never fires, **Agent 4 is
never invoked** — so B9, the learning loop, has never once run. The escalation
wiring in `orchestrator.ts` is correct and waiting on a status that never
arrives.

The Python build handled this correctly and it is the part most worth porting:
the stage badge derives from **evidence** — walking the payload for an embedded
error, and checking reconciliation verdicts — never from the upstream status
field. That logic must survive into CX Agent Manager, or CX Agent Manager inherits the bug it
exists to expose.

It is also the honest demo. A per-run view says every run succeeded. Only
something reading across runs notices the same tool has failed every time.

---

## 5. What I need answered before building

**From David and Dhanesh**
1. Is there a definition of the central brain I have not seen? §2 is derived,
   not quoted, and I would rather be corrected now.
2. Is phase 4 in or out of the first build? B7 and B8 are ours if it is in.
3. Who owns the review queue decision at 1.5, and **is the rejection reason
   captured anywhere structured today?** B2 — our agent — depends entirely on
   this. If the reason is free text in a Workfront comment, Agent 2 is a parsing
   problem; if structured, it is a lookup.

**From Josh**
4. The three unread files, and a ruling on §3's naming problem.

**From Chauncey**
5. `MCP_ENDPOINT_URL`. Still blocking every Workfront call.

**From the client**
6. Is the 9:45pm job time fixed? David: *"If it can move, B6 shrinks
   considerably."* This is the cheapest available win in the entire map and it
   is a scheduling question, not an engineering one.

---

## 6. Where this leaves Agent Manager

Of the nine blockers, **Agent Manager owns the cross-run half of six**: B1 loop
count, B4 open-request state, B7 age and evidence, B8 the ruled-out record, B9
classification and the learning loop, and B3's expected-vs-actual history.

That is not a dashboard. It is the thing David describes needing at five
separate points without ever naming it.
