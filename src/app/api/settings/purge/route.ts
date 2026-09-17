import { NextRequest, NextResponse } from "next/server";
import { purgeExpiredResources } from "@/lib/settings";
import { isAdmin } from "@/lib/admins";

/**
 * POST: deletes every unapproved resource older than the configured
 * retention window. Admin-gated and manual — this app has no scheduler to
 * run it automatically (Agent Manager's equivalent, /internal/purge, was
 * driven by Cloud Scheduler; wire this the same way from outside if that's
 * wanted later).
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const adminName = typeof body?.adminName === "string" ? body.adminName.trim() : "";
  if (!adminName) {
    return NextResponse.json({ error: 'Body must include "adminName".' }, { status: 400 });
  }
  if (!isAdmin(adminName)) {
    return NextResponse.json({ error: `"${adminName}" is not in ADMIN_NAMES.` }, { status: 403 });
  }

  try {
    const result = await purgeExpiredResources();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
