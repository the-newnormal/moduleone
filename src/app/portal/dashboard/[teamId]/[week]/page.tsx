import { Clock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadLedTeams, loadRole, loadScoringConfig, loadTeamWeek, type TeamWeekCheckin } from "@/lib/dashboard/load";
import { coverage, yours } from "@/lib/dashboard/org";
import { formatWeek, isWeekStart, parseWeekCount, weekStartFor } from "@/lib/dashboard/weeks";
import { formatScore, type HealthConfig, healthBand, healthScore, teamWeekHealth } from "@/lib/health/health";
import { createClient } from "@/lib/supabase/server";
import { BandBadge } from "../../band";
import { signInAgain } from "../../sign-in";
import { CheckinControls } from "./checkin-controls";
import { RecordingPlayer } from "./recording-player";

export const metadata: Metadata = { title: "Team week · Module One" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function CheckinCard({
  checkin,
  config,
  Title,
  manage,
}: {
  checkin: TeamWeekCheckin;
  config: HealthConfig;
  Title: "h2" | "h3";
  // For a Master Admin: whether the week is the current one (a reset check-in can be redone).
  manage: { currentWeek: boolean } | null;
}) {
  const { activity_score: a, excellence_score: e, morale_score: m } = checkin;
  const graded = a !== null && e !== null && m !== null;
  const score = graded ? healthScore({ activity: a, excellence: e, morale: m }, config) : null;

  return (
    <Card className="gap-4">
      <CardHeader className="grid-cols-[1fr_auto]">
        <CardTitle>
          <Title className="font-sans text-xl leading-[26px] font-medium">{checkin.memberName ?? "A team member"}</Title>
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
        {manage && (
          <CheckinControls
            checkinId={checkin.id}
            memberName={checkin.memberName ?? "this team member"}
            hasRecording={checkin.hasRecording}
            awaitingGrader={checkin.awaitingGrader}
            currentWeek={manage.currentWeek}
          />
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
  const query = await searchParams;
  if (!data?.claims) redirect(signInAgain(`/portal/dashboard/${teamId}/${week}`, query));

  // Opened from the trend grid (which passes its ?weeks=) or the org chart, at this week or, from
  // an earlier week's bar, at the week in ?from=.
  const { weeks, from } = query;
  const chartWeek = typeof from === "string" && isWeekStart(from) ? from : week;
  const back =
    weeks !== undefined
      ? `/portal/dashboard/trend?weeks=${parseWeekCount(weeks)}`
      : chartWeek === weekStartFor(new Date())
        ? "/portal/dashboard"
        : `/portal/dashboard?week=${chartWeek}`;

  const [config, role, ledTeams] = await Promise.all([
    loadScoringConfig(supabase),
    loadRole(supabase),
    loadLedTeams(supabase),
  ]);
  // Members never see their grade or the leaders-only review (see ../../page.tsx).
  if (role === "member") redirect("/portal/checkin");
  // Team ids are lowercase everywhere else; a hand-typed uppercase one is the same team.
  const id = teamId === "none" ? null : teamId.toLowerCase();
  const covers = coverage(role, ledTeams);
  const teamWeek = await loadTeamWeek(supabase, id, week, covers);
  const { checkins } = teamWeek;
  // Check-ins from the teams under this one come in sections, a team each, in org-chart order.
  type Section = { teamId: string | null; team: string | null; checkins: TeamWeekCheckin[] };
  const sections = checkins.reduce<Section[]>((out, checkin) => {
    const last = out[out.length - 1];
    if (last && last.teamId === checkin.teamId) last.checkins.push(checkin);
    else out.push({ teamId: checkin.teamId, team: checkin.team, checkins: [checkin] });
    return out;
  }, []);
  const sectioned = sections.some((section) => section.team !== null);
  // Outside the teams they cover, a leader reads only their own check-ins (as on the org chart).
  const teamName = !id ? "No team" : covers(id) ? (teamWeek.teamName ?? "Earlier team") : yours(teamWeek.teamName);
  const cell = teamWeekHealth(checkins, config);
  const waiting = checkins.length - (cell?.graded ?? 0);
  // Master Admins may delete a recording or reset a check-in (the database checks again).
  const manage = role === "hq" ? { currentWeek: week === weekStartFor(new Date()) } : null;

  return (
    <main className="mx-auto grid w-full max-w-3xl grid-cols-[minmax(0,1fr)] gap-6 px-4 py-10">
      <header className="grid gap-2">
        <Link href={back} className="w-fit text-sm text-muted-foreground hover:text-foreground">
          ← Team health
        </Link>
        {teamWeek.context.length > 0 && (
          <p className="text-xs leading-4 font-medium tracking-[0.02em] text-muted-foreground">
            {teamWeek.context.join(" › ")}
          </p>
        )}
        <h1 className="text-4xl">{teamName}</h1>
        <p className="text-muted-foreground">Week of {formatWeek(week, true)}</p>
        {cell && (
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
        <p className="rounded-xl bg-card p-6 text-muted-foreground">
          No check-ins you can see from this team that week.
        </p>
      ) : sectioned ? (
        sections.map((section) => (
          <section key={section.teamId ?? "none"} aria-label={section.team ?? teamName} className="grid gap-4">
            <h2 className="font-sans text-xs leading-4 font-medium tracking-[0.02em] text-muted-foreground">
              {section.team ?? teamName}
            </h2>
            {section.checkins.map((checkin) => (
              <CheckinCard key={checkin.id} checkin={checkin} config={config} Title="h3" manage={manage} />
            ))}
          </section>
        ))
      ) : (
        <section aria-label="Check-ins" className="grid gap-4">
          {checkins.map((checkin) => (
            <CheckinCard key={checkin.id} checkin={checkin} config={config} Title="h2" manage={manage} />
          ))}
        </section>
      )}
    </main>
  );
}
