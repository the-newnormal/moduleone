import { revalidatePath } from "next/cache";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODE_TAKEN, GENERIC_ERROR, NO_PERMISSION } from "@/lib/admin/errors";
import { createClient } from "@/lib/supabase/server";
import { archiveNode, createNode, moveNode, restoreNode, updateNode } from "./actions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const NODE = "c0000000-0000-4000-8000-000000000001";
const PARENT = "c0000000-0000-4000-8000-000000000002";
const NEW_ID = "c0000000-0000-4000-8000-000000000003";
const NOW = "2026-10-08T04:30:00.000Z";

// A PostgREST query: every builder method records its call and returns the query, and awaiting
// it gives `result`. `from(table)` hands out the queued queries in order.
type Call = [string, ...unknown[]];
type Query = { table: string; calls: Call[] };
const queries: Query[] = [];
let results: unknown[] = [];

function query(table: string) {
  const record: Query = { table, calls: [] };
  queries.push(record);
  const result = results.shift() ?? { data: null, error: null };
  const builder: object = new Proxy(
    {},
    {
      get(_, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject);
        }
        return (...args: unknown[]) => {
          record.calls.push([String(prop), ...args]);
          return builder;
        };
      },
    },
  );
  return builder;
}

const getClaims = vi.fn();
const rpc = vi.fn();
const from = vi.fn(query);

// The calls the action made on the database after the admin check.
const writes = () => queries.map((q) => ({ table: q.table, calls: q.calls }));
const moveCalls = () => rpc.mock.calls.filter(([fn]) => fn === "admin_move_team");

function signedIn({ admin }: { admin: boolean }) {
  getClaims.mockResolvedValue({ data: { claims: { sub: "b0000000-0000-4000-8000-000000000001" } }, error: null });
  rpc.mockImplementation(async (fn: string) => {
    if (fn === "app_has_grant") return { data: admin, error: null };
    if (fn === "app_current_member_id") return { data: "a0000000-0000-4000-8000-000000000001", error: null };
    return moveResult;
  });
}
let moveResult: unknown = { data: null, error: null };

const dbError = (code: string, message: string) => ({
  data: null,
  error: { code, message, details: "Failing row contains (secret)", hint: null },
});

