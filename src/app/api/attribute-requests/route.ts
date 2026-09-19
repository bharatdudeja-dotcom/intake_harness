import { NextResponse } from "next/server";
import { listOpenRequests } from "@/lib/agents/audience/attribute-requests";
import { apiError } from "@/lib/api-error";

/**
 * GET: every currently-open GTO / attribute request across all runs, oldest
 * first, each with its wall-clock ageSeconds. This is B7's "what's been
 * waiting, and for how long" view - an open request that would otherwise sit
 * unowned as a hidden quarter-long tail is now queryable with a real age.
 */
export async function GET() {
  try {
    const requests = await listOpenRequests();
    return NextResponse.json({ requests });
  } catch (err) {
    return apiError((err as Error).message, "INTERNAL_ERROR", 500);
  }
}
