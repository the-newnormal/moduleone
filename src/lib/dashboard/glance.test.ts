import { describe, expect, it } from "vitest";
import type { HealthConfig } from "@/lib/health/health";
import { type Glance, glance, weekTally } from "./glance";
import { buildOrg, type CheckinRow, type Coverage, coverage, type OrgNode } from "./org";
import { subtree, type TeamNode } from "./tree";

// The portal's Team health tile, over real org charts from buildOrg: which boxes it leads with, and
// how many check-ins it says the viewer covers.

const RULES: HealthConfig = {
  activity: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 },
  excellence: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 },
  morale: { 1: 0.6, 2: 0.8, 3: 1.0, 4: 1.1, 5: 1.2 },
  thresholds: { green: 12, yellow: 6 },
};

const LAST_WEEK = "2026-09-28";
const THIS_WEEK = "2026-10-05";
const WEEKS = [LAST_WEEK, THIS_WEEK];

const node = (
  id: string,
  name: string,
  kind: TeamNode["kind"],
  parent_id: string | null,
  sort_order = 0,
): TeamNode => ({ id, name, kind, parent_id, sort_order, archived_at: null });

const checkin = (team_id: string | null, week_start: string, scores: [number, number, number] | null): CheckinRow => ({
  team_id,
  week_start,
  activity_score: scores?.[0] ?? null,
  excellence_score: scores?.[1] ?? null,
  morale_score: scores?.[2] ?? null,
});

// The New Normal › Gather › IP Lab › IP Lab 1, IP Lab 2; Gather › Barbeques;
// The New Normal › Culture › Atlas › Atlas 1; Culture › Beacon.
// Skunkworks is an unplaced domain at the top level, outside the organisation. It sorts ahead of
// the organisation by name, so the glance has to find the organisation by kind, not by position.
const TEAMS = [
  node("org", "The New Normal", "organisation", null),
  node("ga", "Gather", "division", "org", 0),
  node("ip", "IP Lab", "domain", "ga", 0),
  node("ip1", "IP Lab 1", "team", "ip", 0),
  node("ip2", "IP Lab 2", "team", "ip", 1),
  node("bq", "Barbeques", "domain", "ga", 1),
  node("cu", "Culture", "division", "org", 1),
  node("at", "Atlas", "domain", "cu", 0),
  node("at1", "Atlas 1", "team", "at", 0),
  node("bc", "Beacon", "domain", "cu", 1),
  node("sk", "Skunkworks", "domain", null),
  node("sk1", "Skunkworks 1", "team", "sk"),
];

// What app_led_team_ids gives a leader: the teams they lead and every team under those.
const leads = (...ids: string[]) => coverage("leader", ids.flatMap((id) => subtree(TEAMS, id).map((t) => t.id)));
const HQ = coverage("hq", []);

const orgFor = (covers: Coverage, checkins: CheckinRow[] = [], teams: readonly TeamNode[] = TEAMS) =>
  buildOrg({ teams, checkins, weeks: WEEKS, config: RULES, covers });

const names = (nodes: readonly OrgNode[]) => nodes.map((n) => n.name);

// Every team the glance shows, at any depth, so nothing can slip in under a row.
const shownIds = (g: Glance): (string | null)[] => {
  const walk = (n: OrgNode): string[] => [n.teamId, ...n.children.flatMap(walk)];
  return [...(g.summary ? walk(g.summary) : []), ...g.rows.flatMap(walk), ...g.other.flatMap(walk)];
};

