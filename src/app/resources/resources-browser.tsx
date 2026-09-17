"use client";

import { useCallback, useEffect, useState } from "react";
import { RESOURCE_TYPES, RESOURCE_TYPE_LABELS, type ResourceRow, type ResourceType } from "@/lib/resources-types";

type Filter = "all" | ResourceType;

/**
 * The Resources page — Playbooks, Decisions, Architecture docs/diagrams,
 * Meeting notes, Code snippets, Configs, Handoff-prompts. Same shape as
 * the Runs page (list + detail + admin approve/promote), because these
 * share the exact two-tier curation model runs already use.
 */
export function ResourcesBrowser({
  initialResourceId,
  kindLabels = {},
}: {
  initialResourceId?: string;
  kindLabels?: Record<string, string>;
}) {
  const labelFor = (t: ResourceType) => kindLabels[t] || RESOURCE_TYPE_LABELS[t];
  const [filter, setFilter] = useState<Filter>("all");
  const [resources, setResources] = useState<ResourceRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialResourceId ?? null);
  const [detail, setDetail] = useState<ResourceRow | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [newType, setNewType] = useState<ResourceType>("playbook");
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newTags, setNewTags] = useState("");
  const [creating, setCreating] = useState(false);

  const [admins, setAdmins] = useState<string[]>([]);
  const [selectedAdmin, setSelectedAdmin] = useState("");
  const [approvalNote, setApprovalNote] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [curating, setCurating] = useState(false);

  useEffect(() => {
    fetch("/api/admins")
      .then((res) => res.json())
      .then((data) => setAdmins(data.admins ?? []))
      .catch(() => {});
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    const url = filter === "all" ? "/api/resources" : `/api/resources?type=${filter}`;
    const res = await fetch(url);
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error ?? `Failed to load resources (HTTP ${res.status}).`);
      return;
    }
    setResources(data.resources ?? []);
  }, [filter]);

  // Fetch-on-mount via the fetch's own callback, not by calling `refresh`
  // (a setState-holding function) directly in the effect body — same
  // pattern as runs-browser.tsx, so a stale response can't overwrite
  // state after unmount and the effect itself never calls setState
  // synchronously.
  useEffect(() => {
    let cancelled = false;
    const url = filter === "all" ? "/api/resources" : `/api/resources?type=${filter}`;
    fetch(url)
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          if (!cancelled) setError(data?.error ?? `Failed to load resources (HTTP ${res.status}).`);
          return;
        }
        if (!cancelled) setResources(data.resources ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filter]);

  const loadDetail = useCallback(async (resourceId: string) => {
    setSelectedId(resourceId);
    const res = await fetch(`/api/resources/${resourceId}`);
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error ?? `Failed to load resource (HTTP ${res.status}).`);
      return;
    }
    setDetail(data.resource);
    setTagsInput((data.resource.tags ?? []).join(", "));
    setApprovalNote(data.resource.approval_note ?? "");
  }, []);

  // Deep-link support for /resources/[resourceId]: same inline-callback
  // pattern as above rather than calling loadDetail from the effect.
  useEffect(() => {
    if (!initialResourceId) return;
    let cancelled = false;
    fetch(`/api/resources/${initialResourceId}`)
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          if (!cancelled) setError(data?.error ?? `Failed to load resource (HTTP ${res.status}).`);
          return;
        }
        if (!cancelled) {
          setSelectedId(initialResourceId);
          setDetail(data.resource);
          setTagsInput((data.resource.tags ?? []).join(", "));
          setApprovalNote(data.resource.approval_note ?? "");
        }
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [initialResourceId]);

  async function createResource() {
    if (!newTitle.trim() || !newContent.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/resources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: newType,
          title: newTitle.trim(),
          content: newContent,
          tags: newTags.split(",").map((t) => t.trim()).filter(Boolean),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Failed to create resource (HTTP ${res.status}).`);
        return;
      }
      setNewTitle("");
      setNewContent("");
      setNewTags("");
      setShowForm(false);
      await refresh();
      await loadDetail(data.resource.resource_id);
    } finally {
      setCreating(false);
    }
  }

  async function approveResource() {
    if (!selectedId || !selectedAdmin) return;
    setCurating(true);
    setError(null);
    try {
      const res = await fetch(`/api/resources/${selectedId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminName: selectedAdmin, note: approvalNote }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Failed to approve (HTTP ${res.status}).`);
        return;
      }
      await loadDetail(selectedId);
      await refresh();
    } finally {
      setCurating(false);
    }
  }

  async function promoteResource() {
    if (!selectedId || !selectedAdmin) return;
    setCurating(true);
    setError(null);
    try {
      const tags = tagsInput.split(",").map((t) => t.trim()).filter(Boolean);
      const res = await fetch(`/api/resources/${selectedId}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminName: selectedAdmin, tags }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Failed to promote (HTTP ${res.status}).`);
        return;
      }
      await loadDetail(selectedId);
      await refresh();
    } finally {
      setCurating(false);
    }
  }

  return (
    <div className="flex max-w-5xl flex-col gap-6 px-4 py-6 sm:px-8 sm:py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Resources</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Playbooks, decisions, and other knowledge worth keeping — not a pipeline run.
          </p>
        </div>
        <button
          onClick={() => setShowForm((s) => !s)}
          className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-black"
        >
          {showForm ? "Cancel" : "+ New"}
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {showForm && (
        <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex flex-wrap gap-2">
            <select
              className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
              value={newType}
              onChange={(e) => setNewType(e.target.value as ResourceType)}
            >
              {RESOURCE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {labelFor(t)}
                </option>
              ))}
            </select>
            <input
              type="text"
              className="min-w-60 flex-1 rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
              placeholder="Title"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
            />
          </div>
          <textarea
            className="min-h-32 rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
            placeholder="Content"
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
          />
          <input
            type="text"
            className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
            placeholder="Tags, comma separated (optional)"
            value={newTags}
            onChange={(e) => setNewTags(e.target.value)}
          />
          <button
            onClick={createResource}
            disabled={creating || !newTitle.trim() || !newContent.trim()}
            className="self-start rounded-full bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
          >
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-1">
        <button
          onClick={() => setFilter("all")}
          className={`rounded-full px-3 py-1 text-xs ${filter === "all" ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black" : "border border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"}`}
        >
          All
        </button>
        {RESOURCE_TYPES.map((t) => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            className={`rounded-full px-3 py-1 text-xs ${filter === t ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black" : "border border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"}`}
          >
            {labelFor(t)}
          </button>
        ))}
      </div>

      <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-black dark:text-zinc-50">
            {loadingList ? "Loading…" : `${resources.length} resource${resources.length === 1 ? "" : "s"}`}
          </h2>
          <ol className="flex flex-col gap-1">
            {resources.map((r) => (
              <li key={r.resource_id}>
                <button
                  onClick={() => loadDetail(r.resource_id)}
                  className={`flex w-full flex-col gap-0.5 rounded-lg border px-3 py-2 text-left text-xs ${
                    selectedId === r.resource_id ? "border-zinc-900 dark:border-zinc-100" : "border-zinc-200 dark:border-zinc-800"
                  } bg-white dark:bg-zinc-950`}
                >
                  <span className="font-medium text-black dark:text-zinc-50">{r.title}</span>
                  <div className="flex items-center gap-2 text-zinc-400">
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 dark:bg-zinc-900">{labelFor(r.type)}</span>
                    {r.promoted && <span title="Promoted to Shared Graph">🔗</span>}
                    {r.approved && !r.promoted && <span title="Approved">✓</span>}
                  </div>
                </button>
              </li>
            ))}
            {!loadingList && resources.length === 0 && <p className="text-xs text-zinc-400">No resources yet.</p>}
          </ol>
        </div>

        <div>
          {detail ? (
            <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-950">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                  {labelFor(detail.type)}
                </span>
                <h3 className="font-medium text-black dark:text-zinc-50">{detail.title}</h3>
                {detail.approved && (
                  <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-400">
                    Approved by {detail.approved_by}
                  </span>
                )}
                {detail.promoted && (
                  <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800 dark:bg-purple-950 dark:text-purple-400">
                    Promoted by {detail.promoted_by}
                  </span>
                )}
              </div>

              <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-zinc-50 p-2 text-xs dark:bg-zinc-900">{detail.content}</pre>

              <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
                <p className="font-medium text-zinc-600 dark:text-zinc-400">Curation — mark worth keeping, and optionally share it.</p>
                <div className="flex flex-wrap items-center gap-2">
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
                    className="min-w-40 flex-1 rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                    placeholder="Approval note (optional)"
                    value={approvalNote}
                    onChange={(e) => setApprovalNote(e.target.value)}
                  />
                  <button
                    onClick={approveResource}
                    disabled={curating || !selectedAdmin || detail.approved}
                    className="rounded-full border border-zinc-300 px-3 py-1 font-medium text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300"
                  >
                    {detail.approved ? "Approved" : "Approve"}
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    className="min-w-40 flex-1 rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                    placeholder="Tags, comma separated"
                    value={tagsInput}
                    onChange={(e) => setTagsInput(e.target.value)}
                    disabled={!detail.approved}
                  />
                  <button
                    onClick={promoteResource}
                    disabled={curating || !selectedAdmin || !detail.approved || detail.promoted}
                    className="rounded-full bg-purple-600 px-3 py-1 font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                    title={!detail.approved ? "Approve this resource first" : undefined}
                  >
                    {detail.promoted ? "Promoted to Shared Graph" : "Promote to Shared Graph"}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-zinc-400">Select a resource to see its content.</p>
          )}
        </div>
      </div>
    </div>
  );
}
