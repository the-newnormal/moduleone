import { describe, expect, it } from "vitest";
import type { HealthConfig } from "@/lib/health/health";
import { buildOrg, type CheckinRow, coverage, type OrgNode } from "./org";
import type { TeamNode } from "./tree";

const RULES: HealthConfig = {
  activity: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 },
  excellence: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 },
  morale: { 1: 0.6, 2: 0.8, 3: 1.0, 4: 1.1, 5: 1.2 },
  thresholds: { green: 12, yellow: 6 },
};

const WEEKS = ["2026-09-28", "2026-10-05"];

const node = (
  id: string,
  name: string,
  kind: TeamNode["kind"],
  parent_id: string | null,
  sort_order = 0,
  archived = false,
): TeamNode => ({ id, name, kind, parent_id, sort_order, archived_at: archived ? "2026-09-01T00:00:00Z" : null });

const checkin = (team_id: string | null, week_start: string, scores: [number, number, number] | null): CheckinRow => ({
  team_id,
  week_start,
  activity_score: scores?.[0] ?? null,
  excellence_score: scores?.[1] ?? null,
  morale_score: scores?.[2] ?? null,
});

// Gather › IP Lab › IP Lab 1, IP Lab 2; Gather › Barbeques; Culture › Atlas.
const TEAMS = [
  node("cu", "Culture", "division", null, 1),
  node("ga", "Gather", "division", null, 0),
  node("bq", "Barbeques", "domain", "ga", 1),
  node("ip", "IP Lab", "domain", "ga", 0),
  node("ip2", "IP Lab 2", "team", "ip", 1),
  node("ip1", "IP Lab 1", "team", "ip", 0),
  node("at", "Atlas", "domain", "cu", 0),
];

const everyone = () => true;

// The tree as [name, scored, children] for comparing shapes.
type Shape = [string, boolean, Shape[]];
const shape = (n: OrgNode): Shape => [n.name, n.scored, n.children.map(shape)];
const find = (nodes: readonly OrgNode[], id: string): OrgNode | undefined => {
  for (const n of nodes) {
    if (n.teamId === id) return n;
    const found = find(n.children, id);
    if (found) return found;
  }
};

