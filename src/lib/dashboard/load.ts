import type { SupabaseClient } from "@supabase/supabase-js";
import { type HealthConfig, type ScoringSettingsRow, settingsToConfig } from "@/lib/health/health";
import type { CheckinRow, Coverage } from "./org";
import { playableRecordings, recordingPath } from "./recordings";
import { PAGE_SIZE, selectAll } from "./select-all";
import { lineage, subtree, type TeamNode, teamContext } from "./tree";

// Every loader here takes the signed-in user's client (src/lib/supabase/server.ts), never the
// service role: RLS decides what each viewer sees, so the dashboard shows exactly what they're
// allowed to read and nothing else.

export type Role = "member" | "leader" | "hq";

const SETTINGS_COLUMNS = [
  ...["activity", "excellence", "morale"].flatMap((m) => [1, 2, 3, 4, 5].map((s) => `${m}_${s}`)),
  "green_threshold",
  "yellow_threshold",
].join(",");

export async function loadScoringConfig(supabase: SupabaseClient): Promise<HealthConfig> {
  const { data, error } = await supabase.from("scoring_settings").select(SETTINGS_COLUMNS).single();
  if (error) throw new Error(`Couldn't load the scoring settings: ${error.message}`);
  return settingsToConfig(data as unknown as ScoringSettingsRow);
}

export async function loadRole(supabase: SupabaseClient): Promise<Role | null> {
  const { data, error } = await supabase.rpc("app_current_role");
  if (error) throw new Error(`Couldn't load your role: ${error.message}`);
  return (data as Role | null) ?? null;
}

// Everything a heat-map view needs for these weeks (oldest first).
export async function loadHeatmapData(supabase: SupabaseClient, weeks: readonly string[]) {
  const [teams, checkins, config, role, ledTeams] = await Promise.all([
    loadTeams(supabase),
    loadCheckins(supabase, weeks[0], weeks[weeks.length - 1]),
    loadScoringConfig(supabase),
    loadRole(supabase),
    loadLedTeams(supabase),
  ]);
  return { teams, checkins, config, role, ledTeams };
}

// The teams whose check-ins a leader reads: their own, the ones they lead (team_leads), and every
// team under those (migration 0003). Empty for everyone else.
export async function loadLedTeams(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase.rpc("app_led_team_ids");
  if (error) throw new Error(`Couldn't load the teams you lead: ${error.message}`);
  return (data as string[] | null) ?? [];
}

// Every team the viewer can see.
export async function loadTeams(supabase: SupabaseClient): Promise<TeamNode[]> {
  const { data, error } = await selectAll((after) => {
    let query = supabase.from("teams").select("id, name, archived_at, parent_id, kind, sort_order");
    if (after) query = query.gt("id", after);
    return query.order("id").limit(PAGE_SIZE).overrideTypes<TeamNode[], { merge: false }>();
  });
  if (error) throw new Error(`Couldn't load teams: ${error.message}`);
  return data;
}

async function loadCheckins(supabase: SupabaseClient, from: string, to: string): Promise<CheckinRow[]> {
  const { data, error } = await selectAll((after) => {
    let query = supabase
      .from("checkins")
      .select("id, team_id, week_start, activity_score, excellence_score, morale_score")
      .gte("week_start", from)
      .lte("week_start", to);
    if (after) query = query.gt("id", after);
    return query.order("id").limit(PAGE_SIZE);
  });
  if (error) throw new Error(`Couldn't load check-ins: ${error.message}`);
  return data;
}

export type TeamWeekCheckin = {
  id: string;
  memberName: string | null;
  teamId: string | null; // the team it was made in
  // That team's name, when it's a team under the page's ("IP Lab › IP Lab 1" on Gather's page);
  // null when it's the page's own team.
  team: string | null;
  activity_score: number | null;
  excellence_score: number | null;
  morale_score: number | null;
  rubric_review: string | null;
  transcript: string | null;
  // Where to play this check-in's recording from, when the viewer may play it (the speaker, or the
  // recordings grant; Storage decides). It signs a fresh link on every request (./recordings.ts).
  recording: string | null;
  // Whether it has a recording at all, played or not (for a Master Admin's delete control).
  hasRecording: boolean;
  // Submitted through the app and not graded yet: the grader still needs the recording.
  awaitingGrader: boolean;
};

