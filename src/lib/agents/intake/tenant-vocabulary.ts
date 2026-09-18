import { callMcpTool } from "@/lib/mcp-client";
import type { TaskId } from "@/lib/pipeline/types";

/**
 * The tenant's own vocabulary, and how a marketer's words map onto it.
 *
 * WHY THIS EXISTS
 *
 * Read off the live tenant (taplondonptrsd, 19 Sep 2026), the request and
 * project forms are mostly ENUMERATIONS with closed value lists:
 *
 *   Region            uk | de | us
 *   Primary Channel   paid_media | email | web
 *   Audience          existing_customer | new_customer | high_value_customer
 *   Audience to be Targeted   Prospects | Customers
 *   Type              New | Revision / Edit to existing
 *
 * We were writing prose into them - "New York" into Region, "Email" into
 * Primary Channel, "Subscriber - Existing Customers" into Audience - and
 * Workfront dropped every one. Previous investigations found the wrong NAME
 * (label versus parameter name) and fixed that; this is the layer underneath:
 * the right field, the wrong VALUE.
 *
 * Adobe's own guidance is explicit about the shape of this mistake, for
 * statuses: "NEVER use the display name as the condition value... The query
 * service only accepts status codes." The same is true of every enumeration on
 * a custom form.
 *
 * WHAT IT REFUSES TO DO
 *
 * It does not guess. A value that cannot be mapped with confidence is returned
 * as unmapped, with the allowed values named, so the run can say "Region only
 * accepts uk, de or us on this form, and the brief says New York" - which is a
 * fact a marketer or an administrator can act on. Writing `us` because New York
 * is in America is a judgement about the client's data model, not a
 * translation, and it belongs to them.
 */

export type FormField = {
  /** What Workfront is addressed by: `DE:Name of the Campaign`, or `status`. */
  name: string;
  label: string;
  dataType: string;
  /** Closed list, when the field is an enumeration. */
  allowed: string[];
};

export type MappedValue =
  | { ok: true; field: FormField; value: string; note: string | null }
  | { ok: false; field: FormField; given: string; why: string };

const norm = (s: unknown) =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Concepts a marketer writes, and the tenant values they mean.
 *
 * Deliberately narrow. Each entry is a phrase whose meaning is not in doubt
 * for THIS tenant's value list - "email only" means the email channel - and
 * nothing here decides a question that is really the client's, like whether a
 * US state belongs under a `us` region or needs a state-level field adding.
 */
const SYNONYMS: Record<string, string[]> = {
  // Primary Channel
  email: ["email", "e mail", "eml", "email only", "email campaign"],
  paid_media: ["paid media", "paid", "display", "programmatic", "social", "paid social", "ooh"],
  web: ["web", "website", "site", "onsite", "on site", "web only"],

  // Audience (who they are to the business)
  /*
   * No bare "customer"/"customers" here. On a list whose other value is
   * new_customer, that word distinguishes nothing - and it is contained in
   * "Prospect - Non-Customers", which is how this matcher first read a
   * prospects audience as existing customers.
   */
  existing_customer: [
    "existing customer", "existing customers", "existing subscriber", "existing subscribers",
    "subscriber existing customers", "current customer", "current customers",
    "existing residential subscribers", "existing base", "already a customer",
  ],
  new_customer: ["new customer", "new customers", "prospect", "prospects", "non customer", "non customers", "acquisition"],
  high_value_customer: ["high value", "high value customer", "high value customers", "premium", "vip"],

  // Audience to be Targeted (the other form's coarser pair)
  Customers: ["existing customer", "existing customers", "existing subscribers", "subscriber existing customers", "current customers"],
  Prospects: ["prospect", "prospects", "non customer", "non customers", "new customer", "new customers", "acquisition"],

  // Type
  New: ["new", "new request", "first time"],
  "Revision / Edit  to existing": ["revision", "edit", "amend", "change to existing", "update existing"],
};

