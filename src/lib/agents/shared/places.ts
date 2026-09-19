/**
 * Places a brief can name, and the coarser names they also answer to.
 *
 * THE BUG THIS EXISTS TO FIX.
 *
 * Region was only ever captured by `findState`, so naming a US state worked and
 * naming the country did not. Tested four ways against the live tenant:
 *
 *     "Region: us"        -> not written, asked "Region: which of these - uk, de, us?"
 *     "Region: US"        -> not written, asked the same
 *     "the United States" -> not written, asked the same
 *     "in Pennsylvania"   -> DE:Region = "us", asked nothing
 *
 * So the system asked the marketer to pick `us` from a list containing `us`,
 * on a brief that said `us`. Exactly inverted from how anyone briefs: people
 * write "US rollout", not "Pennsylvania", when they mean the country.
 *
 * The widening table also had entries for the UK, Germany, France, Canada,
 * India and Australia - and none for the United States, on a project for a US
 * cable company.
 *
 * WHY IT LIVES IN ONE FILE.
 *
 * Two places need to agree about what counts as a place: the parser, which
 * decides whether the brief named one, and the field mapper, which decides what
 * the form can be told. When they disagreed, the parser captured nothing and
 * the mapper was never given the chance to map it. Sharing the table is what
 * stops that recurring - the same reason the state list is already shared
 * between the intake and audience agents.
 */

import { findState } from "@/lib/agents/shared/us-states";

/** A place, and the coarser names it also answers to - narrowest first. */
export type NamedPlace = {
  /** The place as this module understands it, for the record. */
  name: string;
  /** Coarser names to try against a field's allowed values, narrowest first. */
  wider: string[];
  /** Words for the note: "<raw> <because>, so this is filed under ...". */
  because: string;
  /** What a coarser value loses, for the note. */
  missing: string;
};

/*
 * BARE TWO-LETTER CODES ARE NOT IN THE PATTERNS.
 *
 * The previous table matched /\b(in|india|...)\b/ and /\b(ca|canada|...)\b/.
 * "in" is the commonest preposition in English, so any brief reaching that
 * branch matched India; "CA" is California far more often than Canada on a US
 * account. Only findState running first kept it from firing.
 *
 * An exact match against the field's own allowed values happens BEFORE any
 * widening, so a tenant that really does offer "in" or "ca" still matches it
 * directly. Nothing is lost by refusing to guess here.
 */
const COUNTRIES: Array<{ test: RegExp; place: NamedPlace }> = [
  {
    test: /\b(u\.?s\.?a\.?|u\.?s\.?|united states(?: of america)?|america|stateside)\b/i,
    place: {
      name: "United States",
      wider: ["us", "usa", "united states", "united states of america", "north america", "namer"],
      because: "is the United States",
      missing: "state-level",
    },
  },
  {
    test: /\b(u\.?k\.?|united kingdom|great britain|england|scotland|wales|northern ireland|london|manchester|birmingham|glasgow|leeds)\b/i,
    place: {
      name: "United Kingdom",
      wider: ["uk", "gb", "united kingdom", "great britain", "europe", "emea"],
      because: "is in the United Kingdom",
      missing: "city-level",
    },
  },
  {
    test: /\b(germany|deutschland|berlin|munich|m[uü]nchen|hamburg|frankfurt|cologne|k[oö]ln)\b/i,
    place: {
      name: "Germany",
      wider: ["de", "germany", "deutschland", "europe", "emea"],
      because: "is in Germany",
      missing: "city-level",
    },
  },
  {
    test: /\b(france|paris|lyon|marseille)\b/i,
    place: {
      name: "France",
      wider: ["fr", "france", "europe", "emea"],
      because: "is in France",
      missing: "city-level",
    },
  },
  {
    test: /\b(canada|toronto|vancouver|montreal|ontario|quebec)\b/i,
    place: {
      name: "Canada",
      wider: ["ca", "canada", "north america", "namer"],
      because: "is in Canada",
      missing: "city-level",
    },
  },
  {
    test: /\b(india|mumbai|delhi|bengaluru|bangalore|chennai|hyderabad)\b/i,
    place: {
      name: "India",
      wider: ["in", "india", "apac", "asia"],
      because: "is in India",
      missing: "city-level",
    },
  },
  {
    test: /\b(australia|sydney|melbourne|brisbane|perth)\b/i,
    place: {
      name: "Australia",
      wider: ["au", "australia", "apac", "oceania"],
      because: "is in Australia",
      missing: "city-level",
    },
  },
];

/**
 * The place this text names, if it names one this module is sure about.
 *
 * A US state wins over a country, because it is the more precise answer and
 * widening can always climb afterwards.
 *
 * "Nationwide" and "national" are deliberately NOT places. They say the whole
 * of a country without saying which country, and a project that runs for one
 * client today runs for another next year. Guessing the country from the
 * account is how a German campaign gets filed under "us" without anyone being
 * told. Better to ask - and the asking is now phrased like a question rather
 * than a list of enum values.
 */
export function findNamedPlace(text: string): NamedPlace | null {
  const state = findState(text);
  if (state) {
    return {
      name: state.name,
      wider: [
        state.name,
        state.code,
        "us",
        "usa",
        "united states",
        "united states of america",
        "north america",
        "namer",
      ],
      because: "is a US state",
      missing: "state-level",
    };
  }

  for (const c of COUNTRIES) {
    if (c.test.test(text)) return c.place;
  }
  return null;
}

/**
 * The same place, described more broadly each time, narrowest first.
 *
 * A field that can hold the exact place gets it; only a field that cannot is
 * offered something coarser, and the caller says in its note which step
 * matched. A state filed under its country is a fact worth stating; a state
 * filed under the wrong continent is a bug worth seeing.
 */
export function widerPlaces(raw: string): Array<{ as: string; level: string; because: string; missing: string }> {
  const out = [{ as: raw, level: "as written", because: "", missing: "" }];
  const place = findNamedPlace(raw);
  if (!place) return out;

  for (const w of place.wider) {
    out.push({
      as: w,
      level: w === place.name ? "as named" : "wider",
      because: place.because,
      missing: place.missing,
    });
  }
  return out;
}
