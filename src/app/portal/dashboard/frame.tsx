import { Clock, OctagonAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import type { Role } from "@/lib/dashboard/load";
import { ORG_WEEKS } from "@/lib/dashboard/weeks";
import type { HealthConfig } from "@/lib/health/health";
import { BANDS } from "./band";

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

export function DashboardFrame({ view, role, children }: { view: View; role: Role | null; children: ReactNode }) {
  return (
    <main className="mx-auto grid w-full max-w-6xl grid-cols-[minmax(0,1fr)] gap-6 px-4 py-10">
      <header className="grid gap-2">
        <Link href="/portal" className="w-fit text-sm text-muted-foreground hover:text-foreground">
          ← Portal
        </Link>
        <h1 className="text-4xl">Team health</h1>
        {role && role !== "member" && <p className="text-muted-foreground">{BLURB[view][role]}</p>}
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
export function Legend({ config, view }: { config: HealthConfig; view: View }) {
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
        <li className="flex items-center gap-1.5">
          <OctagonAlert aria-hidden className="size-3 text-status-critical" strokeWidth={2.5} />
          <span className="text-muted-foreground">someone was red</span>
        </li>
        {view === "org" && (
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="flex h-4 items-end gap-0.5">
              <span className="h-4 w-1.5 rounded-t-[2px] bg-status-good" />
              <span className="h-2.5 w-1.5 rounded-t-[2px] bg-status-warning" />
              <span className="h-1.5 w-1.5 rounded-t-[2px] bg-status-critical" />
            </span>
            <span className="text-muted-foreground">
              the last {ORG_WEEKS} weeks, oldest first: the taller the bar, the better the week
            </span>
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
