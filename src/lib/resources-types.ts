/**
 * Pure types/constants for resources — no `@/lib/db` import here on
 * purpose. resources.ts (the DB-touching module) imports @/lib/db, which
 * pulls in `pg`; a client component importing anything from that module,
 * even just a type, drags the whole module graph into the browser bundle
 * and fails to resolve pg's Node built-ins. Client components (like
 * resources-browser.tsx) must import from THIS file, never from
 * resources.ts — same split as pipeline/types.ts vs pipeline/orchestrator.ts.
 */

export const RESOURCE_TYPES = [
  "playbook",
  "decision",
  "architecture-doc",
  "architecture-diagram",
  "meeting-notes",
  "code-snippet",
  "configuration",
  "handoff-prompt",
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
  playbook: "Playbook",
  decision: "Decision",
  "architecture-doc": "Architecture Doc",
  "architecture-diagram": "Architecture Diagram",
  "meeting-notes": "Meeting Notes",
  "code-snippet": "Code Snippet",
  configuration: "Configuration",
  "handoff-prompt": "Handoff Prompt",
};

export interface ResourceRow {
  resource_id: string;
  type: ResourceType;
  title: string;
  content: string;
  format: string | null;
  tags: string[];
  owner: string | null;
  programme_id: string | null;
  approved: boolean;
  approved_by: string | null;
  approved_at: string | null;
  approval_note: string | null;
  promoted: boolean;
  promoted_by: string | null;
  promoted_at: string | null;
  created_at: string;
  updated_at: string;
}
