import Link from "next/link";
import { SignOutButton } from "@/app/portal/sign-out-button";
import type { NavItem } from "@/lib/portal/access";
import { AppNav } from "./app-nav";

// The bar along the top of every signed-in page (the portal, check-in, Team health and admin),
// stuck to the top as the page scrolls: the Normal logomark, the nav (only what the viewer may open,
// the current page marked) and the one Sign out button. Sign out stays a plain button in the bar,
// never inside a menu: it waits for a check-in take still saving, and unmounting it would drop that.
// It sits above the pages' own sticky parts (the Trend grid's first column) and below dialogs,
// menus and the heat-map's tooltip.
export function AppBar({ nav }: { nav: NavItem[] }) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background">
      <div className="mx-auto flex w-full max-w-[1120px] flex-wrap items-center justify-between gap-x-8 gap-y-2 px-4 py-2 sm:px-8 md:py-3">
        <div className="flex items-baseline gap-3">
          <Link href="/portal" className="rounded-sm text-xl leading-[26px] font-medium tracking-[-0.01em]">
            Normal
          </Link>
          <span className="text-[13px] leading-[18px] text-muted-foreground">Module One</span>
        </div>
        <AppNav items={nav} />
        <SignOutButton />
      </div>
    </header>
  );
}
