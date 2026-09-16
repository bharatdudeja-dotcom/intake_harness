"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/runs", label: "Runs" },
  { href: "/graph", label: "Shared Graph" },
];

export function Navbar() {
  const pathname = usePathname();

  return (
    <nav className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mx-auto flex max-w-4xl items-center gap-6 px-6 py-3">
        <span className="text-sm font-semibold text-black dark:text-zinc-50">Agentic Harness</span>
        <div className="flex gap-4">
          {LINKS.map((link) => {
            // "/runs" should also stay highlighted on a deep-linked
            // "/runs/[runId]" detail page, not just the exact list route.
            const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`text-sm ${
                  active
                    ? "font-medium text-black dark:text-zinc-50"
                    : "text-zinc-500 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-200"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
