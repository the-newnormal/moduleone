import { describe, expect, it } from "vitest";
import type { HealthConfig } from "@/lib/health/health";
import { NEEDS_A_LOOK_FOR_HQ, NEEDS_A_LOOK_LEADS, type RedSpot, redSpots, seesNeedsALook } from "./needs-a-look";
import { buildOrg, type CheckinRow, type Coverage, coverage, type OrgNode } from "./org";
import { subtree, type TeamNode } from "./tree";

// The portal's Needs a look tile: who gets it, and which boxes it names, over real org charts from
// buildOrg.

const RULES: HealthConfig = {
  activity: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 },
  excellence: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 },
  morale: { 1: 0.6, 2: 0.8, 3: 1.0, 4: 1.1, 5: 1.2 },
  thresholds: { green: 12, yellow: 6 },
};

const LAST_WEEK = "2026-09-28";
const THIS_WEEK = "2026-10-05";
const WEEKS = [LAST_WEEK, THIS_WEEK];

// Scores under RULES: green from 12, yellow from 6, red below.
type Scores = [number, number, number];
const TOP: Scores = [5, 5, 5]; // 30, green
const GREEN: Scores = [4, 4, 3]; // 16, green
const YELLOW: Scores = [3, 3, 3]; // 9, yellow
const RED: Scores = [2, 2, 3]; // 4, red
const LOW: Scores = [1, 1, 1]; // 0.6, red

const node = (
  id: string,
  name: string,
  kind: TeamNode["kind"],
  parent_id: string | null,
  sort_order = 0,
): TeamNode => ({ id, name, kind, parent_id, sort_order, archived_at: null });

const checkin = (team_id: string | null, week_start: string, scores: Scores | null): CheckinRow => ({
  team_id,
  week_start,
  activity_score: scores?.[0] ?? null,
  excellence_score: scores?.[1] ?? null,
  morale_score: scores?.[2] ?? null,
});

// The New Normal › Gather › IP Lab › IP Lab 1, IP Lab 2; Gather › Barbeques;
// The New Normal › Culture › Atlas › Atlas 1; Culture › Beacon.
// Skunkworks is an unplaced domain at the top level, outside the organisation (and ahead of it by
// name, so it comes first on the chart).
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
const ledIds = (...ids: string[]) => ids.flatMap((id) => subtree(TEAMS, id).map((t) => t.id));
const leads = (...ids: string[]) => coverage("leader", ledIds(...ids));
const HQ = coverage("hq", []);

const orgFor = (covers: Coverage, checkins: CheckinRow[]) =>
  buildOrg({ teams: TEAMS, checkins, weeks: WEEKS, config: RULES, covers });

const find = (nodes: readonly OrgNode[], id: string): OrgNode | undefined => {
  for (const n of nodes) {
    if (n.teamId === id) return n;
    const found = find(n.children, id);
    if (found) return found;
  }
};

const cellAt = (nodes: readonly OrgNode[], id: string, week: string) => find(nodes, id)!.cells.find((c) => c.week === week);

// A spot as people read it: where, under what, whether the box itself is red, and how many were.
const read = (spots: readonly RedSpot[]) =>
  spots.map((s) => ({ teamId: s.teamId, name: s.name, context: s.context, red: s.red, reds: s.cell.health?.bands.red }));

describe("NEEDS_A_LOOK_LEADS", () => {
  it("opens the tile to leaders of the organisation and of divisions only, and to hq", () => {
    expect([...NEEDS_A_LOOK_LEADS].sort()).toEqual(["division", "organisation"]);
    expect(NEEDS_A_LOOK_LEADS).not.toContain("domain");
    expect(NEEDS_A_LOOK_LEADS).not.toContain("team");
    expect(NEEDS_A_LOOK_FOR_HQ).toBe(true);
  });
});

