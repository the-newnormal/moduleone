import { describe, expect, it } from "vitest";
import type { TeamRow } from "@/lib/admin/tree";
import { withCounts } from "./counts";

const team = (id: string): TeamRow => ({
  id,
  name: id,
  parent_id: null,
  kind: "domain",
  domain_type: null,
  division_type: null,
  code: null,
  sort_order: 0,
  note: null,
  leader_title: null,
  archived_at: null,
});

describe("withCounts", () => {
  it("counts the people in each node and its leads, once each", () => {
    const rows = withCounts(
      [team("ip1"), team("ip2"), team("empty")],
      [
        { id: "mei", team_id: "ip1", role: "member" },
        { id: "leo", team_id: "ip1", role: "leader" },
        { id: "hana", team_id: "ip2", role: "hq" },
        { id: "nobody", team_id: null, role: "leader" },
      ],
      [
        { team_id: "ip2", member_id: "leo" },
        { team_id: "ip1", member_id: "leo" },
        { team_id: "ip2", member_id: "kai" },
      ],
    );
    expect(rows.map(({ id, members, leads }) => ({ id, members, leads }))).toEqual([
      { id: "ip1", members: 2, leads: 1 },
      { id: "ip2", members: 1, leads: 2 },
      { id: "empty", members: 0, leads: 0 },
    ]);
  });

  it("counts a leader placed in a node as one of its leads, with no lead row", () => {
    const rows = withCounts([team("ip1")], [{ id: "leo", team_id: "ip1", role: "leader" }], []);
    expect(rows[0]).toMatchObject({ members: 1, leads: 1 });
  });

  it("keeps every column of the row", () => {
    expect(withCounts([team("a")], [], [])).toEqual([{ ...team("a"), members: 0, leads: 0 }]);
  });
});
