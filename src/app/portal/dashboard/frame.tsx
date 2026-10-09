import { Clock } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import type { Role } from "@/lib/dashboard/load";
import { ORG_WEEKS } from "@/lib/dashboard/weeks";
import type { HealthConfig } from "@/lib/health/health";
import { BANDS, barClass, RedCount } from "./band";

// What the two views of the heat-map share: the header, the switch between them and the legend.
// Members are sent to their check-in before any of it renders (see ./page.tsx).

export type View = "org" | "trend";
type Viewer = Exclude<Role, "member">;

const BLURB: Record<View, Record<Viewer, string>> = {
  org: {
    hq: "Every division, domain and team, coloured by one week. Each box takes in the teams under it; open one to read its check-ins.",
    leader: "The teams you lead, coloured by one week. Each box takes in the teams under it; open one to read its check-ins.",
  },
  trend: {
    hq: "Every team, week by week. Open a cell to read that week's check-ins.",
    leader: "The teams you lead, week by week. Open a cell to read that week's check-ins.",
  },
};

const VIEWS: { view: View; label: string; href: string }[] = [
  { view: "org", label: "Org chart", href: "/portal/dashboard" },
  { view: "trend", label: "Trend", href: "/portal/dashboard/trend" },
];

// `aside` goes at the header's top right (below it on a phone): the tally of colours.
export function DashboardFrame({
  view,
  role,
  aside,
  children,
}: {
  view: View;
  role: Role | null;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto grid w-full max-w-6xl grid-cols-[minmax(0,1fr)] gap-6 px-4 py-10">
      <header className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="grid min-w-0 flex-1 basis-80 gap-2">
          <Link href="/portal" className="w-fit text-sm text-muted-foreground hover:text-foreground">
            ← Portal
          </Link>
          <h1 className="text-4xl">Team health</h1>
          {role && role !== "member" && <p className="text-muted-foreground">{BLURB[view][role]}</p>}
        </div>
        {aside}
      </header>

      {!role ? (
        <p className="rounded-xl border bg-card p-6">
          Your sign-in isn&apos;t linked to a team member yet, so there&apos;s nothing to show. Ask an
          admin to add you.
        </p>
      ) : (
        <>
          <nav aria-label="Views" className="flex w-fit gap-1 rounded-lg border bg-muted p-1 text-sm">
            {VIEWS.map(({ view: v, label, href }) => (
              <Link
                key={v}
                href={href}
                aria-current={v === view ? "page" : undefined}
                className={`rounded-md px-3 py-1.5 ${
                  v === view ? "bg-card font-semibold shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </Link>
            ))}
          </nav>
          {children}
        </>
      )}
    </main>
  );
}

// The org chart's key also explains its bars of recent weeks.
// A sample bar for the key: just enough of a cell for barClass.
const sample = (band: "green" | "yellow" | "red" | null, pending = 0) => ({
  health: band && { band, score: 0, graded: 1, bands: { green: 0, yellow: 0, red: 0 } },
  pending,
});

// `redCounts`: whether the boxes carry an "N red" count (a single Trend week writes it out instead).
export function Legend({
  config,
  view,
  role,
  redCounts = true,
}: {
  config: HealthConfig;
  view: View;
  role: Role | null;
  redCounts?: boolean;
}) {
  const { green, yellow } = config.thresholds;
  const items = [
    { band: BANDS.green, text: `${green} or more` },
    { band: BANDS.yellow, text: `${yellow} to under ${green}` },
    { band: BANDS.red, text: `under ${yellow}` },
  ];
  return (
    <div className="grid gap-2 text-sm">
      <ul className="flex flex-wrap gap-x-5 gap-y-1.5">
        {items.map(({ band, text }) => (
          <li key={band.label} className="flex items-center gap-1.5">
            <band.Icon aria-hidden className={`size-4 ${band.icon}`} strokeWidth={2.25} />
            <span className="font-medium">{band.label}</span>
            <span className="text-muted-foreground">{text}</span>
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <Clock aria-hidden className="size-4 text-muted-foreground" />
          <span className="text-muted-foreground">waiting for the grader</span>
        </li>
        {redCounts && (
          <li className="flex items-center gap-1.5">
            <RedCount count={2} />
            <span className="text-muted-foreground">
              how many of the {view === "org" ? "box" : "cell"}&apos;s check-ins were red, whatever its colour
            </span>
          </li>
        )}
        {view === "org" && (
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="flex h-5 items-end gap-0.5">
              {[sample("green"), sample("yellow"), sample("red"), sample(null, 1), sample(null)].map((cell, i) => (
                <span key={i} className={`w-2 rounded-t-[2px] ${barClass(cell)}`} />
              ))}
            </span>
            <span className="text-muted-foreground">
              the last {ORG_WEEKS} weeks, oldest first: the taller, the better; dashed, waiting for the grader;
              flat, no check-ins
            </span>
          </li>
        )}
        {role === "leader" && (
          <li className="text-muted-foreground">
            A grey name with no colour: you lead only some of the teams under it.
          </li>
        )}
      </ul>
      <p className="text-muted-foreground">
        A check-in&apos;s score is activity × excellence × a morale weight. Each {view === "org" ? "box" : "cell"}{" "}
        shows the mean of that week&apos;s graded check-ins in the team and every team under it. Admins set the
        weights and thresholds.
      </p>
    </div>
  );
}