describe("seesNeedsALook", () => {
  it("is never for a member or a viewer with no role, whatever teams they're handed", () => {
    expect(seesNeedsALook("member", TEAMS, [])).toBe(false);
    expect(seesNeedsALook(null, TEAMS, [])).toBe(false);
    // The role decides first: led teams alone never open it.
    expect(seesNeedsALook("member", TEAMS, ledIds("ga"))).toBe(false);
    expect(seesNeedsALook(null, TEAMS, ledIds("org"))).toBe(false);
  });

  it("is for hq, who lead nothing", () => {
    expect(seesNeedsALook("hq", TEAMS, [])).toBe(true);
  });

  it("isn't for the leader of a team", () => {
    expect(seesNeedsALook("leader", TEAMS, ledIds("ip1"))).toBe(false);
    expect(seesNeedsALook("leader", TEAMS, ledIds("ip1", "at1"))).toBe(false);
  });

  it("isn't for the leader of a domain, placed in a division or not", () => {
    expect(seesNeedsALook("leader", TEAMS, ledIds("ip"))).toBe(false);
    expect(seesNeedsALook("leader", TEAMS, ledIds("bq"))).toBe(false);
    expect(seesNeedsALook("leader", TEAMS, ledIds("sk"))).toBe(false);
  });

  it("is for the leader of a division", () => {
    expect(ledIds("cu")).toEqual(["cu", "at", "at1", "bc"]);
    expect(seesNeedsALook("leader", TEAMS, ledIds("cu"))).toBe(true);
  });

  it("is for the leader of the organisation, whose led teams are everything under it", () => {
    expect(ledIds("org")).toContain("ga");
    expect(seesNeedsALook("leader", TEAMS, ledIds("org"))).toBe(true);
  });

  it("is for a leader who sits in a team but is one of a division's leads (team_leads)", () => {
    expect(seesNeedsALook("leader", TEAMS, ledIds("ip1", "cu"))).toBe(true);
  });

  it("isn't for a former lead of a division that has since been archived", () => {
    // team_leads rows stay when a division is archived (0006), so app_led_team_ids still lists it.
    const old = { ...node("old", "Old Division", "division", "org"), archived_at: "2026-09-01T00:00:00Z" };
    expect(seesNeedsALook("leader", [...TEAMS, old], ["old", ...ledIds("ip1")])).toBe(false);
    expect(seesNeedsALook("leader", [...TEAMS, { ...old, archived_at: null }], ["old", ...ledIds("ip1")])).toBe(true);
  });

  it("isn't for a leader who leads nothing", () => {
    expect(seesNeedsALook("leader", TEAMS, [])).toBe(false);
  });
});

