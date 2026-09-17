/**
 * Phase 2 of the map, which begins the moment 1.5 says Approved.
 *
 *   2.1  Issue converted to project form
 *   2.2  Agent reads and gathers info, then checks the audience catalog
 *   2.3  Audience exists?   Yes -> 2.4 activate, 2.5 validate with the marketer
 *                            No -> 2.6 gather data requirements -> 2.7 -> B
 *
 * WHY 2.1 IS THE MOST IMPORTANT STEP IN THIS FILE
 *
 * A run through the live tenant reported that 1 of 15 brief fields reached
 * Workfront. That was read as a mapping bug and it is not one. The issue entity
 * in this tenant has four custom fields and none of them is a brief field:
 *
 *   issue    DE:MIG_First Name, DE:MIG_Last Name, DE:MIG_Name, DE:Product Name_CP
 *   project  DE:Name of the Campaign, DE:Objective of the campaign,
 *            DE:Audience_to_be_Targeted, DE:Requested_Launch_Date
 *
 * Agent 1 was writing a campaign brief to an object type that has nowhere to
 * put one. The brief's fields are project fields - which is precisely why the
 * map converts the issue to a project at 2.1 before anything reads the brief.
 * So those fields were never lost, they were early, and this is where they land.
 *
 * WHAT "CONVERTED" HONESTLY MEANS HERE
 *
 * Workfront's own API has a convertToProject action. Adobe's official MCP does
 * not expose it - there is no convert tool in the 97 this tenant serves, and no
 * raw REST escape hatch (that is one of the things we knowingly gave up by going
 * official). So this creates a project carrying the brief and links it back to
 * the issue. The result is the same two records with the same relationship; it
 * is not Workfront's native convert, and `conversion.method` says so rather than
 * letting a reader assume otherwise.
 */

import { callMcpTool } from "@/lib/mcp-client";
import { workfrontToolset } from "@/lib/workfront-tools";
import { resolveFieldMap, applyFieldMap } from "@/lib/agents/intake/workfront-fields";
import { writeCustomFields, describeFieldWrite } from "@/lib/agents/shared/workfront-write";
import { findExistingSegment, requiredAttributes } from "@/lib/agents/audience/aep";

/**
 * The project custom form the brief is written onto.
 *
 * Resolved BY NAME at run time, never as a stored GUID - the same reasoning as
 * the intake queue. A hardcoded id is right until somebody rebuilds the form,
 * and then it is silently wrong: it points at a form that still exists and is
 * no longer the one in use.
 *
 * "Campaign Brief" is the tenant's own name for it and it owns
 * DE:Name of the Campaign. Three of the brief's other fields live on a DIFFERENT
 * project form, so some values will be refused here - that is reported per
 * field, by name, because it is a form configuration gap a Workfront admin can
 * close, not a failure of this run.
 */
export const PROJECT_FORM_NAME = process.env.WORKFRONT_PROJECT_FORM || "Campaign Brief";

export type ConversionOutcome =
  | {
      converted: true;
      objCode: "PROJ";
      objId: string;
      /** Not Workfront's native convertToProject. See the file header. */
      method: "created_project_and_linked";
      formId: string;
      formName: string;
      fieldsWritten: string[];
      fieldsRefused: Array<{ field: string; reason: string }>;
      fieldNote: string | null;
      fieldNamesVerified: boolean;
      fieldNamesSource: string;
      /**
       * Values changed to fit the field's type, and how.
       *
       * A launch date of "1 November" becomes "2026-11-01", and the year is
       * INFERRED. That inference is the difference between six weeks and
       * eighteen months, so it is reported rather than applied quietly.
       */
      valuesCoerced: Array<{ field: string; from: string; to: string; note: string }>;
      /** Values the field's type could not accept. Not sent, and said out loud. */
      valuesUncoercible: Array<{ field: string; value: string; reason: string }>;
      linkedBack: { ok: boolean; how: string; error: string | null };
    }
  | {
      converted: false;
      reason: string;
      wouldHaveCreated: { objCode: "PROJ"; formId: string | null; fields: Record<string, unknown>; customFields: Record<string, unknown> };
    };

