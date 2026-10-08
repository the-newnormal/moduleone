import type { SupabaseClient } from "@supabase/supabase-js";
import { type HealthConfig, type ScoringSettingsRow, settingsToConfig } from "@/lib/health/health";
import type { CheckinRow, TeamRow } from "./heatmap";

// Every loader here takes the signed-in user's client (src/lib/supabase/server.ts), never the
// service role: RLS decides what each viewer sees, so the dashboard shows exactly what they're
// allowed to read and nothing else.

export type Role = "member" | "leader" | "hq";

const SETTINGS_COLUMNS = [
  ...["activity", "excellence", "morale"].flatMap((m) => [1, 2, 3, 4, 5].map((s) => `${m}_${s}`)),
  "green_threshold",
  "yellow_threshold",
].join(",");

// PostgREST returns at most 1,000 rows per request (supabase/config.toml max_rows).
const PAGE_SIZE = 1000;

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

export async function loadHeatmapData(supabase: SupabaseClient, weeks: readonly string[]) {
  const [teams, checkins, config, role] = await Promise.all([
    loadTeams(supabase),
    loadCheckins(supabase, weeks[0], weeks[weeks.length - 1]),
    loadScoringConfig(supabase),
    loadRole(supabase),
  ]);
  return { teams, checkins, config, role };
}

async function loadTeams(supabase: SupabaseClient): Promise<TeamRow[]> {
  const { data, error } = await supabase.from("teams").select("id, name, division, archived_at");
  if (error) throw new Error(`Couldn't load teams: ${error.message}`);
  return data;
}

async function loadCheckins(supabase: SupabaseClient, from: string, to: string): Promise<CheckinRow[]> {
  const rows: CheckinRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("checkins")
      .select("team_id, week_start, activity_score, excellence_score, morale_score")
      .gte("week_start", from)
      .lte("week_start", to)
      .order("week_start")
      .order("id")
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`Couldn't load check-ins: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}

export type TeamWeekCheckin = {
  id: string;
  memberName: string | null;
  activity_score: number | null;
  excellence_score: number | null;
  morale_score: number | null;
  rubric_review: string | null;
  transcript: string | null;
  // A short-lived playback link, only when the viewer may play this recording (the speaker, or
  // the recordings grant). Storage checks that itself; a refused signature just means no player.
  recordingUrl: string | null;
};

const RECORDING_URL_SECONDS = 10 * 60;

// One team's check-ins for one week, for the drill-in page. teamId null means check-ins made
// while the member had no team.
export async function loadTeamWeek(
  supabase: SupabaseClient,
  teamId: string | null,
  week: string,
): Promise<{ teamName: string | null; division: string | null; checkins: TeamWeekCheckin[] }> {
  const teamQuery = teamId
    ? supabase.from("teams").select("name, division").eq("id", teamId).maybeSingle()
    : Promise.resolve({ data: null, error: null });

  let checkinQuery = supabase
    .from("checkins")
    .select(
      "id, activity_score, excellence_score, morale_score, rubric_review, transcript, audio_path, members(name)",
    )
    .eq("week_start", week);
  checkinQuery = teamId ? checkinQuery.eq("team_id", teamId) : checkinQuery.is("team_id", null);

  const [team, checkins] = await Promise.all([teamQuery, checkinQuery]);
  if (team.error) throw new Error(`Couldn't load the team: ${team.error.message}`);
  if (checkins.error) throw new Error(`Couldn't load check-ins: ${checkins.error.message}`);

  const rows = await Promise.all(
    checkins.data.map(async (c): Promise<TeamWeekCheckin> => {
      let recordingUrl: string | null = null;
      if (c.audio_path) {
        const { data } = await supabase.storage
          .from("checkin-audio")
          .createSignedUrl(c.audio_path, RECORDING_URL_SECONDS);
        recordingUrl = data?.signedUrl ?? null;
      }
      // A to-one embed: PostgREST returns an object (or null if the viewer can't see the member).
      const member = c.members as unknown as { name: string } | null;
      return {
        id: c.id,
        memberName: member?.name ?? null,
        activity_score: c.activity_score,
        excellence_score: c.excellence_score,
        morale_score: c.morale_score,
        rubric_review: c.rubric_review,
        transcript: c.transcript,
        recordingUrl,
      };
    }),
  );
  rows.sort((a, b) => (a.memberName ?? "").localeCompare(b.memberName ?? ""));

  return { teamName: team.data?.name ?? null, division: team.data?.division ?? null, checkins: rows };
}
