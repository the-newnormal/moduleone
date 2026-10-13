import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@/lib/supabase/server";
import { sessionMember } from "./session";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const USER = "5eed0000-0000-4000-8000-000000000003";
const MEMBER = "3e3b0000-0000-4000-8000-000000000003";
const TEAM = "7ea30000-0000-4000-8000-000000000001";

type Result = { data: unknown; error: unknown };
type Query = { table: string; columns: string; filters: [string, unknown][] };

// The user's (RLS) client: auth plus one maybeSingle() read per table, as in actions.test.ts.
let reads: Record<string, Result>;
let queries: Query[];
const getClaims = vi.fn();
function from(table: string) {
  const query: Query = { table, columns: "", filters: [] };
  queries.push(query);
  const builder = {
    select(columns: string) {
      query.columns = columns;
      return builder;
    },
    eq(column: string, value: unknown) {
      query.filters.push([column, value]);
      return builder;
    },
    maybeSingle: async () => reads[table] ?? { data: null, error: null },
  };
  return builder;
}
const client = { auth: { getClaims }, from };

beforeEach(() => {
  reads = {
    members: { data: { id: MEMBER, team_id: TEAM }, error: null },
  };
  queries = [];
  vi.mocked(createClient).mockReset().mockResolvedValue(client as never);
  getClaims.mockReset().mockResolvedValue({ data: { claims: { sub: USER } }, error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sessionMember", () => {
  it("returns the session's member, read by the session's user id", async () => {
    expect(await sessionMember()).toEqual({ supabase: client, authUserId: USER, member: { id: MEMBER, team_id: TEAM } });
    expect(queries).toEqual([{ table: "members", columns: "id, team_id", filters: [["auth_user_id", USER]] }]);
  });

  it("is signed_out without claims, and reads nothing", async () => {
    getClaims.mockResolvedValue({ data: null, error: null });
    expect(await sessionMember()).toBe("signed_out");
    expect(queries).toEqual([]);
  });

  it("is signed_out when the claims can't be read", async () => {
    getClaims.mockResolvedValue({ data: null, error: { name: "AuthSessionMissingError", message: "no session" } });
    expect(await sessionMember()).toBe("signed_out");
  });

  it("is no_member for a login with no members row", async () => {
    reads.members = { data: null, error: null };
    expect(await sessionMember()).toBe("no_member");
  });

  it("is failed when the member can't be read, logging only the code", async () => {
    reads.members = { data: null, error: { code: "PGRST000", message: `connection refused for ${USER}` } };
    expect(await sessionMember()).toBe("failed");
    expect(console.error).toHaveBeenCalledExactlyOnceWith("checkin: reading the member failed", { code: "PGRST000" });
  });
});
