# verify-intake.sh — the intake brief acceptance test

Answers one question: **does the intake agent read a brief the way a Workfront
marketer would?**

```bash
# on the box
bash scripts/verify-intake.sh

# from anywhere, against the box
HARNESS=http://34.203.238.63:3100 bash scripts/verify-intake.sh
```

It **creates nothing**. Every case goes through `preview_intake`, which reads
the brief and the form and returns what *would* be filed — no Workfront object,
no run, no email.

## What each case is, and why it exists

Every one of these is a real defect, found by three agents using the system as
a Comcast campaign manager would, then reproduced against the live parser.

| # | Case | The defect it guards |
|---|---|---|
| 1 | **Amendment** | The marketer changed the date mid-brief. The first date won permanently and the correction was never even extracted, so a plan they had *cancelled* was previewed back confidently — and approving the preview is what sends the email. |
| 2 | **Contradiction** | "Acquisition" and "existing subscribers" in one brief, filed with zero flags. Prospects are not in the profile store at all, so this decides which build path runs and is discovered after the audience is built. |
| 3 | **Budget** | `Budget is $1.8M working media` was captured as the consumer **Offer**, labelled `stated`. The words *are* in the brief, which is what makes it dangerous: nothing looks wrong until creative builds against a $1.8M incentive. |
| 4 | **Genuine offer** | The guard for case 3 must not swallow real incentives. `$350 prepaid card` is still an Offer. |
| 5 | **Country** | `Region: US` was ignored while `in Pennsylvania` worked, so the system asked the marketer to pick `us` from a list containing `us`. Exactly inverted from how people brief. |

Two rules hold across every case:

- **At most two questions.** `nextQuestions` documents why: *"past two the agent
  has failed, not the marketer."*
- **A contradiction outranks a gap.** A missing field is something not yet said;
  a contradiction is something said twice, differently, which means the brief as
  it stands is wrong now.

## Reading the result

`PASS (form checks skipped: Workfront unreachable)` is expected while the
Workfront MCP is signed out. Reading the brief is fully covered; **writing to
the form is not** — `planFormWrites` reads the live form, so every `willWrite`
is `{}` until Workfront is authenticated. Sign in and the form assertions come
alive on the next run.

That distinction is deliberate. An earlier version asserted a form outcome while
Workfront was down and reported a red FAIL for a parse that was perfect, which
sends the next person hunting a regression that does not exist.

## Signing Workfront back in

Adobe's dynamic client registration is **loopback-only**: `127.0.0.1` and
`localhost` register, any public address is refused with `invalid_redirect_uri`
over http *and* https. So it cannot be done from the box's public URL.

```bash
ssh -L 8080:localhost:8080 ubuntu@34.203.238.63
# then sign in at http://127.0.0.1:8080
```
