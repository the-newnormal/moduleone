import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@/lib/supabase/server";
import { noticeVersion } from "./notice";
import { noticeAccepted, sessionMember, type Session } from "./session";

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
    recording_notices: { data: { member_id: MEMBER }, error: null },
  };
  queries = [];
  vi.mocked(createClient).mockReset().mockResolvedValue(client as never);
  getClaims.mockReset().mockResolvedValue({ data: { claims: { sub: USER } }, error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
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

describe("noticeAccepted", () => {
  const session = (): Session => ({ supabase: client as never, authUserId: USER, member: { id: MEMBER, team_id: TEAM } });

  it("is true when this member accepted the current notice with this login", async () => {
    expect(await noticeAccepted(session())).toBe(true);
    expect(queries).toEqual([
      {
        table: "recording_notices",
        columns: "member_id",
        filters: [
          ["member_id", MEMBER],
          ["auth_user_id", USER],
          ["notice_version", noticeVersion()],
        ],
      },
    ]);
  });

  // A different transcription setup is a different notice: the version is read when checked.
  it("asks for the notice version in force now", async () => {
    vi.stubEnv("STT_PROVIDER", "");
    vi.stubEnv("STT_FALLBACK", "");
    const before = noticeVersion();
    vi.stubEnv("STT_PROVIDER", "local");
    await noticeAccepted(session());
    expect(noticeVersion()).not.toBe(before);
    expect(queries[0].filters).toContainEqual(["notice_version", noticeVersion()]);
  });

  it("is false when they haven't", async () => {
    reads.recording_notices = { data: null, error: null };
    expect(await noticeAccepted(session())).toBe(false);
  });

  it("is failed when the notice can't be read, logging only the code", async () => {
    reads.recording_notices = { data: null, error: { code: "57014", message: `timeout reading ${MEMBER}` } };
    expect(await noticeAccepted(session())).toBe("failed");
    expect(console.error).toHaveBeenCalledExactlyOnceWith("checkin: reading the notice failed", { code: "57014" });
  });
});
