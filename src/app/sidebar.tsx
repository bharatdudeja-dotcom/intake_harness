"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

/**
 * The grouped-sidebar layout is the one piece of Bharat's Agent Manager
 * (services/agent-manager/ — never touched, only looked at) worth carrying
 * over as-is: a left nav grouped by what it's for, not a flat top bar.
 */
const GROUPS: { heading: string; links: { href: string; label: string }[] }[] = [
  {
    heading: "Workbench",
    links: [
      { href: "/", label: "Home" },
      { href: "/runs", label: "Runs" },
      { href: "/queue", label: "Live Queue" },
      { href: "/programmes", label: "Programmes" },
    ],
  },
  {
    heading: "Knowledge",
    links: [
      { href: "/resources", label: "Resources" },
      { href: "/graph", label: "Shared Graph" },
    ],
  },
  {
    heading: "Admin",
    links: [
      { href: "/agents", label: "Agents" },
      { href: "/settings", label: "Settings" },
    ],
  },
];

/**
 * A fixed 224px sidebar next to content works on a laptop and eats most of
 * a phone screen — on a 390px-wide iPhone it left barely 40% of the width
 * for the actual page. Below `md` this renders a slim top bar with a menu
 * button instead, and the nav itself becomes a slide-in drawer over the
 * page rather than a permanent column.
 */
export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Closing on navigation is what makes the drawer feel like a menu rather
  // than a panel you have to remember to dismiss yourself. Reset during
  // render (React's documented pattern for "adjust state on prop change")
  // instead of an effect, so it doesn't cause an extra cascading render.
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    setOpen(false);
  }

  const nav = (
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
  );

  return (
    <>
      {/* Mobile top bar — the only thing visible below md until the menu is opened. */}
      <div className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-3 md:hidden dark:border-zinc-800 dark:bg-zinc-950">
        <p className="text-sm font-semibold text-black dark:text-zinc-50">Agentic Harness</p>
        <button
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          className="rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
      </div>

      {/* Backdrop, mobile only, while the drawer is open. */}
      {open && (
        <button
          aria-label="Close menu"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 bg-black/30 md:hidden"
        />
      )}

      {/* The nav itself: a fixed slide-in drawer below md, a normal static column at md and up. */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col gap-6 overflow-y-auto border-r border-zinc-200 bg-white px-4 py-6 shadow-lg transition-transform duration-200 ease-out md:sticky md:top-0 md:z-auto md:h-screen md:w-56 md:max-w-none md:shrink-0 md:translate-x-0 md:shadow-none dark:border-zinc-800 dark:bg-zinc-950 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-black dark:text-zinc-50">Agentic Harness</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Comcast · Xfinity</p>
          </div>
          <button
            onClick={() => setOpen(false)}
            aria-label="Close menu"
            className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100 md:hidden dark:text-zinc-400 dark:hover:bg-zinc-900"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        {nav}
      </aside>
    </>
  );
}