describe("glance", () => {
  it("shows hq the organisation, its divisions as rows, and unplaced domains apart", () => {
    const g = glance(orgFor(HQ));
    expect(g.summary).toMatchObject({ teamId: "org", kind: "organisation", scored: true });
    expect(names(g.rows)).toEqual(["Gather", "Culture"]);
    expect(names(g.other)).toEqual(["Skunkworks"]);
    expect(g.more).toBe(0);
  });

  it("shows a division head their division, with its domains as rows", () => {
    // The organisation above Culture is on their chart only to place it, uncoloured: not a summary.
    const org = orgFor(leads("cu"));
    expect(org.roots.map((n) => [n.name, n.scored])).toEqual([["The New Normal", false]]);

    const g = glance(org);
    expect(g.summary).toMatchObject({ teamId: "cu", kind: "division", scored: true });
    expect(names(g.rows)).toEqual(["Atlas", "Beacon"]);
    expect(g.other).toEqual([]);
    expect(g.more).toBe(0);
  });

  it("shows a domain lead their domain, with its teams as rows", () => {
    const g = glance(orgFor(leads("ip")));
    expect(g.summary).toMatchObject({ teamId: "ip", kind: "domain" });
    expect(names(g.rows)).toEqual(["IP Lab 1", "IP Lab 2"]);
    expect(g.other).toEqual([]);
  });

  it("lists a leader's teams as rows, with no summary, when the domain above them isn't theirs", () => {
    const g = glance(orgFor(leads("ip1", "ip2")));
    expect(g).toMatchObject({ summary: null, other: [], more: 0 });
    expect(names(g.rows)).toEqual(["IP Lab 1", "IP Lab 2"]);
    expect(g.rows.every((n) => n.scored)).toBe(true);
  });

  it("shows the lead of a single team that team as a row, not as a summary over nothing", () => {
    const g = glance(orgFor(leads("ip1")));
    expect(g).toMatchObject({ summary: null, other: [], more: 0 });
    expect(names(g.rows)).toEqual(["IP Lab 1"]);
  });

  it("lists the top box of each branch for a leader of two unrelated branches", () => {
    // Neither is above the other, so there's no one box to lead with.
    const g = glance(orgFor(leads("ip", "at1")));
    expect(g.summary).toBeNull();
    expect(names(g.rows)).toEqual(["IP Lab", "Atlas 1"]);
  });

  it("caps rows first, then other, at the limit, and counts what it left out", () => {
    const org = orgFor(HQ);
    const three = glance(org, 3);
    expect([names(three.rows), names(three.other), three.more]).toEqual([["Gather", "Culture"], ["Skunkworks"], 0]);
    // The divisions take the room before the unplaced domains do.
    const two = glance(org, 2);
    expect([names(two.rows), names(two.other), two.more]).toEqual([["Gather", "Culture"], [], 1]);
    const one = glance(org, 1);
    expect([names(one.rows), names(one.other), one.more]).toEqual([["Gather"], [], 2]);
    // The summary is shown whatever the limit; it isn't one of the rows.
    expect(one.summary?.teamId).toBe("org");
  });

  it("shows six rows by default", () => {
    const many = [
      node("dv", "Delivery", "domain", null),
      ...Array.from({ length: 8 }, (_, i) => node(`d${i}`, `Delivery ${i}`, "team", "dv", i)),
    ];
    const g = glance(orgFor(coverage("leader", many.slice(1).map((t) => t.id)), [], many));
    expect(g.summary).toBeNull();
    expect(names(g.rows)).toEqual(["Delivery 0", "Delivery 1", "Delivery 2", "Delivery 3", "Delivery 4", "Delivery 5"]);
    expect(g.more).toBe(2);
  });

  it("is empty when there's nothing to show", () => {
    const empty = { summary: null, rows: [], other: [], more: 0 };
    expect(glance(orgFor(HQ, [], []))).toEqual(empty);
    // A leader who leads nothing still has their own check-ins on the org chart, as loose rows;
    // those are their own grades, not a team's health, so the glance stays empty.
    const org = orgFor(coverage("leader", []), [checkin("bq", THIS_WEEK, [4, 4, 3]), checkin(null, THIS_WEEK, [3, 3, 3])]);
    expect(org.loose.map((r) => r.teamId)).toEqual(["bq", null]);
    expect(glance(org)).toEqual(empty);
  });

  it("never shows a leader's own check-ins in a team they don't lead, or check-ins with no team", () => {
    const org = orgFor(leads("ip1", "ip2"), [
      checkin("ip1", THIS_WEEK, [4, 4, 3]),
      checkin("bq", THIS_WEEK, [2, 2, 2]), // their own, from Barbeques
      checkin(null, THIS_WEEK, [3, 3, 3]),
    ]);
    expect(org.loose.map((r) => r.teamId)).toEqual(["bq", null]);

    const g = glance(org);
    expect(shownIds(g)).toEqual(["ip1", "ip2"]);
    expect(shownIds(g)).not.toContain(null);
  });

  it("keeps hq's check-ins with no team on the Team health page, out of the glance", () => {
    const org = orgFor(HQ, [checkin(null, THIS_WEEK, [3, 3, 3]), checkin("ip1", THIS_WEEK, [4, 4, 3])]);
    expect(org.loose.map((r) => r.teamId)).toEqual([null]);

    const g = glance(org);
    expect(shownIds(g)).not.toContain(null);
    expect(names(g.rows)).toEqual(["Gather", "Culture"]);
    expect(names(g.other)).toEqual(["Skunkworks"]);
  });
});

