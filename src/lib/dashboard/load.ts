import type { SupabaseClient } from "@supabase/supabase-js";
import { type HealthConfig, type ScoringSettingsRow, settingsToConfig } from "@/lib/health/health";
import type { CheckinRow } from "./heatmap";
import { playableRecordings, recordingPath } from "./recordings";
import { PAGE_SIZE, selectAll } from "./select-all";
import { type TeamNode, teamContext } from "./tree";

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

export async function loadHeatmapData(supabase: SupabaseClient, weeks: readonly string[]) {
  const [teams, checkins, config, role, ownTeam, ledTeams] = await Promise.all([
    loadTeams(supabase),
    loadCheckins(supabase, weeks[0], weeks[weeks.length - 1]),
    loadScoringConfig(supabase),
    loadRole(supabase),
    loadOwnTeam(supabase),
    loadLedTeams(supabase),
  ]);
  return { teams, checkins, config, role, ownTeam, ledTeams };
}

async function loadOwnTeam(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase.rpc("app_current_team");
  if (error) throw new Error(`Couldn't load your team: ${error.message}`);
  return (data as string | null) ?? null;
}

const UNKNOWN_FUNCTION = "PGRST202";

// The teams whose check-ins a leader reads: their own plus any they lead (migration 0003's
// team_leads); empty for everyone else. Before 0003 the function doesn't exist yet.
async function loadLedTeams(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase.rpc("app_led_team_ids");
  if (error?.code === UNKNOWN_FUNCTION) return [];
  if (error) throw new Error(`Couldn't load the teams you lead: ${error.message}`);
  return (data as string[] | null) ?? [];
}

const TREE_COLUMNS = "id, name, archived_at, parent_id, kind, sort_order";
const UNDEFINED_COLUMN = "42703";

// Every team the viewer can see. Before migration 0003 there's no team tree, so the tree columns
// don't exist yet: load the free-text division instead (see ./tree.ts). Drop that once 0003 is in.
export async function loadTeams(supabase: SupabaseClient): Promise<TeamNode[]> {
  const teams = (columns: string) =>
    selectAll((after) => {
      let query = supabase.from("teams").select(columns);
      if (after) query = query.gt("id", after);
      return query.order("id").limit(PAGE_SIZE).overrideTypes<TeamNode[], { merge: false }>();
    });

  const tree = await teams(TREE_COLUMNS);
  if (!tree.error) return tree.data.map((t) => ({ ...t, division: null }));
  if (tree.error.code !== UNDEFINED_COLUMN) throw new Error(`Couldn't load teams: ${tree.error.message}`);

  const flat = await teams("id, name, archived_at, division");
  if (flat.error) throw new Error(`Couldn't load teams: ${flat.error.message}`);
  return flat.data.map((t) => ({ ...t, parent_id: null, kind: null, sort_order: null }));
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
  activity_score: number | null;
  excellence_score: number | null;
  morale_score: number | null;
  rubric_review: string | null;
  transcript: string | null;
  // Where to play this check-in's recording from, when the viewer may play it (the speaker, or the
  // recordings grant; Storage decides). It signs a fresh link on every request (./recordings.ts).
  recording: string | null;
};

// One team's check-ins for one week, for the drill-in page. teamId null means check-ins made
// while the member had no team.
export async function loadTeamWeek(
  supabase: SupabaseClient,
  teamId: string | null,
  week: string,
): Promise<{ teamName: string | null; context: string[]; checkins: TeamWeekCheckin[] }> {
  const checkinQuery = selectAll((after) => {
    let query = supabase
      .from("checkins")
      .select(
        "id, activity_score, excellence_score, morale_score, rubric_review, transcript, audio_path, members(name)",
      )
      .eq("week_start", week);
    query = teamId ? query.eq("team_id", teamId) : query.is("team_id", null);
    if (after) query = query.gt("id", after);
    return query.order("id").limit(PAGE_SIZE);
  });

  const [teams, checkins] = await Promise.all([loadTeams(supabase), checkinQuery]);
  if (checkins.error) throw new Error(`Couldn't load check-ins: ${checkins.error.message}`);

  // One request for every recording, to show a player only where the viewer may play.
  const playable = await playableRecordings(
    supabase,
    checkins.data.flatMap((c) => (c.audio_path ? [c.audio_path] : [])),
  );

  const rows = checkins.data.map((c): TeamWeekCheckin => {
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
      recording: c.audio_path && playable.has(c.audio_path) ? recordingPath(c.id, c.audio_path) : null,
    };
  });
  rows.sort((a, b) => (a.memberName ?? "").localeCompare(b.memberName ?? ""));

  const team = teamId ? teams.find((t) => t.id === teamId) : undefined;
  return { teamName: team?.name ?? null, context: team ? teamContext(teams, team.id) : [], checkins: rows };
}