// Team ids per request: about 3.7 kB of URL, well inside what PostgREST's gateway accepts.
const TEAM_BATCH = 100;

// One team's check-ins for one week, for the drill-in page, ordered team by team in org-chart
// order. As on the heat-map (./org.ts), a team the viewer covers takes in every team under it;
// otherwise it's only the team's own check-ins the viewer can read. teamId null means check-ins
// made while the member had no team.
export async function loadTeamWeek(
  supabase: SupabaseClient,
  teamId: string | null,
  week: string,
  covers: Coverage,
): Promise<{ teamName: string | null; context: string[]; checkins: TeamWeekCheckin[] }> {
  const teams = await loadTeams(supabase);
  const byId = new Map(teams.map((t) => [t.id, t]));
  const scope = teamId && covers(teamId) ? subtree(teams, teamId).map((t) => t.id) : [];
  const teamIds = scope.length > 0 ? scope : teamId ? [teamId] : [];

  // The team filter travels in the request's URL, so a big subtree is asked for a batch at a time.
  const batches: (string[] | null)[] = [];
  for (let i = 0; i < teamIds.length; i += TEAM_BATCH) batches.push(teamIds.slice(i, i + TEAM_BATCH));
  const results = await Promise.all(
    (teamId ? batches : [null]).map((ids) =>
      selectAll((after) => {
        let query = supabase
          .from("checkins")
          .select(
            "id, team_id, activity_score, excellence_score, morale_score, rubric_review, transcript, audio_path, submitted_at, graded_at, members(name)",
          )
          .eq("week_start", week);
        query = ids ? query.in("team_id", ids) : query.is("team_id", null);
        if (after) query = query.gt("id", after);
        return query.order("id").limit(PAGE_SIZE);
      }),
    ),
  );
  const failed = results.find((r) => r.error)?.error;
  if (failed) throw new Error(`Couldn't load check-ins: ${failed.message}`);
  const checkins = results.flatMap((r) => r.data ?? []);

  // One request for every recording, to show a player only where the viewer may play.
  const playable = await playableRecordings(
    supabase,
    checkins.flatMap((c) => (c.audio_path ? [c.audio_path] : [])),
  );

  // The path from below the page's team down to the check-in's.
  const teamLabel = (id: string | null) => {
    const team = id && id !== teamId ? byId.get(id) : undefined;
    if (!team) return null;
    const chain = lineage(byId, team);
    return chain
      .slice(chain.findIndex((t) => t.id === teamId) + 1)
      .map((t) => t.name)
      .join(" › ");
  };
  const order = new Map(teamIds.map((id, i) => [id, i]));

  const rows = checkins
    .map((c) => {
      // A to-one embed: PostgREST returns an object (or null if the viewer can't see the member).
      const member = c.members as unknown as { name: string } | null;
      const row: TeamWeekCheckin = {
        id: c.id,
        memberName: member?.name ?? null,
        teamId: c.team_id,
        team: teamLabel(c.team_id),
        activity_score: c.activity_score,
        excellence_score: c.excellence_score,
        morale_score: c.morale_score,
        rubric_review: c.rubric_review,
        transcript: c.transcript,
        recording: c.audio_path && playable.has(c.audio_path) ? recordingPath(c.id, c.audio_path) : null,
        hasRecording: c.audio_path !== null,
        awaitingGrader: c.submitted_at !== null && c.graded_at === null,
      };
      return { row, place: order.get(c.team_id ?? "") ?? 0 };
    })
    .sort((a, b) => a.place - b.place || (a.row.memberName ?? "").localeCompare(b.row.memberName ?? ""))
    .map(({ row }) => row);

  const team = teamId ? byId.get(teamId) : undefined;
  return { teamName: team?.name ?? null, context: team ? teamContext(teams, team.id) : [], checkins: rows };
}