describe("weekTally", () => {
  it("counts every check-in of the week for hq, those made with no team included", () => {
    const checkins = [
      checkin("ip1", THIS_WEEK, [4, 4, 3]),
      checkin(null, THIS_WEEK, [3, 3, 3]),
      checkin("sk1", THIS_WEEK, null),
    ];
    expect(weekTally(checkins, THIS_WEEK, "hq", HQ)).toEqual({ checkins: 3, pending: 1 });
  });

  it("counts only a leader's own teams, not their check-ins elsewhere or those with no team", () => {
    const checkins = [
      checkin("ip1", THIS_WEEK, [4, 4, 3]),
      checkin("ip2", THIS_WEEK, null),
      checkin("bq", THIS_WEEK, [2, 2, 2]), // their own, in a team they don't lead
      checkin(null, THIS_WEEK, null),
    ];
    expect(weekTally(checkins, THIS_WEEK, "leader", leads("ip1", "ip2"))).toEqual({ checkins: 2, pending: 1 });
  });

  it("counts only the week asked for", () => {
    const checkins = [checkin("ip1", LAST_WEEK, [4, 4, 3]), checkin("ip1", LAST_WEEK, null), checkin("ip1", "2026-09-21", null)];
    expect(weekTally(checkins, THIS_WEEK, "hq", HQ)).toEqual({ checkins: 0, pending: 0 });
    expect(weekTally(checkins, LAST_WEEK, "hq", HQ)).toEqual({ checkins: 2, pending: 1 });
  });

  it("counts as pending only a check-in the grader hasn't scored at all", () => {
    const partly: CheckinRow = { ...checkin("ip1", THIS_WEEK, null), activity_score: 3 };
    const checkins = [checkin("ip1", THIS_WEEK, null), partly, checkin("ip1", THIS_WEEK, [4, 4, 3])];
    expect(weekTally(checkins, THIS_WEEK, "hq", HQ)).toEqual({ checkins: 3, pending: 1 });
  });

  it("counts a check-in once, though every box above its team covers it too", () => {
    // Atlas 1 sits under Atlas and Culture, all three covered: adding up those boxes would count
    // each check-in three times.
    const checkins = [checkin("at1", THIS_WEEK, [4, 4, 3]), checkin("at1", THIS_WEEK, null), checkin("at", THIS_WEEK, [3, 3, 3])];
    expect(weekTally(checkins, THIS_WEEK, "leader", leads("cu"))).toEqual({ checkins: 3, pending: 1 });
  });

  it("counts nothing for a viewer who is neither a leader nor hq", () => {
    const checkins = [checkin("ip1", THIS_WEEK, [4, 4, 3]), checkin(null, THIS_WEEK, null)];
    expect(weekTally(checkins, THIS_WEEK, "member", coverage("member", []))).toEqual({ checkins: 0, pending: 0 });
    expect(weekTally(checkins, THIS_WEEK, null, coverage(null, []))).toEqual({ checkins: 0, pending: 0 });
  });
});
