"use client";

import { useEffect, useState } from "react";
import type { SettingsRow } from "@/lib/settings";
import { RESOURCE_TYPES, RESOURCE_TYPE_LABELS, type ResourceType } from "@/lib/resources-types";

/**
 * Vocabulary settings, ported from Agent Manager's settings override
 * (D48): what things are CALLED, never what they ARE — internal keys
 * ("programme", each resources.type value) never change, only their
 * display label, so relabeling never breaks stored data or filters.
 */
export function LabelSettings({
  initialSettings,
  programmeLabel,
}: {
  initialSettings: SettingsRow;
  programmeLabel: string;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [segmentationLabel, setSegmentationLabel] = useState(programmeLabel);
  const [kindLabels, setKindLabels] = useState<Record<ResourceType, string>>(() => {
    const merged = { ...RESOURCE_TYPE_LABELS };
    for (const t of RESOURCE_TYPES) {
      const override = initialSettings.kind_labels?.[t];
      if (override) merged[t] = override;
    }
    return merged;
  });
  const [admins, setAdmins] = useState<string[]>([]);
  const [selectedAdmin, setSelectedAdmin] = useState("");
  const [savingSeg, setSavingSeg] = useState(false);
  const [savingKinds, setSavingKinds] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admins")
      .then((res) => res.json())
      .then((data) => setAdmins(data.admins ?? []))
      .catch(() => {});
  }, []);

  async function saveSegmentationLabel() {
    if (!selectedAdmin || !segmentationLabel.trim()) return;
    setSavingSeg(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminName: selectedAdmin, segmentationLabel: segmentationLabel.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Failed to save (HTTP ${res.status}).`);
        return;
      }
      setSettings(data.settings);
      setMessage(`Renamed to "${segmentationLabel.trim()}".`);
    } finally {
      setSavingSeg(false);
    }
  }

  async function saveKindLabels() {
    if (!selectedAdmin) return;
    setSavingKinds(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminName: selectedAdmin, kindLabels }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Failed to save (HTTP ${res.status}).`);
        return;
      }
      setSettings(data.settings);
      setMessage("Kind labels saved.");
    } finally {
      setSavingKinds(false);
    }
  }

  return (
    <>
      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="text-sm font-semibold text-black dark:text-zinc-50">Segmentation label</h2>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          What this harness calls a Programme — rename it to fit your org&apos;s vocabulary. Last changed{" "}
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
            type="text"
            className="min-w-40 rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
            value={segmentationLabel}
            onChange={(e) => setSegmentationLabel(e.target.value)}
          />
          <button
            onClick={saveSegmentationLabel}
            disabled={savingSeg || !selectedAdmin || !segmentationLabel.trim()}
            className="rounded-full bg-zinc-900 px-4 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
          >
            {savingSeg ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="text-sm font-semibold text-black dark:text-zinc-50">Kind labels</h2>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Display names for the resource kinds this harness accepts.</p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {RESOURCE_TYPES.map((t) => (
            <label key={t} className="flex flex-col gap-1 text-xs">
              <span className="text-zinc-500 dark:text-zinc-400">{t}</span>
              <input
                type="text"
                className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                value={kindLabels[t]}
                onChange={(e) => setKindLabels((prev) => ({ ...prev, [t]: e.target.value }))}
              />
            </label>
          ))}
        </div>
        <button
          onClick={saveKindLabels}
          disabled={savingKinds || !selectedAdmin}
          className="mt-3 rounded-full bg-zinc-900 px-4 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
        >
          {savingKinds ? "Saving…" : "Save kind labels"}
        </button>
      </div>

      {message && <p className="text-sm text-green-700 dark:text-green-400">{message}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </>
  );
}
