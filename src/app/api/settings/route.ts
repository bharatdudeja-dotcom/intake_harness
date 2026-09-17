import { NextRequest, NextResponse } from "next/server";
import {
  countPurgeable,
  getSettings,
  updateKindLabels,
  updatePromoteAdmins,
  updateRetentionDays,
  updateSegmentationLabel,
} from "@/lib/settings";
import { isAdmin, listAdmins } from "@/lib/admins";
import { RESOURCE_TYPES } from "@/lib/resources-types";

/** GET: current settings plus how many resources are purgeable right now. PATCH: change one section of settings. */
export async function GET() {
  try {
    const [settings, purgeableCount] = await Promise.all([getSettings(), countPurgeable()]);
    return NextResponse.json({ settings, purgeableCount });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * Each settings card on the page (Retention, Segmentation labels, Kind
 * labels, Hero Agents) PATCHes just its own field, so a body carries at
 * most one of retentionDays/segmentationLabel/kindLabels/promoteAdmins.
 */
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const adminName = typeof body?.adminName === "string" ? body.adminName.trim() : "";
  if (!adminName) {
    return NextResponse.json({ error: 'Body must include "adminName".' }, { status: 400 });
  }
  if (!isAdmin(adminName)) {
    return NextResponse.json({ error: `"${adminName}" is not in ADMIN_NAMES.` }, { status: 403 });
  }

  try {
    if (body?.retentionDays !== undefined) {
      const retentionDays = Number(body.retentionDays);
      if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
        return NextResponse.json({ error: '"retentionDays" must be a positive integer.' }, { status: 400 });
      }
      return NextResponse.json({ settings: await updateRetentionDays(retentionDays, adminName) });
    }

    if (body?.segmentationLabel !== undefined) {
      const label = typeof body.segmentationLabel === "string" ? body.segmentationLabel.trim() : "";
      if (!label) {
        return NextResponse.json({ error: '"segmentationLabel" must be a non-empty string.' }, { status: 400 });
      }
      return NextResponse.json({ settings: await updateSegmentationLabel(label, adminName) });
    }

    if (body?.kindLabels !== undefined) {
      if (typeof body.kindLabels !== "object" || body.kindLabels === null || Array.isArray(body.kindLabels)) {
        return NextResponse.json({ error: '"kindLabels" must be an object.' }, { status: 400 });
      }
      // Only known resource kinds, and only non-empty labels — an unrecognized
      // key or a blanked-out label would silently orphan itself in storage.
      const labels: Record<string, string> = {};
      for (const type of RESOURCE_TYPES) {
        const v = (body.kindLabels as Record<string, unknown>)[type];
        if (typeof v === "string" && v.trim()) labels[type] = v.trim();
      }
      return NextResponse.json({ settings: await updateKindLabels(labels, adminName) });
    }

    if (body?.promoteAdmins !== undefined) {
      if (!Array.isArray(body.promoteAdmins)) {
        return NextResponse.json({ error: '"promoteAdmins" must be an array.' }, { status: 400 });
      }
      // Only real admins can ever promote anyway (isAdmin is checked at the
      // promote routes too) — filtering here keeps the stored roster honest.
      const validAdmins = new Set(listAdmins());
      const names = body.promoteAdmins.filter((n: unknown) => typeof n === "string" && validAdmins.has(n));
      return NextResponse.json({ settings: await updatePromoteAdmins(names, adminName) });
    }

    return NextResponse.json(
      { error: "Body must include one of: retentionDays, segmentationLabel, kindLabels, promoteAdmins." },
      { status: 400 },
    );
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
