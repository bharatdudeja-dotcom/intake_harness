import { NextResponse } from "next/server";
import { getCapabilities } from "@/lib/capabilities";
import { apiError } from "@/lib/api-error";

/**
 * GET: the environment capability report - whether Workfront writes are
 * enabled. This is the out-of-this-app's-control fact that decides whether
 * the pipeline can actually finish (a real Workfront create) or only
 * dry-run. First-class and queryable, so nobody has to infer it from a
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
