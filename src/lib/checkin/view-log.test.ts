import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAGE_SIZE } from "@/lib/dashboard/select-all";
import {
  loadViewLog,
  logCheckinViews,
  VIEW_LOG_COLUMNS,
  ViewLogError,
  type ViewLogRow,
  viewsByWeek,
} from "./view-log";

const A = "0a2a0934-0640-4c5f-87b9-4d50688ef9c6";
const B = "1b2a0934-0640-4c5f-87b9-4d50688ef9c6";
const OWNER = "3e3b0000-0000-4000-8000-000000000003";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logCheckinViews", () => {
  const rpc = vi.fn();
  const supabase = { rpc } as never;
  beforeEach(() => {
    rpc.mockReset().mockResolvedValue({ data: null, error: null });
  });

  it("asks the database to note every id, once each, as the viewer", async () => {
    await logCheckinViews(supabase, [A, B, A, A.toUpperCase()], "opened");
    expect(rpc).toHaveBeenCalledExactlyOnceWith("log_checkin_views", { p_checkin_ids: [A, B], p_kind: "opened" });
    await logCheckinViews(supabase, [B], "played");
    expect(rpc).toHaveBeenLastCalledWith("log_checkin_views", { p_checkin_ids: [B], p_kind: "played" });
  });

  it("asks nothing when nothing is shown", async () => {
    await logCheckinViews(supabase, [], "opened");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("throws when the database refuses, logging only the code", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: "42883", message: `function log_checkin_views(${A}) does not exist`, details: A, hint: null },
    });
    const thrown = await logCheckinViews(supabase, [A], "opened").catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ViewLogError);
    expect(thrown).toMatchObject({ message: "Couldn't note who opened it", code: "42883" });
    expect(console.error).toHaveBeenCalledExactlyOnceWith("view log: noting failed", { code: "42883" });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(A);
  });
});

describe("loadViewLog", () => {
  type Call = [string, ...unknown[]];
  // A fake PostgREST query that records its chain; each await answers the next page.
  function client(pages: { data: unknown[] | null; error: unknown }[]) {
    const queries: { table: string; calls: Call[] }[] = [];
    const from = (table: string) => {
      const query = { table, calls: [] as Call[] };
      queries.push(query);
      const chain: Record<string, unknown> = {
        then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(pages.shift() ?? { data: [], error: null }).then(resolve, reject),
      };
      for (const method of ["select", "eq", "gt", "order", "limit", "overrideTypes"]) {
        chain[method] = (...args: unknown[]) => {
          query.calls.push([method, ...args]);
          return chain;
        };
      }
      return chain;
    };
    return { supabase: { from } as never, queries };
  }
  const row = (n: number) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });

  it("reads exactly the log's columns of the owner's own rows, paged by id", async () => {
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => row(i + 1));
    const { supabase, queries } = client([
      { data: full, error: null },
      { data: [row(PAGE_SIZE + 1)], error: null },
    ]);
    const { data, error } = await loadViewLog(supabase, OWNER);
    expect(error).toBeNull();
    expect(data).toHaveLength(PAGE_SIZE + 1);
    expect(queries.map((q) => q.table)).toEqual(["checkin_views", "checkin_views"]);
    expect(queries[0].calls.slice(0, 2)).toEqual([
      ["select", VIEW_LOG_COLUMNS],
      ["eq", "owner_id", OWNER],
    ]);
    expect(queries[0].calls.map(([m]) => m)).toEqual(["select", "eq", "order", "limit", "overrideTypes"]);
    expect(queries[0].calls).toContainEqual(["order", "id"]);
    expect(queries[0].calls).toContainEqual(["limit", PAGE_SIZE]);
    // The next page starts after the last id read.
    expect(queries[1].calls).toContainEqual(["gt", "id", full[full.length - 1].id]);
    expect(queries[1].calls).toContainEqual(["eq", "owner_id", OWNER]);
  });

  it("asks for nothing that names the owner, the source or a count, and never the viewer's member id", () => {
    // Signed-in users can't read viewer_id (0015's column grants): asking for it would fail the read.
    expect(VIEW_LOG_COLUMNS.split(",").map((c) => c.trim())).toEqual([
      "id",
      "checkin_id",
      "week_start",
      "viewer_key",
      "viewer_name",
      "viewer_role",
      "kind",
      "viewed_at",
    ]);
  });

  it("hands back the error when a page can't be read", async () => {
    const { supabase } = client([{ data: null, error: { code: "42P01", message: "relation does not exist" } }]);
    const { data, error } = await loadViewLog(supabase, OWNER);
    expect(data).toBeNull();
    expect(error).toMatchObject({ code: "42P01" });
  });
});

