/** The shape of a step's tool-call fields, loosely — every field here is optional because each agent's shape differs. */
export type ToolCallOutput = {
  grounding?: { grounded: boolean; reason: string | null; hits?: unknown };
  workfront?: { created?: boolean } & Record<string, unknown>;
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
export function ToolCallTrace({ output }: { output: ToolCallOutput }) {
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
    </>
  );
}
