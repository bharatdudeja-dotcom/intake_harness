"use client";

import { useState } from "react";
import type { SettingsRow } from "@/lib/settings";

/**
 * Hero Agents roster (D64), ported from Agent Manager: the subset of
 * ADMIN_NAMES allowed to promote a run/resource into the Shared Graph.
 * An empty roster means "any admin may promote" — today's behavior —
 * so clearing every checkbox is a safe reset, never a lockout.
 */
export function PromoteAdminsSettings({
  initialSettings,
  admins,
}: {
  initialSettings: SettingsRow;
  admins: string[];
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [roster, setRoster] = useState<Set<string>>(new Set(initialSettings.promote_admins ?? []));
  const [selectedAdmin, setSelectedAdmin] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function toggle(name: string) {
    setRoster((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function save() {
    if (!selectedAdmin) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminName: selectedAdmin, promoteAdmins: Array.from(roster) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Failed to save (HTTP ${res.status}).`);
        return;
      }
      setSettings(data.settings);
      setRoster(new Set(data.settings.promote_admins ?? []));
      setMessage(
        data.settings.promote_admins?.length
          ? "Roster saved — only these admins may promote now."
          : "Roster cleared — any admin may promote again.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <h2 className="text-sm font-semibold text-black dark:text-zinc-50">Hero Agents</h2>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Who may admit an approved run or resource into the Shared Graph. Leave every box unchecked to let any admin
        promote. Last changed {settings.updated_by ? `by ${settings.updated_by} ` : ""}
        {new Date(settings.updated_at).toLocaleString()}.
      </p>

      {admins.length === 0 ? (
        <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">No admins configured — set ADMIN_NAMES first.</p>
      ) : (
        <ul className="mt-3 flex flex-wrap gap-2">
          {admins.map((name) => (
            <li key={name}>
              <label
                className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-sm ${
                  roster.has(name)
                    ? "border-purple-600 bg-purple-50 text-purple-800 dark:border-purple-500 dark:bg-purple-950/40 dark:text-purple-300"
                    : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
                }`}
              >
                <input type="checkbox" className="sr-only" checked={roster.has(name)} onChange={() => toggle(name)} />
                {name}
              </label>
            </li>
          ))}
        </ul>
      )}

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
        <button
          onClick={save}
          disabled={saving || !selectedAdmin}
          className="rounded-full bg-zinc-900 px-4 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {message && <p className="mt-2 text-sm text-green-700 dark:text-green-400">{message}</p>}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
