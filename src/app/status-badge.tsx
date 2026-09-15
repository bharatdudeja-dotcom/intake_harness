export function StatusBadge({ status }: { status: string }) {
  const color =
    status === "completed"
      ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-400"
      : status === "failed"
        ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-400"
        : status === "needs_input"
          ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-400"
          : "bg-zinc-100 text-zinc-800 dark:bg-zinc-900 dark:text-zinc-400";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>{status}</span>;
}
