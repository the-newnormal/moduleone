import { describe, expect, it } from "vitest";
import type { HealthConfig } from "@/lib/health/health";
import { checkedInCounts } from "./checked-in";
import { glance } from "./glance";
import { buildOrg, type Coverage, coverage, type OrgNode } from "./org";
import { subtree, type TeamNode } from "./tree";

// The portal's Who's checked in tile: per box on the glance, how many people sit in it (or under
// it) and how many of them have checked in this week.

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
): TeamNode => ({ id, name, kind, parent_id, sort_order, archived_at: null });

// The New Normal › Gather › IP Lab › IP Lab 1, IP Lab 2; Gather › Barbeques;
// The New Normal › Culture › Atlas › Atlas 1; Culture › Beacon (nobody in it).
// Skunkworks is an unplaced domain at the top level, outside the organisation.
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

type Member = { id: string; team_id: string | null };

// Where everyone sits now.
const MEMBERS: Member[] = [
  { id: "m-president", team_id: "org" },
  { id: "m-gather-head", team_id: "ga" }, // sits in the division, so leads it
  { id: "m-ip-lead", team_id: "ip" },
  { id: "m-ip1-a", team_id: "ip1" },
  { id: "m-ip1-b", team_id: "ip1" },
  { id: "m-ip2", team_id: "ip2" },
  { id: "m-bq", team_id: "bq" },
  { id: "m-at1", team_id: "at1" },
  { id: "m-sk1", team_id: "sk1" },
  { id: "m-unplaced", team_id: null },
];

// What app_led_team_ids gives a leader: the teams they lead and every team under those.
const ledIds = (...ids: string[]) => ids.flatMap((id) => subtree(TEAMS, id).map((t) => t.id));
const HQ = coverage("hq", []);

const orgFor = (covers: Coverage) => buildOrg({ teams: TEAMS, checkins: [], weeks: WEEKS, config: RULES, covers });

const find = (nodes: readonly OrgNode[], id: string): OrgNode => {
  const walk = (ns: readonly OrgNode[]): OrgNode | undefined => {
    for (const n of ns) {
      if (n.teamId === id) return n;
      const found = walk(n.children);
      if (found) return found;
    }
  };
  const found = walk(nodes);
  if (!found) throw new Error(`no box ${id} on the chart`);
  return found;
};

// The boxes on the portal's glance, as the loader passes them.
const glanceNodes = (covers: Coverage) => {
  const shown = glance(orgFor(covers));
  return [...(shown.summary ? [shown.summary] : []), ...shown.rows, ...shown.other];
};

const boxes = (...ids: string[]) => {
  const roots = orgFor(HQ).roots;
  return ids.map((id) => find(roots, id));
};

