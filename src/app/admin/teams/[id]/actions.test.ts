import { revalidatePath } from "next/cache";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENERIC_ERROR, NO_PERMISSION } from "@/lib/admin/errors";
import { createServiceRoleClient, MISSING_SERVICE_KEY_MESSAGE, MissingServiceKeyError } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  addLead,
  addMember,
  createMember,
  giveLogin,
  removeFromTeam,
  removeLead,
  resendInvite,
  setRole,
} from "./actions";
import {
  ALREADY_HAS_LOGIN,
  ALREADY_IN_TEAM,
  BAD_REQUEST,
  EARLIER_LOGIN,
  EMAIL_TAKEN,
  HOLDS_GRANTS,
  INVITE_RACE,
  INVITE_USED,
  MASTER_ADMIN_LOGIN,
  MISSING_SITE_URL,
  NO_EMAIL_SENDER,
  NO_LOGIN_YET,
  NOT_GIVEN_HERE,
  NOT_IN_TEAM,
  NOT_YOURSELF,
  PERSON_CHANGED,
  PERSON_GONE,
  PICK_ROLE,
  TOO_MANY_EMAILS,
} from "./messages";

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
// Keep the real MissingServiceKeyError; only the client is faked.
vi.mock("@/lib/supabase/admin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase/admin")>()),
  createServiceRoleClient: vi.fn(),
}));

const ADMIN_AUTH = "b0000000-0000-4000-8000-000000000001";
const ADMIN = "a0000000-0000-4000-8000-000000000001"; // the signed-in admin's member id
const TEAM = "c0000000-0000-4000-8000-000000000001";
const OTHER_TEAM = "c0000000-0000-4000-8000-000000000002";
const PERSON = "a0000000-0000-4000-8000-000000000002";
const NEW_LOGIN = "b0000000-0000-4000-8000-000000000009";
const SITE = "https://moduleone.example";
const EMAIL = "mei.wong@example.com";

// ---------- a fake PostgREST query: records the chain, resolves to a queued result ----------

type Result = { data: unknown; error: unknown };
type Query = { table: string; calls: [string, ...unknown[]][] };
const METHODS = ["select", "insert", "update", "delete", "eq", "neq", "is", "in", "or", "limit", "maybeSingle"];

