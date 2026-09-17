import { listAdmins } from "@/lib/admins";
import { getRunStats } from "@/lib/pipeline/orchestrator";

export const dynamic = "force-dynamic";

/**
 * Settings — read-only visibility into the configuration this deployment
 * is actually running with. No editable form yet: ADMIN_NAMES is an env
 * var, not a DB-backed setting, so there's nothing here to save — this
 * page exists so "who can approve things" isn't invisible.
 */
export default async function SettingsPage() {
  const admins = listAdmins();
  const stats = await getRunStats();

  return (
    <div className="flex max-w-2xl flex-col gap-6 px-8 py-10">
      <div>
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Settings</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          What this deployment is actually configured with — read-only for now.
        </p>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="text-sm font-semibold text-black dark:text-zinc-50">Admins</h2>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          From <code className="text-xs">ADMIN_NAMES</code> — the only names that can approve or promote a run or
          resource.
        </p>
        {admins.length === 0 ? (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
            No admins configured — approve/promote will 403 for everyone until ADMIN_NAMES is set.
          </p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {admins.map((name) => (
              <li key={name} className="rounded-full bg-zinc-100 px-3 py-1 text-sm text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
                {name}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="text-sm font-semibold text-black dark:text-zinc-50">Runs</h2>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
          {[
            ["Total", stats.total],
            ["Needs input", stats.needsInput],
            ["Failed", stats.failed],
            ["Approved", stats.approved],
            ["Promoted", stats.promoted],
          ].map(([label, value]) => (
            <div key={label as string}>
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
              <dd className="font-medium text-black dark:text-zinc-50">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
