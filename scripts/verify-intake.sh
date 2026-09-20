#!/usr/bin/env bash
# THE INTAKE BRIEF ACCEPTANCE TEST.
#
# Answers one question: does the intake agent read a brief the way a Workfront
# marketer would? Every case is a real defect, found by agents using the system
# as a Comcast campaign manager would, then reproduced against the live parser.
#
# It creates NOTHING. Every case goes through preview_intake, which reads the
# brief and the form and returns what WOULD be filed - no Workfront object, no
# run, no email. That matters: this is what someone reaches for when the demo
# is an hour away.
#
#   bash scripts/verify-intake.sh
#   HARNESS=http://34.203.238.63:3100 bash scripts/verify-intake.sh
set -u
H=${HARNESS:-http://localhost:3100}

python3 - "$H" <<'PY'
import json, sys, urllib.request

BASE = sys.argv[1]

def preview(brief, timeout=240):
    body = json.dumps({"input": {"brief": brief}}).encode()
    r = urllib.request.Request(BASE + "/api/intake/preview", data=body, method="POST")
    r.add_header("content-type", "application/json")
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.load(resp)

CHANGED_MIND = (
    "10G upgrade push for existing Xfinity Internet customers in Ohio. Channel: email. "
    "Launch 20 October. Campaign name: Ohio 10G Q4.\n\n"
    "Actually, scrap that - add direct mail, pull the in-market date forward to "
    "6 October, and the offer moves to $20/mo."
)

PUSH_AS_VERB = (
    "Winback for lapsed Xfinity Internet customers in Ohio. Channel: email. "
    "Launch 14 March. Campaign name: OH Winback.\n\n"
    "Actually scrap the email idea - and push it to paid social instead."
)

CASES = [
  ("1. AMENDMENT      the marketer changes their mind mid-brief",
   "Expect: BOTH dates seen, and the disagreement is question one.",
   CHANGED_MIND),

  ("2. CONTRADICTION  acquisition aimed at existing customers",
   "Expect: flagged. Prospects are not held at all, so this changes the whole build.",
   "Acquisition campaign targeting net-new prospects who have never been Xfinity "
   "customers. Audience: our existing residential subscribers with Xfinity TV. "
   "Channel: email. Campaign name: Contradiction Test."),

  ("3. BUDGET         money the business spends is not a consumer offer",
   "Expect: Budget, NOT Offer. '$1.8M working media' as an Offer would reach creative.",
   "Q1 winback for lapsed Xfinity Internet customers in Illinois who left in the last "
   "9 months. Channel: email. In-market 14 February. Budget is $1.8M working media. "
   "Campaign name: IL Winback Q1."),

  ("4. GENUINE OFFER  a real consumer incentive still reads as one",
   "Expect: Offer. The budget rule must not swallow actual offers.",
   "Winback for lapsed Xfinity Internet customers in Illinois. Channel: email. "
   "In-market 14 February. Offer is a $350 prepaid card. Campaign name: IL Winback Card."),

  ("5. COUNTRY        naming the country must work, like naming a state",
   "Expect: United States, zero questions. 'Region: US' used to be ignored entirely.",
   "10G upgrade push for existing Xfinity Internet customers across the US who have "
   "not upgraded in a while. Channel: email. Launch 14 February. Campaign name: "
   "10G Upgrade Q1. Growth/Upsell, residential. Audience and campaign execution."),

  ("6. LEGAL DEADLINE a sign-off date is not a rival launch date",
   "Expect: launch 20 November, NO conflict. Read as a launch date, it hid the deadline.",
   "Holiday promo for Xfinity Internet in the Northeast. Channel: email. Legal sign-off "
   "by 1 October, in market 20 November. Campaign name: Holiday Promo NE."),

  ("7. PUSH AS A VERB  'push it to paid social' is not the Push channel",
   "Expect: no Push. A fabricated channel gets approved, briefed and built.",
   PUSH_AS_VERB),
]

PASS = FAIL = 0
for title, expect, brief in CASES:
    print("=" * 78)
    print(title)
    print("  " + expect)
    print("=" * 78)
    try:
        d = preview(brief)
    except Exception as e:
        print("  REQUEST FAILED:", str(e)[:140]); FAIL += 1; continue

    cap = {str(c.get("field")): (c.get("value"), c.get("from")) for c in (d.get("captured") or [])}
    print("  captured:")
    for k, (v, src) in cap.items():
        print("      %-24s = %-40s [%s]" % (k[:24], str(v)[:40], src))
    if d.get("conflicts"):
        print("  conflicts:")
        for c in d["conflicts"]:
            print("      %s: %s" % (c.get("key"), " vs ".join(map(str, c.get("values") or []))))
    print("  writes to Workfront : %s" % json.dumps(d.get("willWrite") or {})[:110])
    print("  questions (%d/2):" % len(d.get("missing") or []))
    for m in d.get("missing") or []:
        print("      - %s" % str(m.get("ask"))[:110])

    n = len(d.get("missing") or [])
    ok = n <= 2

    # Reading the brief is testable with Workfront down; WRITING to the form is
    # not. planFormWrites reads the live form, so when Workfront is signed out
    # every willWrite is {} and a form assertion fails for a reason that has
    # nothing to do with the code under test. Reporting that as FAIL sends the
    # next person hunting a regression that is not there.
    form_readable = bool(d.get("formFieldsSeen"))
    conflict_keys = [c.get("key") for c in (d.get("conflicts") or [])]

    if title.startswith("1."):
        ok = ok and "launch_date" in conflict_keys
    if title.startswith("2."):
        ok = ok and bool(conflict_keys)
    if title.startswith("3."):
        ok = ok and "Budget" in cap and "Offer" not in cap
    if title.startswith("4."):
        ok = ok and "Offer" in cap
    if title.startswith("5."):
        ok = ok and cap.get("Region / market", ("", ""))[0] == "United States" and n == 0
        if form_readable:
            ok = ok and (d.get("willWrite") or {}).get("DE:Region") == "us"
    if title.startswith("6."):
        ok = ok and "launch_date" not in conflict_keys
        ok = ok and cap.get("Launch date", ("", ""))[0] == "20 November"
    if title.startswith("7."):
        ok = ok and "Push" not in str(cap.get("Channels", ("", ""))[0])

    print("  => %s%s" % ("PASS" if ok else "FAIL",
          "" if form_readable else "   (form checks skipped: Workfront unreachable)"))
    PASS, FAIL = (PASS + 1, FAIL) if ok else (PASS, FAIL + 1)

print()
print("  %d passed, %d failed" % (PASS, FAIL))
print()
print("  This covers READING the brief. It does NOT cover writing to the Workfront")
print("  form: that needs the Workfront MCP signed in, and every willWrite is {}")
print("  until it is. Sign in, re-run, and the form assertions come alive.")
PY