/** Resolve the project form's id, or say why not. */
async function resolveProjectForm(): Promise<{ id: string | null; name: string; reason: string | null }> {
  if (process.env.WORKFRONT_PROJECT_FORM_ID) {
    return { id: process.env.WORKFRONT_PROJECT_FORM_ID, name: "(from WORKFRONT_PROJECT_FORM_ID)", reason: null };
  }
  try {
    const found = await callMcpTool<unknown>("review", "insights_find_id_by_name", {
      entity: "category",
      name: PROJECT_FORM_NAME,
    });
    const text = typeof found === "string" ? found : JSON.stringify(found);
    const id = text.match(/\b[0-9a-f]{32}\b/i)?.[0] || null;
    return id
      ? { id, name: PROJECT_FORM_NAME, reason: null }
      : { id: null, name: PROJECT_FORM_NAME, reason: `could not find a custom form called "${PROJECT_FORM_NAME}"` };
  } catch (err) {
    return { id: null, name: PROJECT_FORM_NAME, reason: (err as Error).message };
  }
}

/**
 * Link the new project back to the issue it came from.
 *
 * Two attempts, in order of how much they prove:
 *
 * 1. `convertedOpTaskID` on the project. This is the field Workfront's own
 *    convert action sets, so setting it makes the pair look to Workfront the way
 *    a real conversion would.
 * 2. A comment on the issue naming the project. Weaker - it is prose, not a
 *    relation - but a reviewer opening the issue can still follow it.
 *
 * Whichever happened is reported. An unlinked project is a loose record nobody
 * will find from the request, so "neither worked" has to be visible.
 */
async function linkBack(projectId: string, issueId: string, projectName: string): Promise<{ ok: boolean; how: string; error: string | null }> {
  const set = workfrontToolset();

  try {
    await callMcpTool("review", set.update, set.customFieldArgs("PROJ", projectId, { convertedOpTaskID: issueId }, "Link this project to the intake request it was converted from."));
    return { ok: true, how: "convertedOpTaskID on the project, the same field Workfront's own convert action sets", error: null };
  } catch (err) {
    const relationError = (err as Error).message;

    try {
      await callMcpTool("review", set.createComment, {
        objID: issueId,
        objCode: "OPTASK",
        message:
          `Converted to project "${projectName}" (PROJ ${projectId}) at step 2.1. ` +
          "The campaign brief's fields live on the project form, not the issue form, so the brief is recorded there.",
      });
      return {
        ok: true,
        how: "a comment on the issue naming the project - the convertedOpTaskID relation was refused, so this is prose rather than a relation",
        error: relationError,
      };
    } catch (commentErr) {
      return {
        ok: false,
        how: "neither the convertedOpTaskID relation nor a comment could be written",
        error: `${relationError}; comment also failed: ${(commentErr as Error).message}`,
      };
    }
  }
}

/**
 * 2.1 - convert the issue to a project carrying the brief.
 *
 * @param issueId the OPTASK Agent 1 created, when it managed to create one
 * @param intakeFields the brief, as extracted
 * @param brief the marketer's own words, sent as Workfront's `intent`
 */
