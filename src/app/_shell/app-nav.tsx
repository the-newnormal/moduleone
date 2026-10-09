"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavItem } from "@/lib/portal/access";

// The item a path belongs to: Portal on the portal itself only; the others on their own page and
// everything under it (Team health's Trend and drill-ins, every admin page).
export function currentItem(items: readonly NavItem[], pathname: string): NavItem["id"] | null {
  const item = items.find(({ href }) =>
    href === "/portal" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`),
  );
  return item?.id ?? null;
}

// Pills, the current one filled with ink. Below md they take a row of their own under the logomark
// and Sign out, and never wrap (that would make the stuck bar taller still): on the narrowest
// screens the row scrolls sideways, padded so the focus ring isn't clipped.
export function AppNav({ items }: { items: readonly NavItem[] }) {
  const current = currentItem(items, usePathname());
  return (
    <nav aria-label="Portal" className="order-last w-full md:order-none md:mr-auto md:w-auto">
      <ul className="-m-1 flex gap-1 overflow-x-auto p-1">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              href={item.href}
              aria-current={item.id === current ? "page" : undefined}
              className={`inline-flex h-10 shrink-0 items-center rounded-full px-2.5 text-[15px] font-medium whitespace-nowrap sm:px-4 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                item.id === current ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-accent"
              }`}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
