import { NextResponse } from "next/server";
import { getCapabilities } from "@/lib/capabilities";
import { apiError } from "@/lib/api-error";

/**
 * GET: the environment capability report - whether Workfront writes are
 * enabled and whether the segment-estimate tools are reachable. These are
 * the two out-of-this-app's-control facts that decide whether the pipeline
 * can actually finish (a real Workfront create) or only dry-run and skip
 * the count. First-class and queryable, so nobody has to infer them from a
 * single run's `created: false`.
 */
export async function GET() {
  try {
    const capabilities = await getCapabilities();
    return NextResponse.json(capabilities);
  } catch (err) {
    return apiError((err as Error).message, "INTERNAL_ERROR", 500);
  }
}