export async function convertIssueToProject(args: {
  issueId: string | null;
  intakeFields: Record<string, string>;
  brief: string;
}): Promise<ConversionOutcome> {
  const form = await resolveProjectForm();

  const campaignName = String(args.intakeFields.campaign_name || "").trim();
  const fields: Record<string, unknown> = {
    // The project's native name. NOT prefixed with "Campaign name:" - a run
    // once wrote that literal string into the title as a workaround for the
    // name not being picked up at all, and it had to be renamed by hand.
    name: campaignName || "Campaign (unnamed)",
    description: args.brief,
  };
  if (form.id) fields.categoryID = form.id;

  if (!form.id) {
    return {
      converted: false,
      reason:
        `Cannot convert to a project: ${form.reason}. The brief's fields live on a project custom ` +
        "form, so without the form the project would be created with a title and nothing else. " +
        "Set WORKFRONT_PROJECT_FORM to the form's name, or WORKFRONT_PROJECT_FORM_ID to its id.",
      wouldHaveCreated: { objCode: "PROJ", formId: null, fields, customFields: {} },
    };
  }

  // Field names from the PROJECT entity. Reading them off the issue is what
  // found nothing: they are not there.
  const fieldMap = await resolveFieldMap(form.id, "project", "review");
  const { customFields, coerced, uncoercible } = applyFieldMap(args.intakeFields, fieldMap);

  const set = workfrontToolset();
  let created: { ID?: string; id?: string } | null = null;
  try {
    const result = await callMcpTool<{ data?: { ID?: string }; ID?: string }>(
      "review",
      set.create,
      set.createArgs("PROJ", fields, args.brief),
    );
    created = (result && (result as { data?: { ID?: string } }).data) || (result as { ID?: string });
  } catch (err) {
    const raw = (err as Error).message;
    const isMissingWriteTool = /not found/i.test(raw) && /workflow_(create|update)/i.test(raw);
    return {
      converted: false,
      reason: isMissingWriteTool
        ? `${raw} - this tool is absent because WRITE ACTIONS ARE NOT ENABLED on the Workfront tenant. ` +
          "A Workfront admin turns them on in Setup > System > Preferences. Everything up to the write " +
          "worked: the payload below is what would have been created."
        : raw,
      wouldHaveCreated: { objCode: "PROJ", formId: form.id, fields, customFields },
    };
  }

  const objId = String(created?.ID || created?.id || "");
  if (!objId) {
    return {
      converted: false,
      reason: "Workfront accepted the project create but returned no object id",
      wouldHaveCreated: { objCode: "PROJ", formId: form.id, fields, customFields },
    };
  }

  const write = Object.keys(customFields).length
    ? await writeCustomFields("review", "PROJ", objId, customFields, args.brief)
    : { written: [], rejected: [] };

  const linked = args.issueId
    ? await linkBack(objId, args.issueId, String(fields.name))
    : { ok: false, how: "there was no issue to link to - Agent 1 did not create one", error: null };

  return {
    converted: true,
    objCode: "PROJ",
    objId,
    method: "created_project_and_linked",
    formId: form.id,
    formName: form.name,
    fieldsWritten: write.written,
    fieldsRefused: write.rejected,
    fieldNote: describeFieldWrite(write, "PROJ"),
    fieldNamesVerified: fieldMap.verified,
    fieldNamesSource: fieldMap.source,
    valuesCoerced: coerced,
    valuesUncoercible: uncoercible,
    linkedBack: linked,
  };
}

export type CatalogCheck = {
  /** 2.3's answer. Null when we could not read the catalog at all. */
  audienceExists: boolean | null;
  existingAudience: { id: string | null; name: string | null };
  /** How many audiences were considered, so a "no" can be weighed. */
  considered: number;
  /** Why there is no answer, when there is none. */
  error: string | null;
  /** 2.6 - what an audience of this shape needs, if one has to be built. */
  dataRequirements: string[];
  /** One line for the artifact. */
  note: string;
};

/**
 * 2.2 and 2.3 - read the audience catalog and answer whether one already exists.
 *
 * A "no" that is really "I could not look" is the failure this whole pipeline
 * keeps producing, so `audienceExists` is a TRI-STATE. Null means the catalog
 * could not be read, and null does not open the gate to Agent 3: building an
 * audience because we failed to check for an existing one is how duplicates get
 * made, and 2.3's Yes branch (reuse, activate, validate) is the cheapest good
 * outcome in the entire map.
 */
export async function checkAudienceCatalog(fields: Record<string, string>): Promise<CatalogCheck> {
  const terms = [fields.campaign_name, fields.lifecycle_journey, fields.line_of_business, fields.customer_type]
    .filter(Boolean)
    .map(String);

  const found = await findExistingSegment(terms, "review");

  // 2.6: the attributes an audience of this shape needs to exist.
  const dataRequirements = requiredAttributes(fields);

  if (!found.read) {
    return {
      audienceExists: null,
      existingAudience: { id: null, name: null },
      considered: 0,
      error: found.error,
      dataRequirements,
      note:
        `The audience catalogue could not be read (${found.error}), so whether one already exists ` +
        "is unknown. Reported as unknown rather than as \"none found\", because building an audience " +
        "on the strength of a failed lookup is how a duplicate gets created.",
    };
  }

  if (found.id) {
    return {
      audienceExists: true,
      existingAudience: { id: found.id, name: found.name },
      considered: found.considered,
      error: null,
      dataRequirements,
      note:
        `An audience already covers this request: "${found.name}" (${found.considered} checked). ` +
        "Nothing needs building - it just needs confirming before activation. Reuse is the best " +
        "outcome here, not a gap.",
    };
  }

  return {
    audienceExists: false,
    existingAudience: { id: null, name: null },
    considered: found.considered,
    error: null,
    dataRequirements,
    note:
      `No existing audience matched (${found.considered} checked), so a new one is needed. ` +
      `It will be built from ${dataRequirements.join(", ")}, once those attributes are confirmed ` +
      "to exist in Adobe Experience Platform.",
  };
}
