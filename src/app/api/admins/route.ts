import { NextResponse } from "next/server";
import { listAdmins } from "@/lib/admins";

/** GET: the configured admin allowlist, for the approve/promote picker. */
export async function GET() {
  return NextResponse.json({ admins: listAdmins() });
}
