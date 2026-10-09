"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import type { NavItem } from "@/lib/portal/access";

// The item a path belongs to: Portal on the portal itself only; the others on their own page and
// everything under it (Team health's Trend and drill-ins, every admin page).
export function currentItem(items: readonly NavItem[], pathname: string): NavItem["id"] | null {
  const item = items.find(({ href }) =>
    href === "/portal" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`),
  );
  return item?.id ?? null;
}

// Keeps a tab in its row's view, with room for the focus ring, for when the row scrolls sideways.
// Only the row scrolls: scrollIntoView would move the page too, since its scroll padding (for this
// bar) counts the bar's own tabs as hidden.
function reveal(tab: HTMLElement | null) {
  const row = tab?.closest("ul");
  if (!tab || !row) return;
  const ring = 4;
  const { left, right } = tab.getBoundingClientRect();
  const view = row.getBoundingClientRect();
  if (left - ring < view.left) row.scrollLeft -= view.left - (left - ring);
  else if (right + ring > view.right) row.scrollLeft += right + ring - view.right;
}

// Pills, the current one filled with ink: "page" on the item's own page, "true" on a page under it.
// Below md they take a row of their own under the logomark and Sign out, and never wrap (that would
// make the stuck bar taller still); they tighten below 360px so all four fit at 320, and should the
// row still overflow (larger text), it scrolls sideways, keeping the current and a focused tab in
// view, padded so the focus ring isn't clipped.
export function AppNav({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname();
  const current = currentItem(items, pathname);
  const currentTab = useRef<HTMLAnchorElement>(null);
  useEffect(() => reveal(currentTab.current), [current]);

  return (
    <nav aria-label="Main" className="order-last w-full md:order-none md:mr-auto md:w-auto">
      <ul className="-m-1 flex gap-0.5 overflow-x-auto p-1 min-[360px]:gap-1">
        {items.map((item) => {
          const isCurrent = item.id === current;
          return (
            <li key={item.id}>
              <Link
                ref={isCurrent ? currentTab : undefined}
                href={item.href}
                aria-current={isCurrent ? (pathname === item.href ? "page" : "true") : undefined}
                onFocus={(event) => reveal(event.currentTarget)}
                className={`inline-flex h-10 shrink-0 items-center rounded-full px-1.5 text-[14px] font-medium whitespace-nowrap min-[360px]:px-2 min-[360px]:text-[15px] sm:px-4 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                  isCurrent ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-accent"
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
