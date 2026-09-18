/** The shape of a step's tool-call fields, loosely — every field here is optional because each agent's shape differs. */
export type ToolCallOutput = {
  grounding?: { grounded: boolean; reason: string | null; hits?: unknown };
  workfront?: { created?: boolean } & Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * The schema/field-group probe's shape in a task_run's `metadata` — reported
 * with the same field names by both Review and Audience Creation (see
 * aep.ts's SchemaProbe and each route's `metadata` block) so this one
 * component can render either.
 */
export type SchemaProbeMetadata = {
  schemasRead?: boolean;
  schemaProbeConclusive?: boolean;
  schemasReadError?: string | null;
  schemaCount?: number;
  schemasInspected?: number;
  fieldGroupsInspected?: number;
  fieldCount?: number;
  sandbox?: string | null;
  attributesNeeded?: string[];
  attributesMissing?: string[];
  [key: string]: unknown;
};

/**
 * The tool calls one agent step made, terminal-style: the call (→) and its
 * outcome (←) on their own lines, so a scan tells call from result without
 * reading prose or opening the raw JSON dump. Shared between the live chat
 * trace (pipeline-chat.tsx, a run in progress) and the Runs page
 * (runs-browser.tsx, browsing history) so the same step reads the same way
 * whether you're watching it happen or looking at it afterward.
 */
export function ToolCallTrace({ output, metadata }: { output: ToolCallOutput; metadata?: SchemaProbeMetadata }) {
  const conclusive = metadata?.schemaProbeConclusive;
  const schemasInspected = metadata?.schemasInspected ?? 0;
  const fieldGroupsInspected = metadata?.fieldGroupsInspected ?? 0;

  return (
    <>
      {output.grounding && (
        <div className="rounded-lg bg-zinc-900 p-2 font-mono text-xs">
          <div className="text-blue-300">→ search_adobe_knowledge</div>
          <div className={output.grounding.grounded ? "text-green-400" : "text-amber-400"}>
            ← {output.grounding.grounded ? "grounded" : `ungrounded — ${output.grounding.reason}`}
          </div>
        </div>
      )}
      {output.workfront && (
        <div className="rounded-lg bg-zinc-900 p-2 font-mono text-xs">
          <div className="text-blue-300">→ create_workfront_intake</div>
          <div className={output.workfront.created ? "text-green-400" : "text-amber-400"}>
            ← {output.workfront.created ? "created" : "dry run — not created"}
          </div>
        </div>
      )}

      {/*
       * The schema/field-group probe: whichever build-path or attribute
       * decision follows depends ENTIRELY on this read, so it gets its own
       * caption and a visibly different treatment when inconclusive — a
       * bordered amber block, not just another dark terminal line — rather
       * than reading as routine as the grounding/workfront calls above.
       */}
      {typeof conclusive === "boolean" && (
        <div className="flex flex-col gap-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
            Schema field check — Agent 3&apos;s build path depends on this
          </p>
          <div
            className={`rounded-lg p-2 font-mono text-xs ${
              conclusive ? "bg-zinc-900" : "border-2 border-amber-500 bg-amber-950"
            }`}
          >
            <div className="text-blue-300">
              → adobe_list_schemas → adobe_get_schema ×{schemasInspected}
              {fieldGroupsInspected > 0 ? ` → adobe_get_field_group ×${fieldGroupsInspected}` : ""}
            </div>
            {conclusive ? (
              <div className="text-green-400">
                ← {metadata?.fieldCount ?? 0} field(s) found across {schemasInspected} schema(s)
                {fieldGroupsInspected > 0 ? ` + ${fieldGroupsInspected} field group(s)` : ""}
                {metadata?.sandbox ? ` in sandbox "${metadata.sandbox}"` : ""}.
                {metadata?.attributesNeeded?.length ? ` Needed: ${metadata.attributesNeeded.join(", ")}.` : ""}
                {metadata?.attributesMissing?.length
                  ? ` Missing: ${metadata.attributesMissing.join(", ")}.`
                  : " All present."}
              </div>
            ) : (
              <div className="font-bold text-amber-300">
                ← BLOCKER — could not determine field availability: {metadata?.schemasReadError}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
