import { describe, expect, it } from "vitest";
import type { HealthConfig } from "@/lib/health/health";
import { buildOrg, type CheckinRow, coverage } from "./org";
import { domainTeamCounts } from "./summary";
import type { TeamNode } from "./tree";

const RULES: HealthConfig = {
  activity: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 },
  excellence: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 },
  morale: { 1: 0.6, 2: 0.8, 3: 1.0, 4: 1.1, 5: 1.2 },
  thresholds: { green: 12, yellow: 6 },
};

const WEEKS = ["2026-09-28", "2026-10-05"];
const [LAST_WEEK, THIS_WEEK] = WEEKS;

const node = (id: string, kind: TeamNode["kind"], parent_id: string | null): TeamNode => ({
  id,
  name: id,
  kind,
  parent_id,
  sort_order: 0,
  archived_at: null,
});

const checkin = (team_id: string | null, week_start: string, scores: [number, number, number] | null): CheckinRow => ({
  team_id,
  week_start,
  activity_score: scores?.[0] ?? null,
  excellence_score: scores?.[1] ?? null,
  morale_score: scores?.[2] ?? null,
});

const GREEN: [number, number, number] = [4, 4, 4]; // 17.6
const YELLOW: [number, number, number] = [3, 3, 3]; // 9
const RED: [number, number, number] = [1, 1, 1]; // 0.6

// The organisation › Gather › IP Lab › IP Lab 1, IP Lab 2; Gather › Barbeques, Dinners; an unplaced
// domain, Atlas, at the top level.
const TEAMS = [
  node("org", "organisation", null),
  node("ga", "division", "org"),
  node("ip", "domain", "ga"),
  node("ip1", "team", "ip"),
  node("ip2", "team", "ip"),
  node("bq", "domain", "ga"),
  node("dn", "domain", "ga"),
  node("at", "domain", null),
];

const CHECKINS = [
  checkin("org", THIS_WEEK, RED), // the organisation's and Gather's own: not domains or teams
  checkin("ga", THIS_WEEK, RED),
  checkin("ip1", THIS_WEEK, GREEN),
  checkin("ip2", THIS_WEEK, YELLOW), // IP Lab: (17.6 + 9) / 2 = 13.3, green
  checkin("bq", THIS_WEEK, RED),
  checkin("dn", LAST_WEEK, GREEN), // nothing this week
  checkin("at", THIS_WEEK, YELLOW),
];

const counts = (covers: (id: string) => boolean, checkins = CHECKINS) =>
  domainTeamCounts(buildOrg({ teams: TEAMS, checkins, weeks: WEEKS, config: RULES, covers }));

describe("domainTeamCounts", () => {
  it("counts every domain and team box by its colour in the last week, the organisation and divisions aside", () => {
    // IP Lab and IP Lab 1 green, IP Lab 2 and Atlas yellow, Barbeques red, Dinners nothing graded.
    expect(counts(coverage("hq", []))).toEqual({ green: 2, yellow: 2, red: 1, ungraded: 1 });
  });

  it("counts a week waiting for the grader as ungraded", () => {
    const waiting = [...CHECKINS, checkin("dn", THIS_WEEK, null)];
    expect(counts(coverage("hq", []), waiting)).toEqual({ green: 2, yellow: 2, red: 1, ungraded: 1 });
  });

  it("counts only the boxes a leader leads, not the domain above them or their own check-ins elsewhere", () => {
    // RLS gives the leader IP Lab 1 and IP Lab 2's check-ins, and their own in Barbeques.
    const seen = [checkin("ip1", THIS_WEEK, GREEN), checkin("ip2", THIS_WEEK, RED), checkin("bq", THIS_WEEK, RED)];
    expect(counts(coverage("leader", ["ip1", "ip2"]), seen)).toEqual({ green: 1, yellow: 0, red: 1, ungraded: 0 });
  });

  it("is all zeros with nothing to show", () => {
    expect(domainTeamCounts({ roots: [], loose: [] })).toEqual({ green: 0, yellow: 0, red: 0, ungraded: 0 });
  });
});
