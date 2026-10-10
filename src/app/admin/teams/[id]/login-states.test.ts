import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAGE_SIZE } from "@/lib/dashboard/select-all";
// Its `import "server-only"` resolves to an empty module in tests (vitest.config.mts).
import { readLoginStates } from "./login-states";
import type { LoginRow } from "./team-view";

const NOW = "2026-10-09T04:30:00.000Z";

const member = (i: number) => `a0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

const invited = (i: number): LoginRow => ({
  member_id: member(i),
  state: "invited",
  invited_at: "2026-10-09T03:00:00+00:00",
  last_sign_in_at: null,
});
const ready = (i: number): LoginRow => ({ member_id: member(i), state: "ready", invited_at: null, last_sign_in_at: null });
const active = (i: number): LoginRow => ({
  member_id: member(i),
  state: "active",
  invited_at: null,
  last_sign_in_at: "2026-10-08T01:02:03.456789+00:00",
});

const logins = (n: number, start = 0) => Array.from({ length: n }, (_, i) => active(start + i));

type Response = { data: unknown[] | null; error: unknown };

// A client whose rpc(fn).order(column).range(from, to) resolves to pages[from / PAGE_SIZE], and
// that records each call in order.
function fakeClient(pages: Response[]) {
  const calls: unknown[][] = [];
  const rpc = vi.fn((fn: string) => {
    calls.push(["rpc", fn]);
    let from = 0;
    const builder = {
      order(column: string) {
        calls.push(["order", column]);
        return builder;
      },
      range(f: number, t: number) {
        calls.push(["range", f, t]);
        from = f;
        return builder;
      },
      then<A, B>(resolve: (r: Response) => A, reject?: (e: unknown) => B) {
        const page = pages[from / PAGE_SIZE] ?? { data: [], error: null };
        return Promise.resolve(page).then(resolve, reject);
      },
    };
    return builder;
  });
  return { client: { rpc } as unknown as SupabaseClient, calls };
}

const READ_PAGE = (from: number) => [
  ["rpc", "admin_login_states"],
  ["order", "member_id"],
  ["range", from, from + PAGE_SIZE - 1],
];

const loggedNothingWithAnEmail = () =>
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/@|example/);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("readLoginStates", () => {
  it("reads admin_login_states ordered by member, and says when it read them", async () => {
    const rows = [invited(1), ready(2), active(3)];
    const { client, calls } = fakeClient([{ data: rows, error: null }]);
    await expect(readLoginStates(client)).resolves.toEqual({ rows, readAt: NOW });
    expect(calls).toEqual(READ_PAGE(0));
    expect(console.error).not.toHaveBeenCalled();
  });

  it("gives the read time as an ISO timestamp from the server's clock", async () => {
    vi.setSystemTime(new Date("2026-12-31T23:59:59.999Z"));
    const { client } = fakeClient([{ data: [ready(1)], error: null }]);
    const result = await readLoginStates(client);
    expect(result?.readAt).toBe("2026-12-31T23:59:59.999Z");
  });

  it("keeps reading past a full page, so people beyond the row limit still get a status", async () => {
    const { client, calls } = fakeClient([
      { data: logins(PAGE_SIZE), error: null },
      { data: [invited(PAGE_SIZE), ready(PAGE_SIZE + 1)], error: null },
    ]);
    const result = await readLoginStates(client);
    expect(result?.rows).toHaveLength(PAGE_SIZE + 2);
    expect(result?.rows[0]).toEqual(active(0));
    expect(result?.rows[PAGE_SIZE - 1]).toEqual(active(PAGE_SIZE - 1));
    expect(result?.rows.slice(PAGE_SIZE)).toEqual([invited(PAGE_SIZE), ready(PAGE_SIZE + 1)]);
    expect(result?.readAt).toBe(NOW);
    expect(calls).toEqual([...READ_PAGE(0), ...READ_PAGE(PAGE_SIZE)]);
  });

  it("asks once more after an exactly full page, and stops at the empty one", async () => {
    const { client, calls } = fakeClient([
      { data: logins(PAGE_SIZE), error: null },
      { data: [], error: null },
    ]);
    const result = await readLoginStates(client);
    expect(result?.rows).toHaveLength(PAGE_SIZE);
    expect(calls).toEqual([...READ_PAGE(0), ...READ_PAGE(PAGE_SIZE)]);
  });

  it("returns no rows, not a failure, when nobody has a login", async () => {
    const { client } = fakeClient([{ data: [], error: null }]);
    await expect(readLoginStates(client)).resolves.toEqual({ rows: [], readAt: NOW });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("treats a null page as no rows", async () => {
    const { client } = fakeClient([{ data: null, error: null }]);
    await expect(readLoginStates(client)).resolves.toEqual({ rows: [], readAt: NOW });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("returns null when the function isn't there yet, logging only the error's code and status", async () => {
    // What PostgREST answers before migration 0010 is applied.
    const error = {
      code: "PGRST202",
      message: "Could not find the function public.admin_login_states without parameters in the schema cache",
      details: "Searched for the function public.admin_login_states without parameters, user hana@example.com",
      hint: "Perhaps you meant to call the function public.admin_login_rows",
    };
    const { client } = fakeClient([{ data: null, error }]);
    await expect(readLoginStates(client)).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("read login states failed", {
      code: "PGRST202",
      status: undefined,
    });
    loggedNothingWithAnEmail();
  });

  it("returns null when the call throws instead of answering, so the page still loads", async () => {
    // A fetch that fails outright (the network, or a client set to throw), on the first page or a later one.
    for (const pages of [0, 1]) {
      vi.mocked(console.error).mockClear();
      const rpc = vi.fn(() => {
        let from = 0;
        const builder = {
          order: () => builder,
          range(f: number) {
            from = f;
            return builder;
          },
          then<A, B>(resolve: (r: Response) => A, reject?: (e: unknown) => B) {
            const answer: Promise<Response> =
              from / PAGE_SIZE < pages
                ? Promise.resolve({ data: logins(PAGE_SIZE), error: null })
                : Promise.reject(Object.assign(new TypeError("fetch failed for nora@example.com"), { code: "ECONNRESET" }));
            return answer.then(resolve, reject);
          },
        };
        return builder;
      });
      await expect(readLoginStates({ rpc } as unknown as SupabaseClient)).resolves.toBeNull();
      expect(console.error).toHaveBeenCalledExactlyOnceWith("read login states failed", {
        code: "ECONNRESET",
        status: undefined,
      });
      loggedNothingWithAnEmail();
    }
  });

  it("returns null when the caller isn't an admin, logging the code and HTTP status", async () => {
    const error = { code: "42501", status: 403, message: "Only admins can see who has signed in.", details: null };
    const { client } = fakeClient([{ data: null, error }]);
    await expect(readLoginStates(client)).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("read login states failed", { code: "42501", status: 403 });
  });

  it("returns null, and none of the rows already read, when a later page fails", async () => {
    const { client, calls } = fakeClient([
      { data: logins(PAGE_SIZE), error: null },
      { data: null, error: { code: "08006", message: "connection lost to db for rosa@example.com" } },
    ]);
    await expect(readLoginStates(client)).resolves.toBeNull();
    expect(calls).toEqual([...READ_PAGE(0), ...READ_PAGE(PAGE_SIZE)]);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("read login states failed", {
      code: "08006",
      status: undefined,
    });
    loggedNothingWithAnEmail();
  });

  it.each([
    ["a state it doesn't know", { ...invited(1), state: "expired" }],
    ["no state", { member_id: member(1), invited_at: null, last_sign_in_at: null }],
    ["a member_id that isn't a string", { ...ready(1), member_id: 42 }],
    ["an invite time that's a number", { ...invited(1), invited_at: Date.parse(NOW) }],
    ["a sign-in time that's missing", { member_id: member(1), state: "active", invited_at: null }],
    ["a sign-in time that's an object", { ...active(1), last_sign_in_at: {} }],
    ["a null row", null],
    ["a row that's a string", "hana@example.com"],
  ])("returns null, logging only that a row was unexpected, for %s", async (_what, bad) => {
    const { client } = fakeClient([{ data: [active(0), bad, ready(2)], error: null }]);
    await expect(readLoginStates(client)).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("read login states failed", {
      code: "unexpected_row",
      status: undefined,
    });
    loggedNothingWithAnEmail();
  });

  it("returns null for a malformed row on a later page too", async () => {
    const { client } = fakeClient([
      { data: logins(PAGE_SIZE), error: null },
      { data: [{ ...active(PAGE_SIZE), state: "deleted", email: "omar@example.com" }], error: null },
    ]);
    await expect(readLoginStates(client)).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("read login states failed", {
      code: "unexpected_row",
      status: undefined,
    });
    loggedNothingWithAnEmail();
  });
});