describe("buildOrg", () => {
  it("lays out every team in org-chart order for hq", () => {
    const org = buildOrg({ teams: TEAMS, checkins: [], weeks: WEEKS, config: RULES, covers: everyone });
    expect(org.roots.map(shape)).toEqual([
      [
        "Gather",
        true,
        [
          ["IP Lab", true, [["IP Lab 1", true, []], ["IP Lab 2", true, []]]],
          ["Barbeques", true, []],
        ],
      ],
      ["Culture", true, [["Atlas", true, []]]],
    ]);
    expect(org.loose).toEqual([]);
    expect(find(org.roots, "ip1")!.cells).toEqual([
      { week: "2026-09-28", health: null, pending: 0 },
      { week: "2026-10-05", health: null, pending: 0 },
    ]);
  });

  it("rolls every check-in up into the teams above it, one check-in one vote", () => {
    const org = buildOrg({
      teams: TEAMS,
      checkins: [
        checkin("ip1", "2026-10-05", [4, 3, 3]), // 12, green
        checkin("ip1", "2026-10-05", [4, 4, 3]), // 16, green
        checkin("ip2", "2026-10-05", [2, 2, 3]), // 4, red
        checkin("ip2", "2026-10-05", null),
        checkin("bq", "2026-09-28", [3, 3, 3]), // 9, yellow
        checkin("at", "2026-10-05", [1, 1, 1]), // Culture's, not Gather's
      ],
      weeks: WEEKS,
      config: RULES,
      covers: everyone,
    });
    const week = (id: string) => find(org.roots, id)!.cells[1];

    expect(week("ip1")).toMatchObject({ health: { band: "green", score: 14, graded: 2 }, pending: 0 });
    expect(week("ip2")).toMatchObject({ health: { band: "red", score: 4, graded: 1 }, pending: 1 });
    expect(week("ip")).toEqual({
      week: "2026-10-05",
      health: { band: "yellow", score: 32 / 3, graded: 3, bands: { green: 2, yellow: 0, red: 1 } },
      pending: 1,
    });
    expect(week("ga")).toMatchObject({ health: { score: 32 / 3, graded: 3 }, pending: 1 });
    expect(find(org.roots, "ga")!.cells[0]).toMatchObject({ health: { band: "yellow", score: 9, graded: 1 } });
    expect(week("cu")).toMatchObject({ health: { band: "red", graded: 1 } });
  });

  it("counts a domain's own check-ins along with its teams'", () => {
    const org = buildOrg({
      teams: TEAMS,
      checkins: [checkin("ip", "2026-10-05", [5, 5, 5]), checkin("ip1", "2026-10-05", [2, 2, 3])],
      weeks: WEEKS,
      config: RULES,
      covers: everyone,
    });
    expect(find(org.roots, "ip")!.cells[1].health).toMatchObject({ score: (30 + 4) / 2, graded: 2 });
    expect(find(org.roots, "ip1")!.cells[1].health).toMatchObject({ score: 4, graded: 1 });
  });

  it("leaves out check-ins outside the weeks shown", () => {
    const org = buildOrg({
      teams: TEAMS,
      checkins: [checkin("ip1", "2026-09-21", [1, 1, 1]), checkin(null, "2026-09-21", [1, 1, 1])],
      weeks: WEEKS,
      config: RULES,
      covers: everyone,
    });
    expect(find(org.roots, "ga")!.cells.every((c) => c.health === null && c.pending === 0)).toBe(true);
    expect(org.loose).toEqual([]);
  });

  it("shows an archived team only while it has check-ins in range, and still rolls them up", () => {
    const teams = [...TEAMS, node("old", "IP Lab 0", "team", "ip", 2, true)];
    const quiet = buildOrg({ teams, checkins: [], weeks: WEEKS, config: RULES, covers: everyone });
    expect(find(quiet.roots, "old")).toBeUndefined();

    const busy = buildOrg({
      teams,
      checkins: [checkin("old", "2026-09-28", [3, 3, 3])],
      weeks: WEEKS,
      config: RULES,
      covers: everyone,
    });
    expect(find(busy.roots, "old")).toMatchObject({ archived: true, scored: true });
    expect(find(busy.roots, "ip")!.cells[0].health).toMatchObject({ score: 9, graded: 1 });
  });

  it("shows a leader only what they lead, with the division and domain above it uncoloured", () => {
    // A leader of IP Lab 1 who also leads Atlas sees IP Lab and Gather, but not their check-ins.
    const led = coverage("leader", ["ip1", "at"]);
    const org = buildOrg({
      teams: TEAMS,
      checkins: [checkin("ip1", "2026-10-05", [4, 3, 3])],
      weeks: WEEKS,
      config: RULES,
      covers: led,
    });
    expect(org.roots.map(shape)).toEqual([
      ["Gather", false, [["IP Lab", false, [["IP Lab 1", true, []]]]]],
      ["Culture", false, [["Atlas", true, []]]],
    ]);
    expect(find(org.roots, "ip")!.cells).toEqual([]);
    expect(find(org.roots, "ip1")!.cells[1].health).toMatchObject({ band: "green", graded: 1 });
  });

  it("puts check-ins outside the scored tree in loose rows: other teams, unseen teams, then no team", () => {
    // A leader of IP Lab 1 sees their own earlier check-ins from Barbeques and from a team now hidden.
    const org = buildOrg({
      teams: TEAMS,
      checkins: [
        checkin(null, "2026-10-05", [3, 3, 3]),
        checkin("gone", "2026-09-28", [2, 2, 2]),
        checkin("bq", "2026-09-28", [3, 3, 3]),
        checkin("ip1", "2026-10-05", [3, 3, 3]),
      ],
      weeks: WEEKS,
      config: RULES,
      covers: coverage("leader", ["ip1"]),
    });
    // Named as the leader's own check-ins, never as those teams' health.
    expect(org.loose.map((r) => [r.teamId, r.name])).toEqual([
      ["bq", "Your check-ins · Barbeques"],
      ["gone", "Your check-ins · an earlier team"],
      [null, "No team"],
    ]);
    expect(org.loose[0].cells[0].health).toMatchObject({ score: 9, graded: 1 });
    // Barbeques isn't the leader's to colour, so it isn't in the tree.
    expect(find(org.roots, "bq")).toBeUndefined();
  });

  it("makes a team whose parent the viewer can't see a root", () => {
    const org = buildOrg({
      teams: [node("ip", "IP Lab", "domain", "ga"), node("ip1", "IP Lab 1", "team", "ip")],
      checkins: [],
      weeks: WEEKS,
      config: RULES,
      covers: everyone,
    });
    expect(org.roots.map(shape)).toEqual([["IP Lab", true, [["IP Lab 1", true, []]]]]);
  });

  it("doesn't loop on a cycle, and keeps its check-ins as loose rows", () => {
    const org = buildOrg({
      teams: [node("a", "A", "domain", "b"), node("b", "B", "team", "a")],
      checkins: [checkin("a", "2026-10-05", [3, 3, 3])],
      weeks: WEEKS,
      config: RULES,
      covers: everyone,
    });
    expect(org.roots).toEqual([]);
    expect(org.loose.map((r) => r.teamId)).toEqual(["a"]);
  });

  it("is empty when the viewer can see no teams or check-ins", () => {
    expect(buildOrg({ teams: [], checkins: [], weeks: WEEKS, config: RULES, covers: everyone })).toEqual({
      roots: [],
      loose: [],
    });
  });
});

describe("coverage", () => {
  it("covers every team for hq, the led teams for a leader, and nothing without a role", () => {
    expect(coverage("hq", [])("any")).toBe(true);
    const led = coverage("leader", ["ip1"]);
    expect([led("ip1"), led("ip")]).toEqual([true, false]);
    expect(coverage(null, [])("ip1")).toBe(false);
  });
});
