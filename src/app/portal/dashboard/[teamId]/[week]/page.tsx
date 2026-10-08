import { Clock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadRole, loadScoringConfig, loadTeamWeek, type TeamWeekCheckin } from "@/lib/dashboard/load";
import { formatWeek, isWeekStart, parseWeekCount } from "@/lib/dashboard/weeks";
import { formatScore, type HealthConfig, healthBand, healthScore, teamWeekHealth } from "@/lib/health/health";
import { createClient } from "@/lib/supabase/server";
import { BandBadge } from "../../band";
import { RecordingPlayer } from "./recording-player";

export const metadata: Metadata = { title: "Team week · Module One" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function CheckinCard({ checkin, config }: { checkin: TeamWeekCheckin; config: HealthConfig }) {
  const { activity_score: a, excellence_score: e, morale_score: m } = checkin;
  const graded = a !== null && e !== null && m !== null;
  const score = graded ? healthScore({ activity: a, excellence: e, morale: m }, config) : null;

  return (
    <Card className="gap-4">
      <CardHeader className="grid-cols-[1fr_auto]">
        <CardTitle>
          <h2 className="font-sans text-lg font-semibold">{checkin.memberName ?? "A team member"}</h2>
        </CardTitle>
        {score !== null ? (
          <BandBadge band={healthBand(score, config)} score={formatScore(score, config)} />
        ) : (
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <Clock aria-hidden className="size-4" />
            Waiting for the grader
          </span>
        )}
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {graded && (
          <dl className="flex flex-wrap gap-x-5 gap-y-1">
            {[
              ["Activity", a],
              ["Excellence", e],
              ["Morale", m],
            ].map(([label, value]) => (
              <div key={label} className="flex gap-1.5">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-medium tabular-nums">{value} / 5</dd>
              </div>
            ))}
          </dl>
        )}
        {checkin.rubric_review && <p className="break-words whitespace-pre-line">{checkin.rubric_review}</p>}
        {checkin.recording && <RecordingPlayer src={checkin.recording} />}
        {checkin.transcript && (
          <details className="rounded-md border px-3 py-2">
            <summary className="cursor-pointer text-muted-foreground">Transcript</summary>
            <p className="mt-2 break-words whitespace-pre-line">{checkin.transcript}</p>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

export default async function TeamWeekPage({
  params,
  searchParams,
}: PageProps<"/portal/dashboard/[teamId]/[week]">) {
  const { teamId, week } = await params;
  if ((teamId !== "none" && !UUID.test(teamId)) || !isWeekStart(week)) notFound();

  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) redirect(`/login?next=${encodeURIComponent(`/portal/dashboard/${teamId}/${week}`)}`);

  const weekCount = parseWeekCount((await searchParams).weeks);
  const [config, teamWeek, role] = await Promise.all([
    loadScoringConfig(supabase),
    loadTeamWeek(supabase, teamId === "none" ? null : teamId, week),
    loadRole(supabase),
  ]);
  const { checkins } = teamWeek;
  const team = teamId === "none" ? "No team" : (teamWeek.teamName ?? "Earlier team");
  // A member only ever sees their own check-in here, as on the grid: no team-wide summary.
  const own = role === "member";
  const teamName = own ? `You · ${team}` : team;
  const cell = teamWeekHealth(checkins, config);
  const waiting = checkins.length - (cell?.graded ?? 0);

  return (
    <main className="mx-auto grid w-full max-w-3xl grid-cols-[minmax(0,1fr)] gap-6 px-4 py-10">
      <header className="grid gap-2">
        <Link
          href={`/portal/dashboard?weeks=${weekCount}`}
          className="w-fit text-sm text-muted-foreground hover:text-foreground"
        >
          ← Team health
        </Link>
        {teamWeek.context.length > 0 && (
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {teamWeek.context.join(" › ")}
          </p>
        )}
        <h1 className="text-4xl">{teamName}</h1>
        <p className="text-muted-foreground">Week of {formatWeek(week, true)}</p>
        {cell && !own && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <BandBadge band={cell.band} score={formatScore(cell.score, config)} />
            <span className="text-muted-foreground">
              mean of {cell.graded} graded check-in{cell.graded === 1 ? "" : "s"}: {cell.bands.green} green,{" "}
              {cell.bands.yellow} yellow, {cell.bands.red} red
              {waiting > 0 && `; ${waiting} waiting for the grader`}
            </span>
          </div>
        )}
      </header>

      {checkins.length === 0 ? (
        <p className="rounded-xl border bg-card p-6 text-muted-foreground">
          No check-ins you can see from this team that week.
        </p>
      ) : (
        <section aria-label="Check-ins" className="grid gap-4">
          {checkins.map((checkin) => (
            <CheckinCard key={checkin.id} checkin={checkin} config={config} />
          ))}
        </section>
      )}
    </main>
  );
}
