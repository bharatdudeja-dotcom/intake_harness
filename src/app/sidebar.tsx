"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The grouped-sidebar layout is the one piece of Bharat's Agent Manager
 * (services/agent-manager/ — never touched, only looked at) worth carrying
 * over as-is: a left nav grouped by what it's for, not a flat top bar. Only
 * groups/links for pages that actually exist here — no Playbooks/Settings/
 * Connections stubs pointing nowhere.
 */
const GROUPS: { heading: string; links: { href: string; label: string }[] }[] = [
  {
    heading: "Workbench",
    links: [
      { href: "/", label: "Home" },
      { href: "/runs", label: "Runs" },
    ],
  },
  {
    heading: "Knowledge",
    links: [{ href: "/graph", label: "Shared Graph" }],
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex w-56 shrink-0 flex-col gap-6 border-r border-zinc-200 bg-white px-4 py-6 dark:border-zinc-800 dark:bg-zinc-950">
      <div>
        <p className="text-sm font-semibold text-black dark:text-zinc-50">Agentic Harness</p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">Comcast · Xfinity</p>
      </div>

      <nav className="flex flex-col gap-5">
        {GROUPS.map((group) => (
          <div key={group.heading} className="flex flex-col gap-0.5">
            <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-600">
              {group.heading}
            </p>
            {group.links.map((link) => {
              const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`rounded-md px-2 py-1.5 text-sm ${
                    active
                      ? "bg-zinc-100 font-medium text-black dark:bg-zinc-900 dark:text-zinc-50"
                      : "text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-900/60"
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
