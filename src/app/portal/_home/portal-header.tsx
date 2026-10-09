import { formatWeek } from "@/lib/dashboard/weeks";

// The portal's opener: the week and a greeting. The bar above it (logomark, nav, Sign out) is the
// app bar every signed-in page shares (src/app/_shell/app-bar.tsx).
export function PortalHeader({
  name,
  email,
  thisWeek,
}: {
  name: string | null;
  email: string | undefined;
  thisWeek: string;
}) {
  return (
    <header className="grid gap-2">
      <p className="text-xs leading-4 font-medium tracking-[0.02em] text-muted-foreground">
        Week of {formatWeek(thisWeek, true)}
      </p>
      {/* The full name: many names here put the family name first, so never just the first word. */}
      <h1 className="text-[32px] leading-9 tracking-[-0.02em] break-words sm:text-[44px] sm:leading-[48px]">
        {name ? `Hello, ${name}` : "Portal"}
      </h1>
      {email && <p className="truncate text-[13px] leading-[18px] text-muted-foreground">Signed in as {email}</p>}
    </header>
  );
}
