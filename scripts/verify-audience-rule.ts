/**
 * verify-audience-rule.ts — what rule does a stated audience definition become?
 *
 *     npx tsx scripts/verify-audience-rule.ts
 *
 * Pure function, no network, nothing created. It exercises
 * expressionFromBrief, which is the path taken whenever a CDP-literate
 * requester writes the rule themselves - the most reliable input this agent
 * ever gets, and therefore the one worth a check of its own.
 *
 * WHY THIS EXISTS
 *
 * The rule reached AEP as FOUR conditions:
 *
 *     Has Xfinity Internet = True
 *     AND Has Xfinity TV   = False
 *     AND Has Xfinity Internet = True
 *     AND Has Xfinity TV   = False
 *
 * The definition is scanned over every field value joined together, and the
 * sentence the requester wrote lives in more than one of them -
 * `audience_description` holds it, and the Workfront-facing "Audience to be
 * Targeted" is mapped from the same text. So each clause matched twice.
 *
 * It selected the right people, which is exactly why it needs a test: nothing
 * downstream would have complained. The damage is on screen, where a marketer
 * reviewing four conditions cannot tell a duplicate from a mistake.
 *
 * The last case is the one to keep. Collapsing duplicates by text alone would
 * leave two fields that DISAGREE standing as `TV = false and TV = true` - a
 * rule matching nobody, wearing a count of zero, reported as an answer.
 */
import { expressionFromBrief } from "@/lib/agents/audience/attributes";

/** What the sandbox returned: the two Xfinity holding flags, by real path. */
const check = {
  satisfied: [
    {
      key: "product_holding",
      allFields: ["_taplondonptrsd.xfinityInternet", "_taplondonptrsd.xfinityTV"],
    },
  ],
} as never;

type Case = {
  name: string;
  fields: Record<string, string>;
  /** Expected condition count. 0 means: build nothing. */
  want: number;
  /** Substrings every built rule must contain. */
  contains?: string[];
};

const CASES: Case[] = [
  {
    name: "the real run - the same rule held in two fields",
    fields: {
      audience_description: "xfinityInternet = true AND xfinityTV = false",
      audience_to_be_targeted: "xfinityInternet = true AND xfinityTV = false",
      channels: "Email",
    },
    want: 2,
    contains: ["xfinityInternet = true", "xfinityTV = false"],
  },
  {
    name: "stated once only - unchanged by the fix",
    fields: { audience_description: "xfinityInternet = true AND xfinityTV = false" },
    want: 2,
    contains: ["xfinityInternet = true", "xfinityTV = false"],
  },
  {
    name: "three times, because nothing stops a third field carrying it",
    fields: {
      a: "xfinityInternet = true AND xfinityTV = false",
      b: "xfinityInternet = true AND xfinityTV = false",
      c: "xfinityInternet = true AND xfinityTV = false",
    },
    want: 2,
  },
  {
    name: "the inverse direction, stated twice - direction must survive",
    fields: {
      audience_description: "xfinityTV = true AND xfinityInternet = false",
      audience_to_be_targeted: "xfinityTV = true AND xfinityInternet = false",
    },
    want: 2,
    contains: ["xfinityTV = true", "xfinityInternet = false"],
  },
  {
    name: "the two fields DISAGREE - nothing may be built",
    fields: {
      audience_description: "xfinityInternet = true AND xfinityTV = false",
      audience_to_be_targeted: "xfinityInternet = true AND xfinityTV = true",
    },
    want: 0,
  },
  {
    name: "a field the sandbox does not have - nothing may be built",
    fields: { audience_description: "xfinityMobile = true AND xfinityTV = false" },
    want: 0,
  },
];

let passed = 0;
let failed = 0;

for (const c of CASES) {
  const e = expressionFromBrief(check, c.fields);
  const conditions = e ? e.pql.split(" and ").length : 0;
  const problems: string[] = [];

  if (conditions !== c.want) {
    problems.push(`expected ${c.want} condition(s), got ${conditions}`);
  }
  for (const needle of c.contains ?? []) {
    if (!e || !e.pql.includes(needle)) problems.push(`missing "${needle}"`);
  }
  // A duplicate is the bug this file is named after, so check it directly
  // rather than trusting the count alone.
  if (e) {
    const parts = e.pql.split(" and ").map((p) => p.trim());
    if (new Set(parts).size !== parts.length) problems.push("a condition appears more than once");
  }

  console.log("  " + c.name);
  console.log("      " + (e ? e.pql : "(nothing built)"));
  if (problems.length) {
    failed++;
    for (const p of problems) console.log("      FAIL: " + p);
  } else {
    passed++;
    console.log("      => PASS");
  }
  console.log("");
}

console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