describe("viewsByWeek", () => {
  // viewer_keys: random per viewer and week in the database.
  const JANE = "a0000000-0000-4000-8000-000000000001";
  const ALI = "a0000000-0000-4000-8000-000000000002";
  let n = 0;
  const view = (fields: Partial<ViewLogRow>): ViewLogRow => {
    n += 1;
    return {
      id: `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      checkin_id: A,
      week_start: "2026-10-05",
      viewer_key: JANE,
      viewer_name: "Jane Tan",
      viewer_role: "hq",
      kind: "opened",
      viewed_at: "2026-10-09T06:15:00+00:00",
      ...fields,
    };
  };

  it("groups each week's rows by viewer, the most recent viewer first and their lines newest first", () => {
    const weeks = viewsByWeek([
      view({ viewed_at: "2026-10-07T01:00:00+00:00" }),
      view({ viewer_key: ALI, viewer_name: "Ali Rahman", viewer_role: "leader", viewed_at: "2026-10-08T01:00:00+00:00" }),
      view({ kind: "played", viewed_at: "2026-10-09T02:00:00+00:00" }),
      view({ week_start: "2026-09-28", checkin_id: B, viewed_at: "2026-10-01T03:00:00+00:00" }),
    ]);
    expect([...weeks.keys()]).toEqual(["2026-10-05", "2026-09-28"]);
    expect(weeks.get("2026-10-05")).toEqual([
      {
        name: "Jane Tan",
        role: "HQ",
        lines: [
          { kind: "played", at: "2026-10-09T02:00:00+00:00", reset: false },
          { kind: "opened", at: "2026-10-07T01:00:00+00:00", reset: false },
        ],
      },
      { name: "Ali Rahman", role: "Leader", lines: [{ kind: "opened", at: "2026-10-08T01:00:00+00:00", reset: false }] },
    ]);
    expect(weeks.get("2026-09-28")).toEqual([
      { name: "Jane Tan", role: "HQ", lines: [{ kind: "opened", at: "2026-10-01T03:00:00+00:00", reset: false }] },
    ]);
  });

  it("marks views of a check-in since reset", () => {
    const [group] = viewsByWeek([
      view({ checkin_id: null, viewed_at: "2026-10-06T01:00:00+00:00" }),
      view({ checkin_id: B, viewed_at: "2026-10-08T01:00:00+00:00" }),
    ]).get("2026-10-05")!;
    expect(group.lines.map((l) => l.reset)).toEqual([false, true]);
  });

  it("shows each viewer under the name and label they had when they last looked", () => {
    const [group] = viewsByWeek([
      view({ viewer_name: "Jane Tan (new)", viewer_role: "leader", viewed_at: "2026-10-09T01:00:00+00:00" }),
      view({ viewer_name: "Jane Tan", viewer_role: "leader", viewed_at: "2026-10-06T01:00:00+00:00" }),
    ]).get("2026-10-05")!;
    expect(group).toMatchObject({ name: "Jane Tan (new)", role: "Leader" });
    expect(group.lines).toHaveLength(2);
  });

  it("groups by viewer_key, not by name: two people with one name stay apart", () => {
    const OTHER_JANE = "a0000000-0000-4000-8000-000000000003";
    const groups = viewsByWeek([
      view({ viewer_key: OTHER_JANE, viewed_at: "2026-10-06T01:00:00+00:00" }),
      view({ viewer_key: OTHER_JANE, kind: "played", viewed_at: "2026-10-06T02:00:00+00:00" }),
      view({ viewed_at: "2026-10-05T01:00:00+00:00" }),
    ]).get("2026-10-05")!;
    expect(groups.map((g) => [g.name, g.lines.length])).toEqual([
      ["Jane Tan", 2],
      ["Jane Tan", 1],
    ]);
  });

  it("builds named fields only: never a viewer's key, or anything else a row holds", () => {
    const rows = [
      { ...view({ viewer_key: ALI }), viewer_id: B, owner_id: OWNER, viewed_on: "2026-10-09", activity_score: 1, rubric_review: "SECRET" },
    ];
    const json = JSON.stringify([...viewsByWeek(rows as ViewLogRow[])]);
    for (const secret of [ALI, B, OWNER, A, "viewed_on", "SECRET", "activity_score", "viewer_key", "viewer_id", "checkin_id"]) {
      expect(json).not.toContain(secret);
    }
    const [group] = viewsByWeek(rows as ViewLogRow[]).get("2026-10-05")!;
    expect(Object.keys(group).sort()).toEqual(["lines", "name", "role"]);
    expect(Object.keys(group.lines[0]).sort()).toEqual(["at", "kind", "reset"]);
  });

  it("is empty with no rows", () => {
    expect(viewsByWeek([]).size).toBe(0);
  });
});