function fakeFrom(queued: Record<string, Result[]>, log: Query[]) {
  return vi.fn((table: string) => {
    const result = queued[table]?.shift();
    if (!result) throw new Error(`unexpected query on ${table}`);
    const query: Query = { table, calls: [] };
    log.push(query);
    const chain: Record<string, unknown> = {
      then: (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    for (const method of METHODS) {
      chain[method] = (...args: unknown[]) => {
        query.calls.push([method, ...args]);
        return chain;
      };
    }
    return chain;
  });
}

// The signed-in user's client.
const getClaims = vi.fn();
const rpc = vi.fn();
let userQueue: Record<string, Result[]>;
let userQueries: Query[];
let from: ReturnType<typeof fakeFrom>;

// The service-role client.
const inviteUserByEmail = vi.fn();
const deleteUser = vi.fn();
const getUserById = vi.fn();
const listRecordings = vi.fn();
const storageFrom = vi.fn(() => ({ list: listRecordings }));
let serviceQueue: Record<string, Result[]>;
let serviceQueries: Query[];
let serviceFrom: ReturnType<typeof fakeFrom>;

function signedIn({ admin }: { admin: boolean }) {
  getClaims.mockResolvedValue({ data: { claims: { sub: ADMIN_AUTH } }, error: null });
  rpc.mockImplementation(async (fn: string) =>
    fn === "app_has_grant" ? { data: admin, error: null } : { data: ADMIN, error: null },
  );
}

function signedOut() {
  getClaims.mockResolvedValue({ data: null, error: null });
}

const rows = (...ids: string[]) => ({ data: ids.map((id) => ({ id })), error: null });
const dbError = (code: string, message: string) => ({
  data: null,
  error: { code, message, details: "Failing row contains (mei.wong@example.com)", hint: null },
});

// The people and lead actions first look for the organisation node (migration 0006): none, unless a
// test says otherwise.
const ORG_LOOKUP = { table: "teams", calls: [["select", "id"], ["eq", "kind", "organisation"], ["limit", 1]] };
const noOrganisation = () => ({ data: [], error: null });
const organisationIs = (id: string) => ({ data: [{ id }], error: null });
// What an action wrote, leaving out that lookup.
const writes = () => userQueries.filter((q) => q.table !== "teams");

beforeEach(() => {
  userQueue = { teams: Array.from({ length: 4 }, noOrganisation) };
  userQueries = [];
  serviceQueue = {};
  serviceQueries = [];
  from = fakeFrom(userQueue, userQueries);
  serviceFrom = fakeFrom(serviceQueue, serviceQueries);
  for (const fn of [getClaims, rpc, inviteUserByEmail, deleteUser, getUserById, listRecordings]) fn.mockReset();
  storageFrom.mockClear();
  vi.mocked(revalidatePath).mockClear();
  vi.mocked(createClient).mockReset().mockResolvedValue({ auth: { getClaims }, rpc, from } as never);
  vi.mocked(createServiceRoleClient)
    .mockReset()
    .mockReturnValue({
      auth: { admin: { inviteUserByEmail, deleteUser, getUserById } },
      from: serviceFrom,
      storage: { from: storageFrom },
    } as never);
  // Made by this invite: the same instant giveLogin's tests freeze the clock at.
  inviteUserByEmail.mockResolvedValue({
    data: { user: { id: NEW_LOGIN, created_at: "2026-10-09T04:30:00.000Z" } },
    error: null,
  });
  listRecordings.mockResolvedValue({ data: [], error: null });
  deleteUser.mockResolvedValue({ data: {}, error: null });
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
  signedIn({ admin: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// Every page that shows people, leads or team names (revalidateTeamTree).
function expectRevalidated() {
  expect(vi.mocked(revalidatePath).mock.calls).toEqual([
    ["/admin/structure"],
    ["/admin/teams/[id]", "page"],
    ["/portal/dashboard", "layout"],
  ]);
}

function expectNothingWritten() {
  expect(from).not.toHaveBeenCalled();
  expect(revalidatePath).not.toHaveBeenCalled();
}

// Every action, called with valid arguments.
const ACTIONS = {
  addMember: () => addMember(TEAM, PERSON, null),
  createMember: () => createMember(TEAM, { name: "Ana Lee", role: "member" }),
  removeFromTeam: () => removeFromTeam(TEAM, PERSON),
  setRole: () => setRole(PERSON, "leader"),
  addLead: () => addLead(TEAM, PERSON),
  removeLead: () => removeLead(TEAM, PERSON),
  giveLogin: () => giveLogin(PERSON, EMAIL),
  resendInvite: () => resendInvite(PERSON),
};

describe.each(Object.entries(ACTIONS))("%s", (_name, run) => {
  it("refuses someone without the admin grant without reading or writing anything", async () => {
    signedIn({ admin: false });
    await expect(run()).resolves.toEqual({ ok: false, error: NO_PERMISSION });
    expectNothingWritten();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller", async () => {
    signedOut();
    await expect(run()).resolves.toEqual({ ok: false, error: NO_PERMISSION });
    expect(rpc).not.toHaveBeenCalled();
    expectNothingWritten();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("says 'something went wrong' when the admin check itself fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST000", message: "down" } });
    await expect(run()).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expectNothingWritten();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });
});

describe("addMember", () => {
  it("moves someone with no team into this one, only if they still have no team", async () => {
    userQueue.members = [rows(PERSON)];
    await expect(addMember(TEAM, PERSON, null)).resolves.toEqual({ ok: true, value: null });
    expect(writes()).toEqual([
      {
        table: "members",
        calls: [
          ["update", { team_id: TEAM }],
          ["eq", "id", PERSON],
          ["is", "team_id", null],
          ["select", "id"],
        ],
      },
    ]);
    expectRevalidated();
  });

  it("moves someone from another team, only if they're still there", async () => {
    userQueue.members = [rows(PERSON)];
    await addMember(TEAM, PERSON, OTHER_TEAM);
    expect(writes()[0].calls).toEqual([
      ["update", { team_id: TEAM }],
      ["eq", "id", PERSON],
      ["eq", "team_id", OTHER_TEAM],
      ["select", "id"],
    ]);
  });

  it("says the person changed when no row is updated (they moved meanwhile)", async () => {
    userQueue.members = [rows()];
    await expect(addMember(TEAM, PERSON, OTHER_TEAM)).resolves.toEqual({ ok: false, error: PERSON_CHANGED });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["a bad team id", () => addMember("x", PERSON, null), BAD_REQUEST],
    ["a bad member id", () => addMember(TEAM, "1; drop table members", null), BAD_REQUEST],
    ["a bad from-team", () => addMember(TEAM, PERSON, "nope"), BAD_REQUEST],
    ["a missing from-team", () => addMember(TEAM, PERSON, undefined as never), BAD_REQUEST],
    ["someone already here", () => addMember(TEAM, PERSON, TEAM), ALREADY_IN_TEAM],
  ])("refuses %s without writing", async (_label, run, error) => {
    await expect(run()).resolves.toEqual({ ok: false, error });
    expectNothingWritten();
  });

  it("shows the database's sentence for an archived team", async () => {
    userQueue.members = [dbError("23514", "That team is archived. Restore it first, or pick another.")];
    await expect(addMember(TEAM, PERSON, null)).resolves.toEqual({
      ok: false,
      error: "That team is archived. Restore it first, or pick another.",
    });
  });

  it("says 'no permission' when RLS refuses", async () => {
    userQueue.members = [dbError("42501", 'new row violates row-level security policy for table "members"')];
    await expect(addMember(TEAM, PERSON, null)).resolves.toEqual({ ok: false, error: NO_PERMISSION });
  });
});

describe("createMember", () => {
  it("adds a new person to this team with the trimmed name and the role", async () => {
    userQueue.members = [rows(PERSON)];
    await expect(createMember(TEAM, { name: "  Ana Lee ", role: "leader" })).resolves.toEqual({ ok: true, value: null });
    expect(writes()).toEqual([
      { table: "members", calls: [["insert", { name: "Ana Lee", team_id: TEAM, role: "leader" }], ["select", "id"]] },
    ]);
    expectRevalidated();
  });

  it("never writes anything but the name, team and role", async () => {
    userQueue.members = [rows(PERSON)];
    await createMember(TEAM, { name: "Ana", role: "member", auth_user_id: NEW_LOGIN, login_given_by: ADMIN } as never);
    expect(writes()[0].calls[0]).toEqual(["insert", { name: "Ana", team_id: TEAM, role: "member" }]);
  });

  it.each([
    ["a bad team id", () => createMember("x", { name: "Ana", role: "member" }), BAD_REQUEST],
    ["no name", () => createMember(TEAM, { name: "", role: "member" }), "Enter a name."],
    ["a name with a line break", () => createMember(TEAM, { name: "Ana\nLee", role: "member" }), "Names can't contain line breaks or hidden characters."],
    ["a Master Admin", () => createMember(TEAM, { name: "Ana", role: "hq" }), PICK_ROLE],
    ["an unknown role", () => createMember(TEAM, { name: "Ana", role: "owner" }), PICK_ROLE],
  ])("refuses %s without writing", async (_label, run, error) => {
    await expect(run()).resolves.toEqual({ ok: false, error });
    expectNothingWritten();
  });

  it("shows the database's sentence for an archived team", async () => {
    const message = "That team is archived. Restore it first, or pick another.";
    userQueue.members = [dbError("23514", message)];
    await expect(createMember(TEAM, { name: "Ana", role: "member" })).resolves.toEqual({ ok: false, error: message });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("removeFromTeam", () => {
  it("sets team_id to null, only if they're still in this team", async () => {
    userQueue.members = [rows(PERSON)];
    await expect(removeFromTeam(TEAM, PERSON)).resolves.toEqual({ ok: true, value: null });
    expect(writes()).toEqual([
      {
        table: "members",
        calls: [["update", { team_id: null }], ["eq", "id", PERSON], ["eq", "team_id", TEAM], ["select", "id"]],
      },
    ]);
    expectRevalidated();
  });

  it("says they're not here any more when no row is updated", async () => {
    userQueue.members = [rows()];
    await expect(removeFromTeam(TEAM, PERSON)).resolves.toEqual({ ok: false, error: NOT_IN_TEAM });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["a bad team id", () => removeFromTeam("x", PERSON)],
    ["a bad member id", () => removeFromTeam(TEAM, 42 as never)],
  ])("refuses %s without writing", async (_label, run) => {
    await expect(run()).resolves.toEqual({ ok: false, error: BAD_REQUEST });
    expectNothingWritten();
  });

  it("hides other failures behind the generic sentence and logs only code and status", async () => {
    userQueue.members = [dbError("08006", "connection to mei.wong@example.com failed")];
    await expect(removeFromTeam(TEAM, PERSON)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(console.error).toHaveBeenCalledExactlyOnceWith("removeFromTeam failed", { code: "08006", status: undefined });
  });
});

describe("setRole", () => {
  it.each(["member", "leader"])("sets the role to %s", async (role) => {
    userQueue.members = [rows(PERSON)];
    await expect(setRole(PERSON, role)).resolves.toEqual({ ok: true, value: null });
    expect(writes()).toEqual([
      { table: "members", calls: [["update", { role }], ["eq", "id", PERSON], ["select", "id"]] },
    ]);
    expectRevalidated();
  });

  it.each([
    ["Master Admin", () => setRole(PERSON, "hq"), PICK_ROLE],
    ["an unknown role", () => setRole(PERSON, "Leader"), PICK_ROLE],
    ["a bad id", () => setRole("", "leader"), BAD_REQUEST],
  ])("refuses %s without writing", async (_label, run, error) => {
    await expect(run()).resolves.toEqual({ ok: false, error });
    expectNothingWritten();
  });

  it("says the person changed when RLS hides the row (a Master Admin, or the admin themselves)", async () => {
    userQueue.members = [rows()];
    await expect(setRole(PERSON, "member")).resolves.toEqual({ ok: false, error: PERSON_CHANGED });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("addLead", () => {
  it("adds a team_leads row", async () => {
    userQueue.team_leads = [{ data: null, error: null }];
    await expect(addLead(TEAM, PERSON)).resolves.toEqual({ ok: true, value: null });
    expect(userQueries).toEqual([ORG_LOOKUP, { table: "team_leads", calls: [["insert", { team_id: TEAM, member_id: PERSON }]] }]);
    expectRevalidated();
  });

  it("is fine when they already lead it", async () => {
    userQueue.team_leads = [dbError("23505", 'duplicate key value violates unique constraint "team_leads_pkey"')];
    await expect(addLead(TEAM, PERSON)).resolves.toEqual({ ok: true, value: null });
    expectRevalidated();
  });

  it.each([
    "Only members with the leader role can lead a team. Make them a leader first.",
    "That team is archived. Restore it first.",
  ])("shows the database's sentence: %s", async (message) => {
    userQueue.team_leads = [dbError("23514", message)];
    await expect(addLead(TEAM, PERSON)).resolves.toEqual({ ok: false, error: message });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says 'no permission' when RLS refuses (the admin themselves)", async () => {
    userQueue.team_leads = [dbError("42501", 'new row violates row-level security policy for table "team_leads"')];
    await expect(addLead(TEAM, ADMIN)).resolves.toEqual({ ok: false, error: NO_PERMISSION });
  });

  it("refuses bad ids without writing", async () => {
    await expect(addLead(TEAM, "x")).resolves.toEqual({ ok: false, error: BAD_REQUEST });
    await expect(addLead("x", PERSON)).resolves.toEqual({ ok: false, error: BAD_REQUEST });
    expectNothingWritten();
  });
});

describe("removeLead", () => {
  it("deletes that team_leads row", async () => {
    userQueue.team_leads = [{ data: null, error: null }];
    await expect(removeLead(TEAM, PERSON)).resolves.toEqual({ ok: true, value: null });
    expect(writes()).toEqual([
      { table: "team_leads", calls: [["delete"], ["eq", "team_id", TEAM], ["eq", "member_id", PERSON]] },
    ]);
    expectRevalidated();
  });

  it("maps a failure", async () => {
    userQueue.team_leads = [dbError("25000", "Change the team tree in a READ COMMITTED transaction.")];
    await expect(removeLead(TEAM, PERSON)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses bad ids without writing", async () => {
    await expect(removeLead(TEAM, null as never)).resolves.toEqual({ ok: false, error: BAD_REQUEST });
    expectNothingWritten();
  });
});

// ---------- giveLogin ----------

const memberRow = (changes: Record<string, unknown> = {}) => ({
  data: { id: PERSON, role: "member", auth_user_id: null, removed_at: null, ...changes },
  error: null,
});

// A member giveLogin may go ahead with: no grants (read as the admin), nothing from an earlier
// login (read with the service role), then `link` for the guarded update.
function loginAllowed(...link: Result[]) {
  userQueue.members = [memberRow()];
  userQueue.member_grants = [rows()];
  serviceQueue.checkins = [rows()];
  serviceQueue.member_profiles = [rows(), rows()]; // the history check, then the late check
  serviceQueue.member_grants = [rows()]; // the late check, after linking
  serviceQueue.members = link;
}

// After linking: did a grant or a Big Five profile arrive while the invite was out?
const LATE_QUERIES: Query[] = [
  { table: "member_grants", calls: [["select", "grant_name"], ["eq", "member_id", PERSON], ["limit", 1]] },
  { table: "member_profiles", calls: [["select", "member_id"], ["eq", "member_id", PERSON], ["limit", 1]] },
];

// The checks for anything left from an earlier login, as giveLogin makes them.
const HISTORY_QUERIES: Query[] = [
  { table: "checkins", calls: [["select", "id"], ["eq", "member_id", PERSON], ["limit", 1]] },
  { table: "member_profiles", calls: [["select", "member_id"], ["eq", "member_id", PERSON], ["limit", 1]] },
];

// Only the project owner decides who sits in the organisation node or leads it (migration 0006):
// every action that would change either refuses, whatever a client sends, and writes nothing.
describe("the organisation node", () => {
  const ORG = TEAM;
  const OTHER = "a0000000-0000-4000-8000-0000000000ff";
  const REFUSED = { ok: false, error: "Only the project owner decides who sits in the organisation and who leads it." };

  it.each([
    ["putting someone in it", () => addMember(ORG, PERSON, null)],
    ["moving someone out of it", () => addMember(OTHER, PERSON, ORG)],
    ["adding someone new to it", () => createMember(ORG, { name: "Ana", role: "member" })],
    ["taking someone out of it", () => removeFromTeam(ORG, PERSON)],
    ["adding a lead of it", () => addLead(ORG, PERSON)],
    ["removing a lead of it", () => removeLead(ORG, PERSON)],
  ])("refuses %s, writing nothing", async (_label, run) => {
    userQueue.teams = [organisationIs(ORG)];
    await expect(run()).resolves.toEqual(REFUSED);
    expect(writes()).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses it whatever the letter case of the ids (Postgres reads uuids case-blind)", async () => {
    for (const run of [() => addLead(ORG.toUpperCase(), PERSON), () => removeFromTeam(ORG.toUpperCase(), PERSON), () => addMember(OTHER, PERSON, ORG.toUpperCase())]) {
      userQueue.teams = [organisationIs(ORG)];
      await expect(run()).resolves.toEqual(REFUSED);
    }
    expect(writes()).toEqual([]);
  });

  it("refuses changing the role of someone who sits in it", async () => {
    userQueue.teams = [organisationIs(ORG)];
    userQueue.members = [{ data: { team_id: ORG }, error: null }];
    await expect(setRole(PERSON, "member")).resolves.toEqual(REFUSED);
    expect(writes()).toEqual([{ table: "members", calls: [["select", "team_id"], ["eq", "id", PERSON], ["maybeSingle"]] }]);
  });

  it("still changes the role of someone elsewhere once there is one, unless they sit in it by then", async () => {
    userQueue.teams = [organisationIs(OTHER)];
    userQueue.members = [{ data: { team_id: TEAM }, error: null }, rows(PERSON)];
    await expect(setRole(PERSON, "leader")).resolves.toEqual({ ok: true, value: null });
    expect(writes()[1].calls).toEqual([
      ["update", { role: "leader" }],
      ["eq", "id", PERSON],
      ["or", `team_id.is.null,team_id.neq.${OTHER}`],
      ["select", "id"],
    ]);
  });

  it("changes nothing if they're moved into it between the read and the write", async () => {
    userQueue.teams = [organisationIs(ORG)];
    userQueue.members = [{ data: { team_id: null }, error: null }, rows()];
    await expect(setRole(PERSON, "member")).resolves.toEqual({ ok: false, error: PERSON_CHANGED });
    expect(writes()[1].calls).toContainEqual(["or", `team_id.is.null,team_id.neq.${ORG}`]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("giveLogin", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T04:30:00.000Z"));
  });

  function expectNoServiceRole() {
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(inviteUserByEmail).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  }

  it("invites the email, links the new login to the member and records who gave it", async () => {
    loginAllowed(rows(PERSON));

    await expect(giveLogin(PERSON, "  Mei.Wong@Example.com ")).resolves.toEqual({ ok: true, value: null });

    // 3. the member and their grants, read as the admin (RLS applies)
    expect(userQueries).toEqual([
      { table: "members", calls: [["select", "id, role, auth_user_id, removed_at"], ["eq", "id", PERSON], ["maybeSingle"]] },
      { table: "member_grants", calls: [["select", "grant_name"], ["eq", "member_id", PERSON], ["limit", 1]] },
    ]);
    // 4. nothing from an earlier login, then the invite, coming back to the site's callback
    expect(storageFrom).toHaveBeenCalledExactlyOnceWith("checkin-audio");
    expect(listRecordings).toHaveBeenCalledExactlyOnceWith(PERSON, { limit: 1 });
    expect(inviteUserByEmail).toHaveBeenCalledExactlyOnceWith(EMAIL, {
      redirectTo: `${SITE}/auth/callback?next=/portal`,
    });
    // 5. the guarded link
    expect(serviceQueries).toEqual([
      ...HISTORY_QUERIES,
      {
        table: "members",
        calls: [
          [
            "update",
            { auth_user_id: NEW_LOGIN, login_given_by: ADMIN, login_given_at: "2026-10-09T04:30:00.000Z" },
          ],
          ["eq", "id", PERSON],
          ["is", "auth_user_id", null],
          ["neq", "role", "hq"],
          ["select", "id"],
        ],
      },
      // 5b. nothing that would come with the login arrived meanwhile
      ...LATE_QUERIES,
    ]);
    expect(deleteUser).not.toHaveBeenCalled();
    // 6.
    expectRevalidated();
  });

  // A grant or a Big Five profile that reaches the row while the invite is out: the link and the
  // new login are undone before anyone can use them.
  const UNLINK: Query = {
    table: "members",
    calls: [
      ["update", { auth_user_id: null, login_given_by: null, login_given_at: null }],
      ["eq", "id", PERSON],
      ["eq", "auth_user_id", NEW_LOGIN],
    ],
  };
  it.each([
    ["a grant", "member_grants", { data: [{ grant_name: "recordings" }], error: null }, HOLDS_GRANTS],
    ["a Big Five profile", "member_profiles", { data: [{ member_id: PERSON }], error: null }, EARLIER_LOGIN],
  ])("undoes the link and the new login when %s arrived meanwhile", async (_label, table, found, message) => {
    loginAllowed(rows(PERSON), rows(), rows()); // link, unlink, "does anyone use this login?"
    if (table === "member_grants") serviceQueue.member_grants = [found];
    else serviceQueue.member_profiles = [rows(), found];
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: message });
    expect(serviceQueries.slice(HISTORY_QUERIES.length + 1)).toEqual([
      ...LATE_QUERIES,
      UNLINK,
      { table: "members", calls: [["select", "id"], ["eq", "auth_user_id", NEW_LOGIN], ["limit", 1]] },
    ]);
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(NEW_LOGIN);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("undoes the link when it can't tell whether anything arrived meanwhile", async () => {
    loginAllowed(rows(PERSON), rows(), rows());
    serviceQueue.member_grants = [dbError("08006", "down")];
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(serviceQueries).toContainEqual(UNLINK);
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(NEW_LOGIN);
  });

  it("tries the unlink again once if it fails", async () => {
    loginAllowed(rows(PERSON), dbError("08006", "down"), rows(), rows()); // link, unlink, unlink again, "anyone use it?"
    serviceQueue.member_grants = [{ data: [{ grant_name: "admin" }], error: null }];
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: HOLDS_GRANTS });
    expect(serviceQueries.filter((q) => q.table === "members" && q.calls[0][0] === "update")).toHaveLength(3);
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(NEW_LOGIN);
  });

  it.each([
    ["one this invite made", "2026-10-09T04:30:00.000Z"],
    ["one it only re-sent", "2026-10-01T00:00:00.000Z"],
  ])("deletes the login (%s) when the unlink fails twice, which unlinks the row too", async (_label, createdAt) => {
    loginAllowed(rows(PERSON), dbError("08006", "down"), dbError("08006", "down"));
    inviteUserByEmail.mockResolvedValue({ data: { user: { id: NEW_LOGIN, created_at: createdAt } }, error: null });
    serviceQueue.member_grants = [{ data: [{ grant_name: "admin" }], error: null }];
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(NEW_LOGIN);
    expect(console.error).toHaveBeenCalledWith("giveLogin unlink retry failed", expect.objectContaining({ code: "08006" }));
  });

  it("refuses a member who holds a grant, without using the service role", async () => {
    userQueue.members = [memberRow()];
    userQueue.member_grants = [{ data: [{ grant_name: "recordings" }], error: null }];
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: HOLDS_GRANTS });
    expectNoServiceRole();
  });

  it("says 'something went wrong' when the grants can't be read, without using the service role", async () => {
    userQueue.members = [memberRow()];
    userQueue.member_grants = [dbError("08006", "down")];
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expectNoServiceRole();
  });

  it.each([
    ["check-ins", "checkins", { data: [{ id: "x" }], error: null }],
    ["a Big Five profile", "member_profiles", { data: [{ member_id: PERSON }], error: null }],
  ])("refuses a member with %s from an earlier login, before inviting", async (_label, table, found) => {
    loginAllowed();
    serviceQueue[table] = [found];
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: EARLIER_LOGIN });
    expect(inviteUserByEmail).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a member with recordings from an earlier login, before inviting", async () => {
    loginAllowed();
    listRecordings.mockResolvedValue({ data: [{ name: "2026-09-28.webm" }], error: null });
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: EARLIER_LOGIN });
    expect(inviteUserByEmail).not.toHaveBeenCalled();
  });

  it("says what it found even when another check fails", async () => {
    loginAllowed();
    serviceQueue.checkins = [{ data: [{ id: "x" }], error: null }];
    listRecordings.mockResolvedValue({ data: null, error: { code: "08006", status: 503 } });
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: EARLIER_LOGIN });
    expect(inviteUserByEmail).not.toHaveBeenCalled();
  });

  it.each([
    ["the check-ins", "checkins"],
    ["the profiles", "member_profiles"],
    ["the recordings", "storage"],
  ])("refuses when %s can't be checked, and logs only the code", async (_label, which) => {
    loginAllowed();
    const down = { data: null, error: { code: "08006", status: 503, message: `down for ${EMAIL}` } };
    if (which === "storage") listRecordings.mockResolvedValue(down);
    else serviceQueue[which] = [down];
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(inviteUserByEmail).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("giveLogin history check failed", { code: "08006", status: 503 });
  });

  it("checks the admin grant, the member and their grants before any service-role call", async () => {
    loginAllowed(rows(PERSON));
    await giveLogin(PERSON, EMAIL);
    const grantCheck = rpc.mock.invocationCallOrder[0];
    const memberLoad = from.mock.invocationCallOrder[0];
    const grantsLoad = from.mock.invocationCallOrder[1];
    const serviceClient = vi.mocked(createServiceRoleClient).mock.invocationCallOrder[0];
    expect(grantCheck).toBeLessThan(memberLoad);
    expect(memberLoad).toBeLessThan(grantsLoad);
    expect(grantsLoad).toBeLessThan(serviceClient);
    // and nothing from an earlier login before the invite
    expect(listRecordings.mock.invocationCallOrder[0]).toBeLessThan(inviteUserByEmail.mock.invocationCallOrder[0]);
  });

  it("uses the site URL without a trailing slash or path", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", " https://moduleone.example/some/path/ ");
    loginAllowed(rows(PERSON));
    await giveLogin(PERSON, EMAIL);
    expect(inviteUserByEmail).toHaveBeenCalledWith(EMAIL, { redirectTo: `${SITE}/auth/callback?next=/portal` });
  });

  it.each([
    ["a bad member id", () => giveLogin("x", EMAIL), BAD_REQUEST],
    ["no email", () => giveLogin(PERSON, "  "), "Enter an email address."],
    ["two @s", () => giveLogin(PERSON, "a@b@example.com"), "Enter an email address like name@example.com."],
    ["no dot in the domain", () => giveLogin(PERSON, "mei@localhost"), "Enter an email address like name@example.com."],
    ["a space", () => giveLogin(PERSON, "mei wong@example.com"), "Email addresses can't contain spaces."],
    ["a control character", () => giveLogin(PERSON, "mei\u0000@example.com"), "Email addresses can't contain spaces."],
    ["a long address", () => giveLogin(PERSON, `${"m".repeat(250)}@example.com`), "Email addresses can be at most 254 characters."],
    ["not a string", () => giveLogin(PERSON, { toString: () => EMAIL } as never), "Enter an email address."],
  ])("refuses %s before reading anything or using the service role", async (_label, run, error) => {
    await expect(run()).resolves.toEqual({ ok: false, error });
    expect(from).not.toHaveBeenCalled();
    expectNoServiceRole();
  });

  it.each([
    ["isn't there (or RLS hides them)", { data: null, error: null }, PERSON_GONE],
    ["is a Master Admin", memberRow({ role: "hq" }), MASTER_ADMIN_LOGIN],
    ["already has a login", memberRow({ auth_user_id: "b0000000-0000-4000-8000-000000000002" }), ALREADY_HAS_LOGIN],
    ["is the admin themselves", memberRow({ id: ADMIN, role: "hq", auth_user_id: ADMIN_AUTH }), NOT_YOURSELF],
  ])("refuses a member who %s without using the service role", async (_label, result, error) => {
    userQueue.members = [result];
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error });
    expectNoServiceRole();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses the admin's own row even if it had no login", async () => {
    userQueue.members = [memberRow({ id: ADMIN })];
    await expect(giveLogin(ADMIN, EMAIL)).resolves.toEqual({ ok: false, error: NOT_YOURSELF });
    expectNoServiceRole();
  });

  it("says 'something went wrong' when the member can't be loaded", async () => {
    userQueue.members = [dbError("08006", "down")];
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expectNoServiceRole();
  });

  it("says the service key is missing", async () => {
    loginAllowed();
    vi.mocked(createServiceRoleClient).mockImplementation(() => {
      throw new MissingServiceKeyError();
    });
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: MISSING_SERVICE_KEY_MESSAGE });
    expect(inviteUserByEmail).not.toHaveBeenCalled();
  });

  it("hides any other problem making the client", async () => {
    loginAllowed();
    vi.mocked(createServiceRoleClient).mockImplementation(() => {
      throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
    });
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
  });

  it.each([undefined, "", "moduleone.example", "javascript:alert(1)", "ftp://moduleone.example"])(
    "refuses to invite without a usable NEXT_PUBLIC_SITE_URL (%j)",
    async (value) => {
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", value);
      loginAllowed();
      await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: MISSING_SITE_URL });
      expectNoServiceRole();
    },
  );

  it.each([
    ["email_exists", { code: "email_exists", status: 422 }, EMAIL_TAKEN],
    ["any 422", { code: undefined, status: 422 }, EMAIL_TAKEN],
    ["a 429", { code: "over_request_rate_limit", status: 429 }, TOO_MANY_EMAILS],
    ["over_email_send_rate_limit", { code: "over_email_send_rate_limit", status: 400 }, TOO_MANY_EMAILS],
    ["the built-in sender's refusal", { code: "email_address_not_authorized", status: 400 }, NO_EMAIL_SENDER],
    ["a server error", { code: "unexpected_failure", status: 500 }, GENERIC_ERROR],
    ["a network error", { code: undefined, status: 0 }, GENERIC_ERROR],
  ])("maps an invite failure (%s) and links nothing", async (_label, error, message) => {
    loginAllowed();
    inviteUserByEmail.mockResolvedValue({ data: { user: null }, error: { ...error, name: "AuthApiError", message: EMAIL } });
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: message });
    expect(serviceQueries).toEqual(HISTORY_QUERIES);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says 'something went wrong' if the invite returns no user", async () => {
    loginAllowed();
    inviteUserByEmail.mockResolvedValue({ data: { user: null }, error: null });
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(serviceQueries).toEqual(HISTORY_QUERIES);
  });

  it("deletes the new login again when the member changed meanwhile", async () => {
    loginAllowed(rows(), rows()); // the guarded update, then "does anyone use this login?"
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: INVITE_RACE });
    expect(serviceQueries[3]).toEqual({
      table: "members",
      calls: [["select", "id"], ["eq", "auth_user_id", NEW_LOGIN], ["limit", 1]],
    });
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(NEW_LOGIN);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("still says so if the clean-up fails, and logs it", async () => {
    loginAllowed(rows(), rows());
    deleteUser.mockResolvedValue({ data: null, error: { code: "unexpected_failure", status: 500 } });
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: INVITE_RACE });
    expect(console.error).toHaveBeenCalledWith("giveLogin cleanup failed", { code: "unexpected_failure", status: 500 });
  });

  it("never deletes a login another member already uses (a re-sent invite returns it)", async () => {
    loginAllowed(rows(), rows("a0000000-0000-4000-8000-000000000003"));
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: INVITE_RACE });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it.each([
    ["was made before this invite (a re-sent pending invite)", "2026-10-09T04:29:59.999Z"],
    ["doesn't say when it was made", undefined],
  ])("never deletes a login that %s", async (_label, createdAt) => {
    loginAllowed(rows(), rows());
    inviteUserByEmail.mockResolvedValue({ data: { user: { id: NEW_LOGIN, created_at: createdAt } }, error: null });
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: INVITE_RACE });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(serviceQueries).toHaveLength(HISTORY_QUERIES.length + 1); // no "does anyone use it?" either
  });

  it("checks history and links by the id as stored, whatever case the request used", async () => {
    loginAllowed(rows(PERSON));
    await expect(giveLogin(PERSON.toUpperCase(), EMAIL)).resolves.toEqual({ ok: true, value: null });
    expect(listRecordings).toHaveBeenCalledExactlyOnceWith(PERSON, { limit: 1 });
    expect(serviceQueries.slice(0, 2)).toEqual(HISTORY_QUERIES);
    expect(serviceQueries[2].calls).toContainEqual(["eq", "id", PERSON]);
  });

  it("doesn't delete when it can't tell whether the login is used", async () => {
    loginAllowed(rows(), dbError("08006", "down"));
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: INVITE_RACE });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("says the email is taken when its pending login already belongs to another member", async () => {
    loginAllowed(dbError("23505", 'duplicate key value violates unique constraint "members_auth_user_id_key"'));
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_TAKEN });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("cleans up and says 'something went wrong' when linking fails otherwise", async () => {
    loginAllowed(dbError("23514", "new row violates check constraint"), rows());
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(NEW_LOGIN);
  });

  it("never logs the email address", async () => {
    loginAllowed();
    inviteUserByEmail.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthApiError", code: "unexpected_failure", status: 500, message: `Error sending invite to ${EMAIL}` },
    });
    await giveLogin(PERSON, EMAIL);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("giveLogin invite failed", {
      code: "unexpected_failure",
      status: 500,
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("example.com");
  });
});