describe("redSpots", () => {
  it("names a red team once, at the team, not at the domain, division or organisation above it", () => {
    const org = orgFor(HQ, [
      checkin("ip1", THIS_WEEK, RED),
      checkin("ip2", THIS_WEEK, TOP),
      checkin("ip2", THIS_WEEK, TOP),
    ]);
    // Every box above IP Lab 1 has that red check-in in it, and is green overall.
    for (const id of ["ip", "ga", "org"]) {
      expect(cellAt(org.roots, id, THIS_WEEK)?.health).toMatchObject({ band: "green", bands: { red: 1 } });
    }

    const spots = redSpots(org.roots, THIS_WEEK);
    expect(read(spots)).toEqual([
      { teamId: "ip1", name: "IP Lab 1", context: ["Gather", "IP Lab"], red: true, reds: 1 },
    ]);
    expect(spots[0].cell).toBe(cellAt(org.roots, "ip1", THIS_WEEK));
  });

  it("names a green team with someone in it red, as not red itself", () => {
    const org = orgFor(HQ, [checkin("ip1", THIS_WEEK, TOP), checkin("ip1", THIS_WEEK, TOP), checkin("ip1", THIS_WEEK, RED)]);
    const spots = redSpots(org.roots, THIS_WEEK);
    expect(read(spots)).toEqual([
      { teamId: "ip1", name: "IP Lab 1", context: ["Gather", "IP Lab"], red: false, reds: 1 },
    ]);
    expect(spots[0].cell.health?.band).toBe("green");
  });

  it("names a domain whose own check-ins are red when the teams under it are not", () => {
    const org = orgFor(HQ, [
      checkin("ip", THIS_WEEK, LOW),
      checkin("ip", THIS_WEEK, LOW),
      checkin("ip1", THIS_WEEK, GREEN),
      // A domain with no teams under it is the smallest box there is.
      checkin("bq", THIS_WEEK, YELLOW),
      checkin("bq", THIS_WEEK, RED),
    ]);
    expect(read(redSpots(org.roots, THIS_WEEK))).toEqual([
      { teamId: "ip", name: "IP Lab", context: ["Gather"], red: true, reds: 2 },
      { teamId: "bq", name: "Barbeques", context: ["Gather"], red: false, reds: 1 },
    ]);
  });

  it("names a domain too when red check-ins were made in it directly, as well as the red team under it", () => {
    // IP Lab 1's red is in IP Lab 1's spot; the domain's own red is in no box under it.
    const org = orgFor(HQ, [checkin("ip", THIS_WEEK, LOW), checkin("ip1", THIS_WEEK, RED)]);
    expect(read(redSpots(org.roots, THIS_WEEK)).map((s) => s.teamId).sort()).toEqual(["ip", "ip1"]);
  });

  it("names a division head's own red check-in at the division even when a team under it is red too", () => {
    const org = orgFor(HQ, [checkin("ga", THIS_WEEK, RED), checkin("ip1", THIS_WEEK, RED)]);
    expect(read(redSpots(org.roots, THIS_WEEK)).map((s) => s.teamId).sort()).toEqual(["ga", "ip1"]);
  });

  it("doesn't name the boxes above a red team when their only reds are that team's", () => {
    const org = orgFor(HQ, [checkin("ip1", THIS_WEEK, LOW), checkin("ip1", THIS_WEEK, RED), checkin("ip2", THIS_WEEK, GREEN)]);
    expect(read(redSpots(org.roots, THIS_WEEK)).map((s) => s.teamId)).toEqual(["ip1"]);
  });

  it("names a division head's own red check-in at the division, with no organisation above it", () => {
    const org = orgFor(HQ, [checkin("ga", THIS_WEEK, RED), checkin("ip1", THIS_WEEK, GREEN)]);
    expect(read(redSpots(org.roots, THIS_WEEK))).toEqual([
      { teamId: "ga", name: "Gather", context: [], red: false, reds: 1 },
    ]);
  });

  it("names the organisation itself only for a red check-in made there, with no context", () => {
    const org = orgFor(HQ, [checkin("org", THIS_WEEK, RED)]);
    expect(read(redSpots(org.roots, THIS_WEEK))).toEqual([
      { teamId: "org", name: "The New Normal", context: [], red: true, reds: 1 },
    ]);
  });

  it("keeps an unplaced domain's name, which is outside the organisation", () => {
    const org = orgFor(HQ, [checkin("sk1", THIS_WEEK, RED)]);
    expect(read(redSpots(org.roots, THIS_WEEK))).toEqual([
      { teamId: "sk1", name: "Skunkworks 1", context: ["Skunkworks"], red: true, reds: 1 },
    ]);
  });

  it("is empty when nobody was red, including weeks still waiting for the grader", () => {
    expect(redSpots(orgFor(HQ, []).roots, THIS_WEEK)).toEqual([]);
    const org = orgFor(HQ, [
      checkin("ip1", THIS_WEEK, GREEN),
      checkin("ip2", THIS_WEEK, YELLOW),
      checkin("at1", THIS_WEEK, null),
      checkin("sk1", THIS_WEEK, TOP),
      checkin("ga", THIS_WEEK, YELLOW),
    ]);
    expect(cellAt(org.roots, "at1", THIS_WEEK)).toMatchObject({ health: null, pending: 1 });
    expect(redSpots(org.roots, THIS_WEEK)).toEqual([]);
  });

  it("walks through the boxes a leader doesn't cover, never naming them", () => {
    // A domain lead sees the organisation and the division above IP Lab only to place it.
    const domain = orgFor(leads("ip"), [checkin("ip1", THIS_WEEK, RED), checkin("ip2", THIS_WEEK, GREEN)]);
    expect([find(domain.roots, "org")?.scored, find(domain.roots, "ga")?.scored, find(domain.roots, "ip")?.scored]).toEqual([
      false,
      false,
      true,
    ]);
    expect(read(redSpots(domain.roots, THIS_WEEK))).toEqual([
      { teamId: "ip1", name: "IP Lab 1", context: ["IP Lab"], red: true, reds: 1 },
    ]);

    // A leader of two teams covers nothing above them, so neither has any context.
    const teams = orgFor(leads("ip1", "at1"), [
      checkin("ip1", THIS_WEEK, RED),
      checkin("at1", THIS_WEEK, RED),
      checkin("at1", THIS_WEEK, LOW),
    ]);
    const spots = redSpots(teams.roots, THIS_WEEK);
    expect(read(spots)).toEqual([
      { teamId: "at1", name: "Atlas 1", context: [], red: true, reds: 2 },
      { teamId: "ip1", name: "IP Lab 1", context: [], red: true, reds: 1 },
    ]);
    const uncovered = ["org", "ga", "ip", "cu", "at"];
    expect(spots.some((s) => uncovered.includes(s.teamId))).toBe(false);
  });

  it("puts red boxes first, then the most red check-ins", () => {
    const org = orgFor(HQ, [
      // Skunkworks 1, first on the chart: yellow, one red.
      checkin("sk1", THIS_WEEK, GREEN),
      checkin("sk1", THIS_WEEK, YELLOW),
      checkin("sk1", THIS_WEEK, RED),
      // IP Lab 1: green, two red.
      checkin("ip1", THIS_WEEK, TOP),
      checkin("ip1", THIS_WEEK, TOP),
      checkin("ip1", THIS_WEEK, TOP),
      checkin("ip1", THIS_WEEK, LOW),
      checkin("ip1", THIS_WEEK, LOW),
      // Barbeques: red, two red.
      checkin("bq", THIS_WEEK, RED),
      checkin("bq", THIS_WEEK, RED),
      // Atlas 1, last on the chart: red, one red.
      checkin("at1", THIS_WEEK, RED),
    ]);
    expect(read(redSpots(org.roots, THIS_WEEK)).map((s) => [s.teamId, s.red, s.reds])).toEqual([
      ["bq", true, 2],
      ["at1", true, 1],
      ["ip1", false, 2],
      ["sk1", false, 1],
    ]);
  });

  it("looks only at the week asked for", () => {
    const org = orgFor(HQ, [checkin("ip1", LAST_WEEK, RED), checkin("at1", THIS_WEEK, RED), checkin("at1", LAST_WEEK, GREEN)]);
    expect(read(redSpots(org.roots, THIS_WEEK)).map((s) => s.teamId)).toEqual(["at1"]);
    expect(read(redSpots(org.roots, LAST_WEEK)).map((s) => s.teamId)).toEqual(["ip1"]);
    // A week the chart doesn't cover has no cells to look at.
    expect(redSpots(org.roots, "2026-09-21")).toEqual([]);
  });

  it("never names a leader's own red check-ins in teams they don't lead, or hq's with no team", () => {
    // org.loose holds those rows; redSpots is handed the scored tree only.
    const leader = orgFor(leads("ip1"), [
      checkin("ip1", THIS_WEEK, GREEN),
      checkin("bq", THIS_WEEK, RED), // their own, from Barbeques
      checkin(null, THIS_WEEK, LOW),
    ]);
    expect(leader.loose.map((r) => [r.teamId, r.cells.find((c) => c.week === THIS_WEEK)?.health?.band])).toEqual([
      ["bq", "red"],
      [null, "red"],
    ]);
    expect(redSpots(leader.roots, THIS_WEEK)).toEqual([]);

    const hq = orgFor(HQ, [checkin(null, THIS_WEEK, RED), checkin("ip1", THIS_WEEK, GREEN)]);
    expect(hq.loose.map((r) => r.teamId)).toEqual([null]);
    expect(redSpots(hq.roots, THIS_WEEK)).toEqual([]);
  });
});
