"use client";

import { useEffect, useState } from "react";
import type { SettingsRow } from "@/lib/settings";

/**
 * The editable half of Settings: the retention window for unapproved
 * Resources, and a manual purge. Ported from Agent Manager's settings
 * override (D48) — see db/schema.sql and src/lib/settings.ts for why
 * `runs` are exempt from this entirely.
 */
export function RetentionSettings({
  initialSettings,
  initialPurgeableCount,
}: {
  initialSettings: SettingsRow;
  initialPurgeableCount: number;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [purgeableCount, setPurgeableCount] = useState(initialPurgeableCount);
  const [retentionDays, setRetentionDays] = useState(String(initialSettings.retention_days));
  const [admins, setAdmins] = useState<string[]>([]);
  const [selectedAdmin, setSelectedAdmin] = useState("");
  const [saving, setSaving] = useState(false);
  const [purging, setPurging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admins")
      .then((res) => res.json())
      .then((data) => setAdmins(data.admins ?? []))
      .catch(() => {});
  }, []);

  async function refresh() {
    const res = await fetch("/api/settings");
    const data = await res.json().catch(() => null);
    if (res.ok) {
      setSettings(data.settings);
      setPurgeableCount(data.purgeableCount);
      setRetentionDays(String(data.settings.retention_days));
    }
  }

  async function save() {
    if (!selectedAdmin) return;
    const days = Number(retentionDays);
    if (!Number.isInteger(days) || days <= 0) {
      setError("Retention days must be a positive whole number.");
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminName: selectedAdmin, retentionDays: days }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Failed to save (HTTP ${res.status}).`);
        return;
      }
      setMessage(`Retention window set to ${days} day(s).`);
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  async function purge() {
    if (!selectedAdmin) return;
    setPurging(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/purge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminName: selectedAdmin }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Failed to purge (HTTP ${res.status}).`);
        return;
      }
      setMessage(`Deleted ${data.deleted} expired unapproved resource(s).`);
      await refresh();
    } finally {
      setPurging(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <h2 className="text-sm font-semibold text-black dark:text-zinc-50">Retention</h2>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        How long an unapproved Resource is kept before it&apos;s eligible for purge. Never applies to Runs — those
        are this harness&apos;s own audit trail, not draft content. Last changed{" "}
        {settings.updated_by ? `by ${settings.updated_by} ` : ""}
        {new Date(settings.updated_at).toLocaleString()}.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <select
          className="rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
          value={selectedAdmin}
          onChange={(e) => setSelectedAdmin(e.target.value)}
        >
          <option value="">Sign as…</option>
          {admins.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={1}
          className="w-20 rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
          value={retentionDays}
          onChange={(e) => setRetentionDays(e.target.value)}
        />
        <span className="text-xs text-zinc-500 dark:text-zinc-400">days</span>
        <button
          onClick={save}
          disabled={saving || !selectedAdmin}
          className="rounded-full bg-zinc-900 px-4 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      <div className="mt-4 flex items-center justify-between rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
        <p className="text-xs text-amber-900 dark:text-amber-300">
          {purgeableCount} unapproved resource{purgeableCount === 1 ? "" : "s"} older than {settings.retention_days}{" "}
          day(s), eligible for purge right now.
        </p>
        <button
          onClick={purge}
          disabled={purging || !selectedAdmin || purgeableCount === 0}
          className="shrink-0 rounded-full bg-amber-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {purging ? "Purging…" : "Purge now"}
        </button>
      </div>

      {message && <p className="mt-2 text-sm text-green-700 dark:text-green-400">{message}</p>}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
