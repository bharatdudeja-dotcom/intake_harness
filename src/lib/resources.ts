import { query } from "@/lib/db";
import type { ResourceRow, ResourceType } from "@/lib/resources-types";

export * from "@/lib/resources-types";

export async function listResources(filter: { type?: ResourceType } = {}): Promise<ResourceRow[]> {
  if (filter.type) {
    return query<ResourceRow>(`SELECT * FROM resources WHERE type = $1 ORDER BY created_at DESC`, [filter.type]);
  }
  return query<ResourceRow>(`SELECT * FROM resources ORDER BY created_at DESC`);
}

export async function getResource(resourceId: string): Promise<ResourceRow | null> {
  const [row] = await query<ResourceRow>(`SELECT * FROM resources WHERE resource_id = $1`, [resourceId]);
  return row ?? null;
}

export async function createResource(input: {
  type: ResourceType;
  title: string;
  content: string;
  format?: string | null;
  tags?: string[];
  owner?: string | null;
  programmeId?: string | null;
}): Promise<ResourceRow> {
  const [row] = await query<ResourceRow>(
    `INSERT INTO resources (type, title, content, format, tags, owner, programme_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      input.type,
      input.title,
      input.content,
      input.format ?? null,
      input.tags ?? [],
      input.owner ?? null,
      input.programmeId ?? null,
    ],
  );
  return row;
}