// ---------- resendInvite ----------

describe("resendInvite", () => {
  const LOGIN = "b0000000-0000-4000-8000-000000000002";
  const invited = (changes: Record<string, unknown> = {}) => ({
    data: { id: PERSON, role: "member", auth_user_id: LOGIN, login_given_at: "2026-10-09T04:30:00Z", removed_at: null, ...changes },
    error: null,
  });
  const authUser = (changes: Record<string, unknown> = {}) => ({
    data: { user: { id: LOGIN, email: EMAIL, email_confirmed_at: null, last_sign_in_at: null, ...changes } },
    error: null,
  });

  beforeEach(() => {
    getUserById.mockResolvedValue(authUser());
    inviteUserByEmail.mockResolvedValue({ data: { user: { id: LOGIN } }, error: null });
  });

  function expectNoServiceRole() {
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
    expect(inviteUserByEmail).not.toHaveBeenCalled();
  }

  it("re-sends the invite to the address of a login given here and not used yet, changing nothing", async () => {
    userQueue.members = [invited()];
    await expect(resendInvite(PERSON)).resolves.toEqual({ ok: true, value: null });
    expect(userQueries).toEqual([
      {
        table: "members",
        calls: [["select", "id, role, auth_user_id, login_given_at, removed_at"], ["eq", "id", PERSON], ["maybeSingle"]],
      },
    ]);
    expect(getUserById).toHaveBeenCalledExactlyOnceWith(LOGIN);
    expect(inviteUserByEmail).toHaveBeenCalledExactlyOnceWith(EMAIL, {
      redirectTo: `${SITE}/auth/callback?next=/portal`,
    });
    // No member row is written, no login deleted, nothing to refresh.
    expect(serviceFrom).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("checks the member as the admin before any service-role call", async () => {
    userQueue.members = [invited()];
    await resendInvite(PERSON);
    expect(from.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(createServiceRoleClient).mock.invocationCallOrder[0]);
  });

  it.each([
    ["isn't there (or RLS hides them)", { data: null, error: null }, PERSON_GONE],
    ["is a Master Admin", invited({ role: "hq" }), MASTER_ADMIN_LOGIN],
    ["is the admin themselves", invited({ id: ADMIN }), INVITE_USED],
    ["has no login", invited({ auth_user_id: null, login_given_at: null }), NO_LOGIN_YET],
    ["got their login elsewhere (the Supabase dashboard)", invited({ login_given_at: null }), NOT_GIVEN_HERE],
  ])("refuses a member who %s without using the service role", async (_label, result, error) => {
    userQueue.members = [result];
    await expect(resendInvite(PERSON)).resolves.toEqual({ ok: false, error });
    expectNoServiceRole();
  });

  it("refuses a bad id without reading anything", async () => {
    await expect(resendInvite("x")).resolves.toEqual({ ok: false, error: BAD_REQUEST });
    expect(from).not.toHaveBeenCalled();
    expectNoServiceRole();
  });

  it("says 'something went wrong' when the member can't be loaded", async () => {
    userQueue.members = [dbError("08006", "down")];
    await expect(resendInvite(PERSON)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expectNoServiceRole();
  });

  it("refuses without a usable NEXT_PUBLIC_SITE_URL, or a service key", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    userQueue.members = [invited()];
    await expect(resendInvite(PERSON)).resolves.toEqual({ ok: false, error: MISSING_SITE_URL });
    expectNoServiceRole();

    vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
    userQueue.members = [invited()];
    vi.mocked(createServiceRoleClient).mockImplementation(() => {
      throw new MissingServiceKeyError();
    });
    await expect(resendInvite(PERSON)).resolves.toEqual({ ok: false, error: MISSING_SERVICE_KEY_MESSAGE });
  });

  it.each([
    ["confirmed their address", { email_confirmed_at: "2026-10-09T05:00:00Z" }],
    ["signed in", { last_sign_in_at: "2026-10-09T05:00:00Z" }],
  ])("sends nothing once they've %s", async (_label, changes) => {
    userQueue.members = [invited()];
    getUserById.mockResolvedValue(authUser(changes));
    await expect(resendInvite(PERSON)).resolves.toEqual({ ok: false, error: INVITE_USED });
    expect(inviteUserByEmail).not.toHaveBeenCalled();
  });

  it("says the person changed when their login is gone", async () => {
    userQueue.members = [invited()];
    getUserById.mockResolvedValue({ data: { user: null }, error: { name: "AuthApiError", status: 404, code: "user_not_found" } });
    await expect(resendInvite(PERSON)).resolves.toEqual({ ok: false, error: PERSON_CHANGED });
    expect(inviteUserByEmail).not.toHaveBeenCalled();
  });

  it("says 'something went wrong' when the login can't be read, or has no address", async () => {
    userQueue.members = [invited()];
    getUserById.mockResolvedValue({ data: { user: null }, error: { name: "AuthApiError", status: 500, code: "unexpected_failure" } });
    await expect(resendInvite(PERSON)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    userQueue.members = [invited()];
    getUserById.mockResolvedValue(authUser({ email: undefined }));
    await expect(resendInvite(PERSON)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(inviteUserByEmail).not.toHaveBeenCalled();
  });

  it.each([
    ["a 422 (they signed in meanwhile)", { code: "email_exists", status: 422 }, INVITE_USED],
    ["a rate limit", { code: "over_email_send_rate_limit", status: 429 }, TOO_MANY_EMAILS],
    ["the built-in sender's refusal", { code: "email_address_not_authorized", status: 400 }, NO_EMAIL_SENDER],
    ["a server error", { code: "unexpected_failure", status: 500 }, GENERIC_ERROR],
  ])("maps an invite failure (%s)", async (_label, error, message) => {
    userQueue.members = [invited()];
    inviteUserByEmail.mockResolvedValue({ data: { user: null }, error: { ...error, name: "AuthApiError", message: EMAIL } });
    await expect(resendInvite(PERSON)).resolves.toEqual({ ok: false, error: message });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("says 'something went wrong' if the invite comes back for another login, and deletes nothing", async () => {
    userQueue.members = [invited()];
    inviteUserByEmail.mockResolvedValue({ data: { user: { id: NEW_LOGIN } }, error: null });
    await expect(resendInvite(PERSON)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("never logs the email address", async () => {
    userQueue.members = [invited()];
    inviteUserByEmail.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthApiError", code: "unexpected_failure", status: 500, message: `Error sending invite to ${EMAIL}` },
    });
    await resendInvite(PERSON);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("resendInvite invite failed", {
      code: "unexpected_failure",
      status: 500,
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("example.com");
  });
});
