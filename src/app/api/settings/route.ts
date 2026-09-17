import { NextRequest, NextResponse } from "next/server";
import { countPurgeable, getSettings, updateRetentionDays } from "@/lib/settings";
import { isAdmin } from "@/lib/admins";

/** GET: current settings plus how many resources are purgeable right now. PATCH: change the retention window. */
export async function GET() {
  try {
    const [settings, purgeableCount] = await Promise.all([getSettings(), countPurgeable()]);
    return NextResponse.json({ settings, purgeableCount });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const adminName = typeof body?.adminName === "string" ? body.adminName.trim() : "";
  if (!adminName) {
    return NextResponse.json({ error: 'Body must include "adminName".' }, { status: 400 });
  }
  if (!isAdmin(adminName)) {
    return NextResponse.json({ error: `"${adminName}" is not in ADMIN_NAMES.` }, { status: 403 });
  }
  const retentionDays = Number(body?.retentionDays);
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    return NextResponse.json({ error: '"retentionDays" must be a positive integer.' }, { status: 400 });
  }

  try {
    const settings = await updateRetentionDays(retentionDays, adminName);
    return NextResponse.json({ settings });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
