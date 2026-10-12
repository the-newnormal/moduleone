import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAGE_SIZE } from "@/lib/dashboard/select-all";
// Its `import "server-only"` resolves to an empty module in tests (vitest.config.mts).
import { readPendingEmails } from "./pending-emails";
import type { PendingEmailRow } from "./team-view";

const member = (i: number) => `a0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

// What pending_login_emails (0014) holds for one person: the address noted for their first invite.
const noted = (i: number): PendingEmailRow => ({ member_id: member(i), email: `person${i}@example.com` });

const notes = (n: number, start = 0) => Array.from({ length: n }, (_, i) => noted(start + i));

type Response = { data: unknown[] | null; error: unknown };

// A client whose from(table).select(columns).order(column).range(from, to) resolves to
// pages[from / PAGE_SIZE], and that records each call in order.
function fakeClient(pages: Response[]) {
  const calls: unknown[][] = [];
  const from = vi.fn((table: string) => {
    calls.push(["from", table]);
    let start = 0;
    const builder = {
      select(columns: string) {
        calls.push(["select", columns]);
        return builder;
      },
      order(column: string) {
        calls.push(["order", column]);
        return builder;
      },
      range(f: number, t: number) {
        calls.push(["range", f, t]);
        start = f;
        return builder;
      },
      then<A, B>(resolve: (r: Response) => A, reject?: (e: unknown) => B) {
        const page = pages[start / PAGE_SIZE] ?? { data: [], error: null };
        return Promise.resolve(page).then(resolve, reject);
      },
    };
    return builder;
  });
  return { client: { from } as unknown as SupabaseClient, calls };
}

// One page's request: only who and which address, never who noted it or when.
const READ_PAGE = (start: number) => [
  ["from", "pending_login_emails"],
  ["select", "member_id, email"],
  ["order", "member_id"],
  ["range", start, start + PAGE_SIZE - 1],
];

const loggedNothingWithAnEmail = () =>
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/@|example/);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readPendingEmails", () => {
  it("reads each person's noted address from pending_login_emails, ordered by member", async () => {
    const rows = [noted(1), noted(2), noted(3)];
    const { client, calls } = fakeClient([{ data: rows, error: null }]);
    await expect(readPendingEmails(client)).resolves.toEqual(rows);
    expect(calls).toEqual(READ_PAGE(0));
    expect(console.error).not.toHaveBeenCalled();
  });

  it("keeps reading past a full page, so people beyond the row limit still get their address", async () => {
    const { client, calls } = fakeClient([
      { data: notes(PAGE_SIZE), error: null },
      { data: [noted(PAGE_SIZE), noted(PAGE_SIZE + 1)], error: null },
    ]);
    const result = await readPendingEmails(client);
    expect(result).toHaveLength(PAGE_SIZE + 2);
    expect(result?.[0]).toEqual(noted(0));
    expect(result?.[PAGE_SIZE - 1]).toEqual(noted(PAGE_SIZE - 1));
    expect(result?.slice(PAGE_SIZE)).toEqual([noted(PAGE_SIZE), noted(PAGE_SIZE + 1)]);
    expect(calls).toEqual([...READ_PAGE(0), ...READ_PAGE(PAGE_SIZE)]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("asks once more after an exactly full page, and stops at the empty one", async () => {
    const { client, calls } = fakeClient([
      { data: notes(PAGE_SIZE), error: null },
      { data: [], error: null },
    ]);
    const result = await readPendingEmails(client);
    expect(result).toHaveLength(PAGE_SIZE);
    expect(calls).toEqual([...READ_PAGE(0), ...READ_PAGE(PAGE_SIZE)]);
  });

  it("returns no rows, not a failure, when nobody has an address noted, so Set email is still offered", async () => {
    const { client } = fakeClient([{ data: [], error: null }]);
    await expect(readPendingEmails(client)).resolves.toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("treats a null page as no rows", async () => {
    const { client } = fakeClient([{ data: null, error: null }]);
    await expect(readPendingEmails(client)).resolves.toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([
    // What PostgREST answers before migration 0014 is applied.
    [
      "PostgREST's schema cache",
      {
        code: "PGRST205",
        message: "Could not find the table 'public.pending_login_emails' in the schema cache",
        details: "Searched for hana@example.com",
        hint: "Perhaps you meant the table 'public.members'",
      },
      { code: "PGRST205", status: undefined },
    ],
    // What Postgres itself says about a missing table, with the HTTP status the client adds.
    [
      "Postgres",
      { code: "42P01", status: 404, message: 'relation "public.pending_login_emails" does not exist', details: null },
      { code: "42P01", status: 404 },
    ],
  ])(
    "returns null when the table isn't there yet (%s), logging only the error's code and status",
    async (_who, error, logged) => {
      const { client } = fakeClient([{ data: null, error }]);
      await expect(readPendingEmails(client)).resolves.toBeNull();
      expect(console.error).toHaveBeenCalledExactlyOnceWith("read pending emails failed", logged);
      loggedNothingWithAnEmail();
    },
  );

  it("returns null when the read is refused, logging the code and HTTP status", async () => {
    const error = { code: "42501", status: 403, message: "permission denied for table pending_login_emails", details: null };
    const { client } = fakeClient([{ data: null, error }]);
    await expect(readPendingEmails(client)).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("read pending emails failed", { code: "42501", status: 403 });
  });

  it("returns null when the call throws instead of answering, so the page still loads", async () => {
    // A fetch that fails outright (the network, or a client set to throw), on the first page or a later one.
    for (const pages of [0, 1]) {
      vi.mocked(console.error).mockClear();
      const from = vi.fn(() => {
        let start = 0;
        const builder = {
          select: () => builder,
          order: () => builder,
          range(f: number) {
            start = f;
            return builder;
          },
          then<A, B>(resolve: (r: Response) => A, reject?: (e: unknown) => B) {
            const answer: Promise<Response> =
              start / PAGE_SIZE < pages
                ? Promise.resolve({ data: notes(PAGE_SIZE), error: null })
                : Promise.reject(Object.assign(new TypeError("fetch failed for nora@example.com"), { code: "ECONNRESET" }));
            return answer.then(resolve, reject);
          },
        };
        return builder;
      });
      await expect(readPendingEmails({ from } as unknown as SupabaseClient)).resolves.toBeNull();
      expect(console.error).toHaveBeenCalledExactlyOnceWith("read pending emails failed", {
        code: "ECONNRESET",
        status: undefined,
      });
      loggedNothingWithAnEmail();
    }
  });

  it("returns null when building the query throws, before anything is sent", async () => {
    const from = vi.fn(() => {
      throw Object.assign(new Error("no client for omar@example.com"), { code: "EBADCLIENT" });
    });
    await expect(readPendingEmails({ from } as unknown as SupabaseClient)).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("read pending emails failed", {
      code: "EBADCLIENT",
      status: undefined,
    });
    loggedNothingWithAnEmail();
  });

  it("returns null, and none of the rows already read, when a later page fails", async () => {
    const { client, calls } = fakeClient([
      { data: notes(PAGE_SIZE), error: null },
      { data: null, error: { code: "08006", message: "connection lost to db for rosa@example.com" } },
    ]);
    await expect(readPendingEmails(client)).resolves.toBeNull();
    expect(calls).toEqual([...READ_PAGE(0), ...READ_PAGE(PAGE_SIZE)]);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("read pending emails failed", {
      code: "08006",
      status: undefined,
    });
    loggedNothingWithAnEmail();
  });

  it.each([
    ["no address", { member_id: member(1) }],
    ["a null address", { member_id: member(1), email: null }],
    ["an address that's a number", { member_id: member(1), email: 42 }],
    ["an address that's a list", { member_id: member(1), email: ["mei@example.com"] }],
    ["no member_id", { email: "mei@example.com" }],
    ["a member_id that isn't a string", { member_id: 42, email: "mei@example.com" }],
    ["a null row", null],
    ["a row that's a string", "hana@example.com"],
  ])("returns null, logging only that a row was unexpected, for %s", async (_what, bad) => {
    const { client } = fakeClient([{ data: [noted(0), bad, noted(2)], error: null }]);
    await expect(readPendingEmails(client)).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("read pending emails failed", {
      code: "unexpected_row",
      status: undefined,
    });
    loggedNothingWithAnEmail();
  });

  it("returns null for a malformed row on a later page too", async () => {
    const { client } = fakeClient([
      { data: notes(PAGE_SIZE), error: null },
      { data: [{ member_id: member(PAGE_SIZE), email: { address: "omar@example.com" } }], error: null },
    ]);
    await expect(readPendingEmails(client)).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("read pending emails failed", {
      code: "unexpected_row",
      status: undefined,
    });
    loggedNothingWithAnEmail();
  });
});
