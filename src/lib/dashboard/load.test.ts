import { describe, expect, it } from "vitest";
import { loadTeamWeek } from "./load";
import { coverage } from "./org";

type Row = Record<string, unknown> & { id: string };

// Enough of PostgREST for the loaders: eq, in, is and gt filter the table's rows, limit caps them.
function fakeSupabase(tables: Record<string, Row[]>) {
  const queried: { table: string; filter: string; args: unknown[] }[] = [];
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    const query = {
      select: () => query,
      order: () => query,
      overrideTypes: () => query,
      eq: (column: string, value: unknown) => {
        queried.push({ table, filter: "eq", args: [column, value] });
        rows = rows.filter((r) => r[column] === value);
        return query;
      },
      in: (column: string, values: unknown[]) => {
        queried.push({ table, filter: "in", args: [column, values] });
        rows = rows.filter((r) => values.includes(r[column]));
        return query;
      },
      is: (column: string, value: null) => {
        queried.push({ table, filter: "is", args: [column, value] });
        rows = rows.filter((r) => r[column] === value);
        return query;
      },
      gt: (column: string, value: string) => {
        rows = rows.filter((r) => String(r[column]) > value);
        return query;
      },
      limit: (n: number) => {
        rows = rows.slice(0, n);
        return query;
      },
      then: (resolve: (result: { data: Row[]; error: null }) => unknown) => resolve({ data: rows, error: null }),
    };
    return query;
  };
  const storage = { from: () => ({ createSignedUrls: async () => ({ data: [], error: null }) }) };
  return { supabase: { from, storage } as never, queried };
}

const team = (id: string, name: string, kind: string, parent_id: string | null, sort_order = 0) => ({
  id,
  name,
  kind,
  parent_id,
  sort_order,
  archived_at: null,
});

const TEAMS = [
  team("ga", "Gather", "division", null),
  team("ip", "IP Lab", "domain", "ga", 0),
  team("bq", "Barbeques", "domain", "ga", 1),
  team("ip1", "IP Lab 1", "team", "ip", 0),
  team("ip2", "IP Lab 2", "team", "ip", 1),
  team("cu", "Culture", "division", null, 1),
  team("at", "Atlas", "domain", "cu"),
];

const WEEK = "2026-10-05";

let n = 0;
const checkin = (team_id: string | null, member: string, week_start = WEEK): Row => ({
  id: `c${String(++n).padStart(3, "0")}`,
  team_id,
  week_start,
  activity_score: 3,
  excellence_score: 3,
  morale_score: 3,
  rubric_review: null,
  transcript: null,
  audio_path: null,
  members: { name: member },
});

const CHECKINS = [
  checkin("bq", "Zed"),
  checkin("ip2", "Yan"),
  checkin("ip1", "Xia"),
  checkin("ip1", "Abe"),
  checkin("ip", "Wen"),
  checkin("at", "Vic"),
  checkin("ip1", "Old", "2026-09-28"),
  checkin(null, "Uma"),
];

describe("loadTeamWeek", () => {
  it("takes in every team under a covered team, team by team in org-chart order", async () => {
    const { supabase } = fakeSupabase({ teams: TEAMS, checkins: CHECKINS });
    const week = await loadTeamWeek(supabase, "ga", WEEK, coverage("hq", []));
    expect(week.teamName).toBe("Gather");
    expect(week.context).toEqual([]);
    expect(week.checkins.map((c) => [c.team, c.memberName])).toEqual([
      ["IP Lab", "Wen"],
      ["IP Lab › IP Lab 1", "Abe"],
      ["IP Lab › IP Lab 1", "Xia"],
      ["IP Lab › IP Lab 2", "Yan"],
      ["Barbeques", "Zed"],
    ]);
  });

  it("labels only the check-ins from teams under the page's own", async () => {
    const { supabase } = fakeSupabase({ teams: TEAMS, checkins: CHECKINS });
    const week = await loadTeamWeek(supabase, "ip", WEEK, coverage("hq", []));
    expect(week.context).toEqual(["Gather"]);
    expect(week.checkins.map((c) => [c.team, c.memberName])).toEqual([
      [null, "Wen"],
      ["IP Lab 1", "Abe"],
      ["IP Lab 1", "Xia"],
      ["IP Lab 2", "Yan"],
    ]);
  });

  it("asks only for the team's own check-ins when the viewer doesn't cover it", async () => {
    // A leader of IP Lab 1 opening IP Lab: RLS hides IP Lab's check-ins from them anyway, and the
    // query mustn't reach into the teams under it either, as the org chart doesn't.
    const { supabase, queried } = fakeSupabase({ teams: TEAMS, checkins: CHECKINS });
    const week = await loadTeamWeek(supabase, "ip", WEEK, coverage("leader", ["ip1"]));
    expect(queried).toContainEqual({ table: "checkins", filter: "in", args: ["team_id", ["ip"]] });
    expect(week.checkins.map((c) => c.memberName)).toEqual(["Wen"]);
  });

  it("reads check-ins made with no team for teamId null", async () => {
    const { supabase } = fakeSupabase({ teams: TEAMS, checkins: CHECKINS });
    const week = await loadTeamWeek(supabase, null, WEEK, coverage("hq", []));
    expect(week).toMatchObject({ teamName: null, context: [] });
    expect(week.checkins.map((c) => [c.team, c.memberName])).toEqual([[null, "Uma"]]);
  });
});