/** Every field the form exposes for this entity, with its allowed values. */
export async function readFormFields(taskId: TaskId, entity: "issue" | "project"): Promise<FormField[]> {
  /*
   * insights_search_fields only returns fields matching its query, so one
   * question sees a fraction of the form. These queries were chosen against
   * the live tenant to cover the marketing fields; they run in parallel
   * because they are independent.
   */
  const queries = [
    "campaign", "audience", "objective", "launch", "channel", "region",
    "product", "type", "status", "priority", "name", "date",
  ];

  const chunks = await Promise.all(
    queries.map((query) =>
      callMcpTool<unknown>(taskId, "insights_search_fields", { entity_ids: [entity], query })
        .catch(() => null),
    ),
  );

  const byName = new Map<string, FormField>();
  for (const chunk of chunks) {
    if (!chunk) continue;
    const text = typeof chunk === "string" ? chunk : JSON.stringify(chunk);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    for (const raw of Array.isArray(parsed) ? parsed : []) {
      const f = raw as {
        id?: string; name?: string; label?: string; dataType?: string;
        possibleValues?: { name?: string }[] | null;
      };
      // `name` is what Workfront is addressed by; `id` is the query path. A
      // field with neither cannot be written, so it is not a candidate.
      const name = f.name || null;
      if (!name || !f.label) continue;
      if (byName.has(name)) continue;
      byName.set(name, {
        name,
        label: String(f.label),
        dataType: String(f.dataType || "string"),
        allowed: (f.possibleValues || []).map((v) => String(v?.name ?? "")).filter(Boolean),
      });
    }
  }
  return [...byName.values()];
}

/**
 * Map one value onto what the field will accept.
 *
 * Tiers, strongest first:
 *   1. it is already an allowed value (exact, or case/punctuation-insensitive)
 *   2. a synonym whose meaning is unambiguous for this value list
 *   3. the value appears inside an allowed value, or vice versa, and only one
 *      allowed value matches - "email" inside "email_only" would qualify
 *
 * A free-text field takes the value as written. Anything else is unmapped,
 * named, with the allowed values quoted so the run can explain itself.
 */
export function mapValue(field: FormField, given: unknown): MappedValue {
  const raw = String(given ?? "").trim();
  if (!raw) return { ok: false, field, given: raw, why: "no value was given" };

  if (!field.allowed.length) {
    return { ok: true, field, value: raw, note: null };
  }

  const exact = field.allowed.find((a) => a === raw);
  if (exact) return { ok: true, field, value: exact, note: null };

  const loose = field.allowed.find((a) => norm(a) === norm(raw));
  if (loose) {
    return { ok: true, field, value: loose, note: `matched "${raw}" to "${loose}"` };
  }

  /*
   * SCORE BY SPECIFICITY, and refuse a tie.
   *
   * Taking the first allowed value that matched read "Prospect - Non-Customers"
   * as existing_customer, because that value listed "customers" and the phrase
   * contains it. The longest matching phrase is the most specific one, and
   * "non customer" beats "customer" on exactly the case that matters.
   *
   * When two values score the same the brief is genuinely ambiguous against
   * this form, and a person should say which - not us.
   */
  const scored = field.allowed
    .map((allowed) => {
      const phrases = SYNONYMS[allowed] || [];
      const best = phrases
        .filter((p) => norm(raw).includes(norm(p)) || norm(p) === norm(raw))
        .reduce((longest, p) => (norm(p).length > longest ? norm(p).length : longest), 0);
      return { allowed, score: best };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 1 || (scored.length > 1 && scored[0].score > scored[1].score)) {
    return { ok: true, field, value: scored[0].allowed, note: `read "${raw}" as "${scored[0].allowed}"` };
  }
  if (scored.length > 1) {
    return {
      ok: false,
      field,
      given: raw,
      why:
        `"${raw}" reads equally as ${scored.slice(0, 3).map((x) => `"${x.allowed}"`).join(" or ")} ` +
        "on this form, and choosing between them changes who gets targeted",
    };
  }

  const contained = field.allowed.filter(
    (a) => norm(a).includes(norm(raw)) || norm(raw).includes(norm(a)),
  );
  if (contained.length === 1) {
    return { ok: true, field, value: contained[0], note: `matched "${raw}" to "${contained[0]}"` };
  }

  return {
    ok: false,
    field,
    given: raw,
    why:
      `"${raw}" is not one of the values this field accepts (${field.allowed.slice(0, 8).join(", ")}` +
      `${field.allowed.length > 8 ? ", …" : ""})`,
  };
}

/**
 * Find the form field that holds a concept, by label.
 *
 * Label rather than name, because a label is what a Workfront administrator
 * calls it and what a human would look for on the form. The name is what gets
 * written.
 */
export function fieldByLabel(fields: FormField[], ...labels: string[]): FormField | null {
  for (const label of labels) {
    const hit = fields.find((f) => norm(f.label) === norm(label));
    if (hit) return hit;
  }
  for (const label of labels) {
    const hit = fields.find((f) => norm(f.label).includes(norm(label)));
    if (hit) return hit;
  }
  return null;
}