describe("checkedInCounts", () => {
  it("counts hq's glance: the organisation, its divisions, and an unplaced domain apart", () => {
    const nodes = glanceNodes(HQ);
    const rows = checkedInCounts(nodes, TEAMS, MEMBERS, new Set(["m-gather-head", "m-ip1-a", "m-sk1", "m-unplaced"]));
    expect(rows).toEqual([
      // Everyone placed under the organisation; not Skunkworks, which sits outside it.
      { teamId: "org", name: "The New Normal", people: 8, checkedIn: 2 },
      { teamId: "ga", name: "Gather", people: 6, checkedIn: 2 },
      { teamId: "cu", name: "Culture", people: 1, checkedIn: 0 },
      { teamId: "sk", name: "Skunkworks", people: 1, checkedIn: 1 },
    ]);
  });

  it("counts everyone in a box's whole subtree, the head sitting in a division included", () => {
    const rows = checkedInCounts(boxes("ga", "ip", "ip1", "bq"), TEAMS, MEMBERS, new Set(["m-gather-head", "m-ip2"]));
    expect(rows.map((r) => [r.teamId, r.people, r.checkedIn])).toEqual([
      // Gather's head, IP Lab's lead, IP Lab 1's two, IP Lab 2's one, Barbeques' one.
      ["ga", 6, 2],
      // The division head sits above IP Lab, so isn't counted there.
      ["ip", 4, 1],
      ["ip1", 2, 0],
      ["bq", 1, 0],
    ]);
  });

  it("counts the President, sitting in the organisation, for the organisation only", () => {
    const rows = checkedInCounts(boxes("org", "ga", "cu"), TEAMS, MEMBERS, new Set(["m-president"]));
    expect(rows.map((r) => [r.teamId, r.checkedIn])).toEqual([
      ["org", 1],
      ["ga", 0],
      ["cu", 0],
    ]);
  });

  it("leaves out people placed in no team, checked in or not", () => {
    const everyone = new Set(MEMBERS.map((m) => m.id));
    const rows = checkedInCounts(boxes("org", "sk"), TEAMS, MEMBERS, everyone);
    // The organisation and the unplaced domain between them hold everyone placed anywhere.
    expect(rows.reduce((n, r) => n + r.people, 0)).toBe(MEMBERS.length - 1);
    expect(rows.reduce((n, r) => n + r.checkedIn, 0)).toBe(MEMBERS.length - 1);
  });

  it("counts as checked in only people in the box who are in the set", () => {
    // Check-ins this week by people elsewhere, and by people the viewer can't see at all.
    const rows = checkedInCounts(boxes("ip", "cu"), TEAMS, MEMBERS, new Set(["m-at1", "m-bq", "m-gone"]));
    expect(rows.map((r) => [r.teamId, r.people, r.checkedIn])).toEqual([
      ["ip", 4, 0],
      ["cu", 1, 1],
    ]);
  });

  it("counts someone where they sit now, though their check-in was made in their old team", () => {
    // Moved from IP Lab 1 to Atlas 1 after checking in: the check-in row says IP Lab 1, but the
    // count goes by the member's id, so they show up once, in Atlas 1.
    const members = [...MEMBERS, { id: "m-moved", team_id: "at1" }];
    const rows = checkedInCounts(boxes("ip1", "ip", "at1", "cu", "org"), TEAMS, members, new Set(["m-moved"]));
    expect(rows.map((r) => [r.teamId, r.people, r.checkedIn])).toEqual([
      ["ip1", 2, 0],
      ["ip", 4, 0],
      ["at1", 2, 1],
      ["cu", 2, 1],
      ["org", 9, 1],
    ]);
  });

  it("counts nobody in a box nobody sits in", () => {
    expect(checkedInCounts(boxes("bc"), TEAMS, MEMBERS, new Set(["m-at1"]))).toEqual([
      { teamId: "bc", name: "Beacon", people: 0, checkedIn: 0 },
    ]);
    expect(checkedInCounts(boxes("ga"), TEAMS, [], new Set(["m-ip1-a"]))).toEqual([
      { teamId: "ga", name: "Gather", people: 0, checkedIn: 0 },
    ]);
  });

  it("counts a domain lead's glance from the people in the teams they lead", () => {
    // As loadCheckedIn reads them: members in the led teams only, and every check-in RLS lets the
    // leader see this week (made in those teams, by someone who may since have moved away).
    const led = ledIds("ip");
    const nodes = glanceNodes(coverage("leader", led));
    const members = MEMBERS.filter((m) => m.team_id !== null && led.includes(m.team_id));
    const rows = checkedInCounts(nodes, TEAMS, members, new Set(["m-ip-lead", "m-ip1-b", "m-at1"]));
    expect(rows).toEqual([
      { teamId: "ip", name: "IP Lab", people: 4, checkedIn: 2 },
      { teamId: "ip1", name: "IP Lab 1", people: 2, checkedIn: 1 },
      { teamId: "ip2", name: "IP Lab 2", people: 1, checkedIn: 0 },
    ]);
  });

  it("gives one row per box, in the order given, with counts only", () => {
    const rows = checkedInCounts(boxes("at1", "ip1"), TEAMS, MEMBERS, new Set(["m-ip1-a"]));
    expect(rows).toEqual([
      { teamId: "at1", name: "Atlas 1", people: 1, checkedIn: 0 },
      { teamId: "ip1", name: "IP Lab 1", people: 2, checkedIn: 1 },
    ]);
    // Never who: no field names a person.
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(["checkedIn", "name", "people", "teamId"]);
    expect(checkedInCounts([], TEAMS, MEMBERS, new Set(["m-ip1-a"]))).toEqual([]);
  });
});
