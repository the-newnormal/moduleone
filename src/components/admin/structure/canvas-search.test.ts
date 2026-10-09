import { describe, expect, it } from "vitest";
import type { MemberRow } from "@/app/admin/teams/[id]/team-view";
import type { TeamRow } from "@/lib/admin/tree";
import { findMatches } from "./canvas-search";
import type { StructureRow } from "./counts";

const node = (id: string, name: string, kind: TeamRow["kind"], extra: Partial<StructureRow> = {}): StructureRow => ({
  id,
  name,
  parent_id: null,
  kind,
  domain_type: null,
  division_type: null,
  code: null,
  sort_order: 0,
  note: null,
  leader_title: null,
  archived_at: null,
  members: 0,
  leads: 0,
  ...extra,
});

const person = (id: string, name: string, team_id: string | null, extra: Partial<MemberRow> = {}): MemberRow => ({
  id,
  name,
  role: "member",
  team_id,
  auth_user_id: null,
  login_given_by: null,
  login_given_at: null,
  login_email_changed_by: null,
  login_email_changed_at: null,
  removed_at: null,
  ...extra,
});

const ROWS = [
  node("gather", "Gather", "division"),
  node("ipLab", "IP Lab", "domain", { code: "IP" }),
  node("ip1", "IP Lab 1", "team", { code: "IP.1" }),
  node("old", "Old Lab", "domain", { archived_at: "2026-10-01T00:00:00Z" }),
];
const MEMBERS = [
  person("ana", "Ana Lee", "ip1"),
  person("lab", "Labib Rahman", null),
  person("olga", "Olga Lab", null, { removed_at: "2026-10-08T00:00:00Z" }),
  person("otto", "Otto Lab", "old"),
  person("zoe", "Zoë Gather", "gather"),
];

const names = (query: string, limit?: number) => findMatches(query, ROWS, MEMBERS, limit).map((m) => m.name);

describe("findMatches", () => {
  it("finds nothing for an empty query", () => {
    expect(findMatches("  ", ROWS, MEMBERS)).toEqual([]);
  });

  it("ranks a name starting with the query first, then a later word, then anywhere; nodes before people on a tie", () => {
    // "lab": Labib starts with it; IP Lab and IP Lab 1 have it as a later word.
    expect(names("lab")).toEqual(["Labib Rahman", "IP Lab", "IP Lab 1"]);
    expect(names("gather")).toEqual(["Gather", "Zoë Gather"]);
  });

  it("leaves out archived nodes, people removed from Module One and people in archived nodes", () => {
    const found = names("lab");
    expect(found).not.toContain("Old Lab");
    expect(found).not.toContain("Olga Lab");
    expect(found).not.toContain("Otto Lab");
  });

  it("ignores case, accents and extra spaces, and matches a node's code", () => {
    expect(names("ZOE")).toEqual(["Zoë Gather"]);
    expect(names("  ip   lab 1 ")).toEqual(["IP Lab 1"]);
    expect(names("ip.1")).toEqual(["IP Lab 1"]);
  });

  it("says what each match is: a node's kind and code, a person's node or No team", () => {
    expect(findMatches("ip lab", ROWS, MEMBERS)).toEqual([
      { type: "node", id: "ipLab", name: "IP Lab", detail: "Domain · IP" },
      { type: "node", id: "ip1", name: "IP Lab 1", detail: "Team · IP.1" },
    ]);
    expect(findMatches("ana", ROWS, MEMBERS)).toEqual([
      { type: "person", id: "ana", name: "Ana Lee", detail: "In IP Lab 1", teamId: "ip1" },
    ]);
    expect(findMatches("labib", ROWS, MEMBERS)[0]).toMatchObject({ detail: "No team", teamId: null });
  });

  it("returns at most the limit", () => {
    expect(names("a", 2)).toHaveLength(2);
  });
});