beforeEach(() => {
  vi.mocked(createClient).mockResolvedValue({ auth: { getClaims }, rpc, from } as never);
  for (const fn of [getClaims, rpc, from, vi.mocked(revalidatePath)]) fn.mockClear();
  queries.length = 0;
  results = [];
  moveResult = { data: null, error: null };
  signedIn({ admin: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function expectRevalidated() {
  expect(vi.mocked(revalidatePath).mock.calls).toEqual([
    ["/admin/structure"],
    ["/admin/teams/[id]", "page"],
    ["/portal/dashboard", "layout"],
  ]);
}

function expectNothingWritten() {
  expect(from).not.toHaveBeenCalled();
  expect(moveCalls()).toEqual([]);
  expect(revalidatePath).not.toHaveBeenCalled();
}

// Every action, with input that would otherwise be fine.
const ACTIONS = {
  moveNode: () => moveNode({ teamId: NODE, parentId: PARENT, index: 0 }),
  createNode: () => createNode({ kind: "team", parentId: PARENT, name: "IP Lab 3" }),
  updateNode: () => updateNode({ id: NODE, name: "Atlas" }),
  archiveNode: () => archiveNode(NODE),
  restoreNode: () => restoreNode(NODE),
};

describe.each(Object.entries(ACTIONS))("%s", (_, run) => {
  it("refuses someone without the admin grant without touching the database", async () => {
    signedIn({ admin: false });
    await expect(run()).resolves.toEqual({ ok: false, error: NO_PERMISSION });
    expectNothingWritten();
  });

  it("refuses a signed-out caller without touching the database", async () => {
    getClaims.mockResolvedValue({ data: null, error: null });
    await expect(run()).resolves.toEqual({ ok: false, error: NO_PERMISSION });
    expect(rpc).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it("says something went wrong when the admin check itself fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "08006", message: "down" } });
    await expect(run()).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expectNothingWritten();
  });
});

describe("moveNode", () => {
  it("calls admin_move_team with the move and refreshes the structure", async () => {
    await expect(moveNode({ teamId: NODE, parentId: PARENT, index: 2 })).resolves.toEqual({ ok: true, value: null });
    expect(moveCalls()).toEqual([["admin_move_team", { p_team_id: NODE, p_parent_id: PARENT, p_index: 2 }]]);
    expect(from).not.toHaveBeenCalled();
    expectRevalidated();
  });

  it("moves to the top level with a null parent", async () => {
    await moveNode({ teamId: NODE, parentId: null, index: 0 });
    expect(moveCalls()).toEqual([["admin_move_team", { p_team_id: NODE, p_parent_id: null, p_index: 0 }]]);
  });

  it.each([
    [{ teamId: "nope", parentId: PARENT, index: 0 }],
    [{ teamId: NODE, parentId: "x", index: 0 }],
    [{ teamId: NODE, parentId: undefined, index: 0 }],
    [{ teamId: NODE, parentId: PARENT, index: -1 }],
    [{ teamId: NODE, parentId: PARENT, index: 1.5 }],
    [{ teamId: NODE, parentId: PARENT, index: 10001 }],
    [{ teamId: NODE, parentId: PARENT, index: "1" }],
    [null],
    ["garbage"],
  ])("refuses a bad move without calling the database: %o", async (input) => {
    await expect(moveNode(input)).resolves.toEqual({
      ok: false,
      error: "That move isn't possible. Reload the page and try again.",
    });
    expectNothingWritten();
  });

  it.each([
    ["23514", "A team can only sit under a domain."],
    ["23514", "Restore the parent first: it is archived."],
    ["P0002", "That team doesn't exist."],
    ["42501", "You lead where this is going, so another admin has to move it there."],
  ])("shows the database's own refusal (%s) as it is", async (code, message) => {
    moveResult = dbError(code, message);
    await expect(moveNode({ teamId: NODE, parentId: PARENT, index: 0 })).resolves.toEqual({ ok: false, error: message });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says 'no permission' for an RLS refusal and hides other errors behind the generic sentence", async () => {
    moveResult = dbError("42501", "permission denied for table teams");
    await expect(moveNode({ teamId: NODE, parentId: PARENT, index: 0 })).resolves.toEqual({ ok: false, error: NO_PERMISSION });
    moveResult = dbError("25000", "Change the team tree in a READ COMMITTED transaction.");
    await expect(moveNode({ teamId: NODE, parentId: PARENT, index: 0 })).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(console.error).toHaveBeenCalledExactlyOnceWith("moveNode failed", { code: "25000", status: undefined });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("createNode", () => {
  it("adds a team last in its domain", async () => {
    results = [{ data: [{ sort_order: 1 }], error: null }, { data: { id: NEW_ID }, error: null }];
    await expect(
      createNode({ kind: "team", parentId: PARENT, name: " IP Lab 3 ", code: "ip.3", type: "", note: "" }),
    ).resolves.toEqual({ ok: true, value: { id: NEW_ID } });
    expect(writes()).toEqual([
      {
        table: "teams",
        calls: [
          ["select", "sort_order"],
          ["is", "archived_at", null],
          ["eq", "parent_id", PARENT],
          ["order", "sort_order", { ascending: false }],
          ["limit", 1],
        ],
      },
      {
        table: "teams",
        calls: [
          [
            "insert",
            {
              kind: "team",
              parent_id: PARENT,
              name: "IP Lab 3",
              code: "IP.3",
              domain_type: null,
              division_type: null,
              note: null,
              sort_order: 2,
            },
          ],
          ["select", "id"],
          ["single"],
        ],
      },
    ]);
    expectRevalidated();
  });

  it("adds a division last at the top level, with its type, when there's no organisation node", async () => {
    results = [{ data: [], error: null }, { data: [{ sort_order: 5 }], error: null }, { data: { id: NEW_ID }, error: null }];
    await createNode({ kind: "division", parentId: null, name: "Labs", type: "strategy", note: "New." });
    expect(queries[0].calls).toEqual([
      ["select", "id"],
      ["eq", "kind", "organisation"],
      ["is", "parent_id", null],
      ["limit", 1],
    ]);
    expect(queries[1].calls).toContainEqual(["is", "parent_id", null]);
    expect(queries[2].calls[0]).toEqual([
      "insert",
      {
        kind: "division",
        parent_id: null,
        name: "Labs",
        code: null,
        domain_type: null,
        division_type: "strategy",
        note: "New.",
        sort_order: 6,
      },
    ]);
  });

  it("adds a division last in the organisation node when there is one", async () => {
    results = [{ data: [{ id: PARENT }], error: null }, { data: [{ sort_order: 2 }], error: null }, { data: { id: NEW_ID }, error: null }];
    await createNode({ kind: "division", parentId: null, name: "Labs" });
    expect(queries[1].calls).toContainEqual(["eq", "parent_id", PARENT]);
    expect(queries[2].calls[0]).toEqual([
      "insert",
      expect.objectContaining({ kind: "division", parent_id: PARENT, sort_order: 3 }),
    ]);
  });

  it("adds an unplaced domain at position 0 when the top level is empty, and reads a missing parent as unplaced", async () => {
    results = [{ data: [], error: null }, { data: { id: NEW_ID }, error: null }];
    await createNode({ kind: "domain", name: "Legacy", type: "ip" });
    expect(queries[0].calls).toContainEqual(["is", "parent_id", null]);
    expect(queries[1].calls[0]).toEqual([
      "insert",
      expect.objectContaining({ kind: "domain", parent_id: null, domain_type: "ip", sort_order: 0 }),
    ]);
  });

  it("never sets a position past 10000", async () => {
    results = [{ data: [{ sort_order: 10000 }], error: null }, { data: { id: NEW_ID }, error: null }];
    await createNode({ kind: "team", parentId: PARENT, name: "X" });
    expect(queries[1].calls[0]).toEqual(["insert", expect.objectContaining({ sort_order: 10000 })]);
  });

  it("sends only the node's columns, whatever else the client sends", async () => {
    results = [{ data: [], error: null }, { data: { id: NEW_ID }, error: null }];
    await createNode({ kind: "team", parentId: PARENT, name: "X", archived_at: "now", id: NODE, sort_order: 7, division: "HQ" });
    expect(Object.keys(queries[1].calls[0][1] as object).sort()).toEqual(
      ["code", "division_type", "domain_type", "kind", "name", "note", "parent_id", "sort_order"],
    );
  });

  it.each([
    [{ kind: "region", parentId: null, name: "X" }, "Choose what to add, and where."],
    [{ kind: "organisation", parentId: null, name: "X" }, "Choose what to add, and where."],
    [{ kind: "team", parentId: "nope", name: "X" }, "Choose what to add, and where."],
    [{ kind: "division", parentId: PARENT, name: "X" }, "A division can only sit at the top level."],
    [{ kind: "team", parentId: null, name: "X" }, "A team can only sit under a domain."],
    [{ kind: "domain", parentId: PARENT, name: "" }, "Enter a name."],
    [{ kind: "domain", parentId: PARENT, name: "X", code: "ip x" }, "Codes are 1–8 letters or digits, optionally a dot and 1–8 more, like IP.X or IP.1."],
    [{ kind: "team", parentId: PARENT, name: "X", type: "lab" }, "Teams don't have a type."],
    [{ kind: "domain", parentId: PARENT, name: "X", note: "n".repeat(501) }, "Notes can be at most 500 characters."],
    [null, "Choose what to add, and where."],
  ])("refuses bad input without writing: %o", async (input, error) => {
    await expect(createNode(input)).resolves.toEqual({ ok: false, error });
    expectNothingWritten();
  });

  it.each([
    [dbError("23514", "A team can only sit under a domain."), "A team can only sit under a domain."],
    [dbError("23514", "Restore the parent first: it is archived."), "Restore the parent first: it is archived."],
    [dbError("23505", 'duplicate key value violates unique constraint "teams_code_key"'), CODE_TAKEN],
    [dbError("42501", 'new row violates row-level security policy for table "teams"'), NO_PERMISSION],
    [dbError("23503", 'insert or update on table "teams" violates foreign key constraint "teams_parent_id_fkey"'), GENERIC_ERROR],
  ])("maps the insert's refusal %#", async (insertResult, error) => {
    results = [{ data: [], error: null }, insertResult];
    await expect(createNode({ kind: "team", parentId: PARENT, name: "X", code: "IP.1" })).resolves.toEqual({ ok: false, error });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("stops if it can't read the siblings", async () => {
    results = [dbError("08006", "connection lost")];
    await expect(createNode({ kind: "team", parentId: PARENT, name: "X" })).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(queries).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith("createNode failed", { code: "08006", status: undefined });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("updateNode", () => {
  it("reads the node's kind, then saves the fields into that kind's columns", async () => {
    results = [{ data: { kind: "domain" }, error: null }, { data: [{ id: NODE }], error: null }];
    await expect(
      updateNode({ id: NODE, name: "Atlas", code: "at.x", type: "development", note: " Moved from HQ. " }),
    ).resolves.toEqual({ ok: true, value: null });
    expect(writes()).toEqual([
      { table: "teams", calls: [["select", "kind"], ["eq", "id", NODE], ["maybeSingle"]] },
      {
        table: "teams",
        calls: [
          [
            "update",
            { name: "Atlas", code: "AT.X", domain_type: "development", division_type: null, note: "Moved from HQ." },
          ],
          ["eq", "id", NODE],
          ["select", "id"],
        ],
      },
    ]);
    expectRevalidated();
  });

  it("clears the code, type and note when they're emptied, and never changes the kind", async () => {
    results = [{ data: { kind: "division" }, error: null }, { data: [{ id: NODE }], error: null }];
    await updateNode({ id: NODE, name: "Gather", code: "", type: "", note: "", kind: "team", parent_id: null, archived_at: null });
    expect(queries[1].calls[0]).toEqual([
      "update",
      { name: "Gather", code: null, domain_type: null, division_type: null, note: null },
    ]);
  });

  it("checks the type against the node's real kind, not what the client says", async () => {
    results = [{ data: { kind: "team" }, error: null }];
    await expect(updateNode({ id: NODE, name: "IP Lab 1", type: "lab", kind: "domain" })).resolves.toEqual({
      ok: false,
      error: "Teams don't have a type.",
    });
    expect(queries).toHaveLength(1);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a bad id without touching the database", async () => {
    await expect(updateNode({ id: "1; drop table teams", name: "X" })).resolves.toEqual({
      ok: false,
      error: "It isn't there any more. Reload the page to see the structure as it is now.",
    });
    expectNothingWritten();
  });

  it("maps a failure to read the node's kind instead of calling it gone", async () => {
    results = [dbError("42501", "permission denied for table teams")];
    await expect(updateNode({ id: NODE, name: "X" })).resolves.toEqual({ ok: false, error: NO_PERMISSION });
    results = [{ data: null, error: { code: "PGRST000", message: "down", status: 503 } }];
    await expect(updateNode({ id: NODE, name: "X" })).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(console.error).toHaveBeenCalledWith("updateNode failed", { code: "PGRST000", status: 503 });
    expect(queries).toHaveLength(2);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says the node is gone when it can't be found or the update reaches no row", async () => {
    const gone = { ok: false, error: "It isn't there any more. Reload the page to see the structure as it is now." };
    results = [{ data: null, error: null }];
    await expect(updateNode({ id: NODE, name: "X" })).resolves.toEqual(gone);
    results = [{ data: { kind: "team" }, error: null }, { data: [], error: null }];
    await expect(updateNode({ id: NODE, name: "X" })).resolves.toEqual(gone);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("shows a taken code and maps other refusals", async () => {
    results = [{ data: { kind: "team" }, error: null }, dbError("23505", 'duplicate key value violates unique constraint "teams_code_key"')];
    await expect(updateNode({ id: NODE, name: "X", code: "IP.1" })).resolves.toEqual({ ok: false, error: CODE_TAKEN });
    results = [{ data: { kind: "team" }, error: null }, dbError("23514", 'new row for relation "teams" violates check constraint "teams_note_length"')];
    await expect(updateNode({ id: NODE, name: "X" })).resolves.toEqual({ ok: false, error: "Notes can be at most 500 characters." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("archiveNode", () => {
  it("stamps archived_at on an active node", async () => {
    results = [{ data: [{ id: NODE }], error: null }];
    await expect(archiveNode(NODE)).resolves.toEqual({ ok: true, value: null });
    expect(writes()).toEqual([
      {
        table: "teams",
        calls: [["update", { archived_at: NOW }], ["eq", "id", NODE], ["is", "archived_at", null], ["select", "id"]],
      },
    ]);
    expectRevalidated();
  });

  it.each([
    "Move its 2 members out first.",
    "Archive or move the 3 active teams under it first.",
  ])("shows the database's refusal as it is: %s", async (message) => {
    results = [dbError("23514", message)];
    await expect(archiveNode(NODE)).resolves.toEqual({ ok: false, error: message });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says so when nothing was archived", async () => {
    results = [{ data: [], error: null }];
    await expect(archiveNode(NODE)).resolves.toEqual({
      ok: false,
      error: "It's already archived, or it isn't there any more. Reload the page.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a bad id without touching the database", async () => {
    await expect(archiveNode({ id: NODE })).resolves.toMatchObject({ ok: false });
    expectNothingWritten();
  });
});

describe("restoreNode", () => {
  it("clears archived_at on an archived node", async () => {
    results = [{ data: [{ id: NODE }], error: null }];
    await expect(restoreNode(NODE)).resolves.toEqual({ ok: true, value: null });
    expect(writes()).toEqual([
      {
        table: "teams",
        calls: [["update", { archived_at: null }], ["eq", "id", NODE], ["not", "archived_at", "is", null], ["select", "id"]],
      },
    ]);
    expectRevalidated();
  });

  it("shows the database's refusal as it is", async () => {
    results = [dbError("23514", "Restore the parent first: it is archived.")];
    await expect(restoreNode(NODE)).resolves.toEqual({ ok: false, error: "Restore the parent first: it is archived." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says so when nothing was restored", async () => {
    results = [{ data: [], error: null }];
    await expect(restoreNode(NODE)).resolves.toEqual({
      ok: false,
      error: "It isn't archived, or it isn't there any more. Reload the page.",
    });
  });

  it("refuses a bad id without touching the database", async () => {
    await expect(restoreNode(undefined)).resolves.toMatchObject({ ok: false });
    expectNothingWritten();
  });
});
