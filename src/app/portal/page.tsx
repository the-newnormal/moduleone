import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { logError } from "@/lib/admin/errors";
import { currentWeekStart } from "@/lib/checkin/week";
import { loadScoringConfig } from "@/lib/dashboard/load";
import { weeksEndingAt } from "@/lib/dashboard/weeks";
import { loadPortalAccess, portalNav } from "@/lib/portal/access";
import { loadMyWeek, STRIP_WEEKS, weekStrip } from "@/lib/portal/my-week";
import { loadTeamHealthGlance } from "@/lib/portal/team-health";
import { createClient } from "@/lib/supabase/server";
import { AdminTile } from "./_home/admin-tile";
import { CheckinTile } from "./_home/checkin-tile";
import { PortalHeader } from "./_home/portal-header";
import { QuestionsTile } from "./_home/questions-tile";
import { TeamHealthStats, TeamHealthTile } from "./_home/team-health-tile";
import { ComingSoonTile } from "./_home/tile";
import { WeeksTile } from "./_home/weeks-tile";

export const metadata: Metadata = { title: "Portal · Module One" };

// The portal's dashboard. Everyone gets their own check-in, their last weeks and the questions;
// leaders and hq also get team health; holders of the admin grant the way into admin. What each
// viewer may see is decided here, on the server, before anything is loaded for it, and every query
// runs as the viewer, so RLS decides the rows. Members never see a grade: their tiles read only
// whether and when they checked in, and the heat-map is loaded only for leaders and hq.
export default async function PortalPage() {
  const supabase = await createClient();
  // The proxy already redirects signed-out visitors; check again here so the page
  // never renders without a verified user.
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) redirect("/login?next=/portal");

  const thisWeek = currentWeekStart(new Date());
  const stripWeeks = weeksEndingAt(thisWeek, STRIP_WEEKS);
  const accessLoad = loadPortalAccess(supabase);
  // None of these reject: each loader logs its own failure and says so in what it returns.
  const [access, mine, health, scoring] = await Promise.all([
    accessLoad,
    loadMyWeek(supabase, data.claims.sub, stripWeeks),
    accessLoad.then((a) => (a.seesTeamHealth ? loadTeamHealthGlance(supabase, thisWeek) : null)),
    // Admins who aren't leaders or hq get the thresholds without the heat-map.
    accessLoad.then((a) =>
      a.isAdmin && !a.seesTeamHealth
        ? loadScoringConfig(supabase).catch((error: unknown) => {
            logError("portal scoring", error);
            return null;
          })
        : null,
    ),
  ]);

  // The role loadHeatmapData read must agree too; if it doesn't, leave team health out.
  const teamHealth = health && health.status !== "hidden" ? health : null;
  const thresholds = teamHealth?.status === "ok" ? teamHealth.config.thresholds : (scoring?.thresholds ?? null);
  const name = mine.state === "ok" || mine.state === "unavailable" ? mine.name : null;
  const strip = mine.state === "ok" ? weekStrip(stripWeeks, mine.checkedIn, mine.thisWeek.state) : null;
  const hasMember = mine.state !== "no_member";
  const side = hasMember || access.isAdmin;

  return (
    <main className="mx-auto grid w-full max-w-[1120px] grid-cols-[minmax(0,1fr)] gap-10 px-4 py-6 sm:gap-12 sm:px-8 sm:py-8">
      <PortalHeader name={name} email={data.claims.email} thisWeek={thisWeek} nav={portalNav(access)} />

      <div className={`grid items-start gap-6 ${side ? "lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:gap-8" : ""}`}>
        <div className="grid min-w-0 gap-6">
          <CheckinTile week={mine} thisWeek={thisWeek} />
          {teamHealth?.status === "ok" && <TeamHealthStats health={teamHealth} />}
          {teamHealth && <TeamHealthTile health={teamHealth} />}
        </div>
        {side && (
          <div className="grid min-w-0 gap-6">
            {hasMember && <WeeksTile strip={strip} />}
            {hasMember && <QuestionsTile />}
            {access.isAdmin && <AdminTile thresholds={thresholds} />}
          </div>
        )}
      </div>

      {teamHealth && (
        <div className="grid gap-6 sm:grid-cols-2">
          <ComingSoonTile id="needs-a-look" title="Needs a look">
            The teams that are red this week, or where someone was red.
          </ComingSoonTile>
          <ComingSoonTile id="whos-checked-in" title="Who's checked in">
            How many people in each of your teams have checked in this week. Counts only, never names or scores.
          </ComingSoonTile>
        </div>
      )}
    </main>
  );
}
