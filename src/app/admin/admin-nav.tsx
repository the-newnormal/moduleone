"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/admin/structure", label: "Structure", matches: ["/admin/structure", "/admin/teams"] },
  { href: "/admin/scoring", label: "Scoring", matches: ["/admin/scoring"] },
  { href: "/admin/costs", label: "Costs", matches: ["/admin/costs"] },
] as const;

// The admin header's links. A team's page counts as part of Structure (it's reached from there).
export function AdminNav() {
  const pathname = usePathname();
  const isCurrent = (prefixes: readonly string[]) =>
    prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  return (
    <nav aria-label="Admin" className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
      {LINKS.map(({ href, label, matches }) => {
        const current = isCurrent(matches);
        return (
          <Link
            key={href}
            href={href}
            aria-current={current ? "page" : undefined}
            className={
              current
                ? "font-semibold text-foreground underline underline-offset-4"
                : "text-muted-foreground hover:text-foreground"
            }
          >
            {label}
          </Link>
        );
      })}
      <Link href="/portal" className="text-muted-foreground hover:text-foreground sm:ml-auto">
        Back to portal
      </Link>
    </nav>
  );
}
