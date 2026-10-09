import Link from "next/link";
import { formatWeek } from "@/lib/dashboard/weeks";
import type { NavItem } from "@/lib/portal/access";
import { SignOutButton } from "../sign-out-button";

// The portal's top bar and opener: the Normal logomark, the nav (only what the viewer may open), the
// one Sign out button, then the week and a greeting. Sign out stays a plain button in the bar,
// never inside a menu: it waits for a check-in take still saving, and unmounting it would drop that.
export function PortalHeader({
  name,
  email,
  thisWeek,
  nav,
}: {
  name: string | null;
  email: string | undefined;
  thisWeek: string;
  nav: NavItem[];
}) {
  return (
    <header className="grid gap-10 sm:gap-12">
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4 border-b pb-4">
        <div className="flex items-baseline gap-3">
          <Link href="/portal" className="rounded-sm text-xl leading-[26px] font-medium tracking-[-0.01em]">
            Normal
          </Link>
          <span className="text-[13px] leading-[18px] text-muted-foreground">Module One</span>
        </div>
        <PortalNav items={nav} />
        <SignOutButton />
      </div>
      <div className="grid gap-2">
        <p className="text-xs leading-4 font-medium tracking-[0.02em] text-muted-foreground">
          Week of {formatWeek(thisWeek, true)}
        </p>
        {/* The full name: many names here put the family name first, so never just the first word. */}
        <h1 className="text-[32px] leading-9 tracking-[-0.02em] break-words sm:text-[44px] sm:leading-[48px]">
          {name ? `Hello, ${name}` : "Portal"}
        </h1>
        {email && (
          <p className="truncate text-[13px] leading-[18px] text-muted-foreground">Signed in as {email}</p>
        )}
      </div>
    </header>
  );
}

// Pills, the current one filled with ink. This is the portal's own page, so "Portal" is current.
function PortalNav({ items }: { items: NavItem[] }) {
  return (
    <nav aria-label="Portal" className="order-last w-full sm:order-none sm:mr-auto sm:w-auto">
      <ul className="flex flex-wrap gap-1">
        {items.map((item) => {
          const current = item.id === "portal";
          return (
            <li key={item.id}>
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={`inline-flex h-10 items-center rounded-full px-3 text-[15px] font-medium sm:px-4 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                  current ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-accent"
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
