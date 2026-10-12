import { readFileSync } from "node:fs";
import { revalidatePath } from "next/cache";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMAIL_NOTED, GENERIC_ERROR, NO_PERMISSION } from "@/lib/admin/errors";
import { MAX_PEOPLE } from "@/lib/admin/people-list";
import { createServiceRoleClient, MISSING_SERVICE_KEY_MESSAGE, MissingServiceKeyError } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  addLead,
  addMember,
  changeEmail,
  createMember,
  createMembers,
  giveLogin,
  removeFromTeam,
  removeLead,
  removePerson,
  resendInvite,
  setPendingEmail,
  setRole,
} from "./actions";
import {
  ALREADY_HAS_LOGIN,
  ALREADY_IN_TEAM,
  BAD_REQUEST,
  EARLIER_LOGIN,
  EMAIL_FORMAT,
  EMAIL_HOLDS_GRANTS,
  EMAIL_IN_USE,
  EMAIL_MASTER_ADMIN,
  EMAIL_NEEDS_SERVICE_KEY,
  EMAIL_NEEDS_SITE_URL,
  EMAIL_NOT_RESTORED,
  EMAIL_NOT_YOURSELF,
  EMAIL_ORGANISATION,
  EMAIL_RACE,
  EMAIL_TAKEN,
  HOLDS_GRANTS,
  INVITE_RACE,
  INVITE_USED,
  MASTER_ADMIN_LOGIN,
  MISSING_SITE_URL,
  NO_EMAIL_SENDER,
  NO_LOGIN_YET,
  NO_PEOPLE,
  NOT_GIVEN_HERE,
  NOT_IN_TEAM,
  NOT_YOURSELF,
  NOTE_CHANGED,
  NOTED_FOR_SOMEONE_ELSE,
  ORGANISATION_OWNER_ONLY,
  PENDING_HAS_LOGIN,
  PERSON_CHANGED,
  PERSON_GONE,
  PERSON_REMOVED,
  PICK_ROLE,
  REMOVE_NEEDS_SERVICE_KEY,
  TOO_MANY_EMAILS,
  TOO_MANY_PEOPLE,
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
const LOGIN = "b0000000-0000-4000-8000-000000000002"; // the login PERSON has, when a test gives them one
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

// The signed-in user's client. admin_remove_member answers `removal` (removePerson's tests set it);
// admin_add_members answers `added`, or when that's null, a new id for each person on the list.
const getClaims = vi.fn();
const rpc = vi.fn();
let removal: Result;
let added: Result | null;
let userQueue: Record<string, Result[]>;
let userQueries: Query[];
let from: ReturnType<typeof fakeFrom>;

// The service-role client.
const inviteUserByEmail = vi.fn();
const deleteUser = vi.fn();
const getUserById = vi.fn();
const updateUserById = vi.fn();
const serviceRpc = vi.fn(); // login_email_in_use
const listRecordings = vi.fn();
const storageFrom = vi.fn(() => ({ list: listRecordings }));
let serviceQueue: Record<string, Result[]>;
let serviceQueries: Query[];
let serviceFrom: ReturnType<typeof fakeFrom>;

function signedIn({ admin }: { admin: boolean }) {
  getClaims.mockResolvedValue({ data: { claims: { sub: ADMIN_AUTH } }, error: null });
  rpc.mockImplementation(async (fn: string, args?: { p_people?: unknown[] }) =>
    fn === "app_has_grant"
      ? { data: admin, error: null }
      : fn === "admin_remove_member"
        ? removal
        : fn === "admin_add_members"
          ? (added ?? { data: (args?.p_people ?? []).map((_, i) => newMemberId(i)), error: null })
          : { data: ADMIN, error: null },
  );
}

// The id admin_add_members gives the i-th person on a list (from 0).
const newMemberId = (i: number) => `d0000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;

function signedOut() {
  getClaims.mockResolvedValue({ data: null, error: null });
}

const rows = (...ids: string[]) => ({ data: ids.map((id) => ({ id })), error: null });
const done = () => ({ data: null, error: null }); // a write without .select()
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

// giveLogin asks whether the address is noted for someone else's invite (migration 0014): nobody's,
// unless a test says otherwise.
const notNoted = () => ({ data: [], error: null });

beforeEach(() => {
  userQueue = { teams: Array.from({ length: 4 }, noOrganisation), pending_login_emails: Array.from({ length: 4 }, notNoted) };
  userQueries = [];
  serviceQueue = {};
  serviceQueries = [];
  from = fakeFrom(userQueue, userQueries);
  serviceFrom = fakeFrom(serviceQueue, serviceQueries);
  for (const fn of [getClaims, rpc, inviteUserByEmail, deleteUser, getUserById, updateUserById, serviceRpc, listRecordings]) {
    fn.mockReset();
  }
  storageFrom.mockClear();
  vi.mocked(revalidatePath).mockClear();
  vi.mocked(createClient).mockReset().mockResolvedValue({ auth: { getClaims }, rpc, from } as never);
  vi.mocked(createServiceRoleClient)
    .mockReset()
    .mockReturnValue({
      auth: { admin: { inviteUserByEmail, deleteUser, getUserById, updateUserById } },
      from: serviceFrom,
      rpc: serviceRpc,
      storage: { from: storageFrom },
    } as never);
  // Made by this invite: the same instant giveLogin's tests freeze the clock at.
  inviteUserByEmail.mockResolvedValue({
    data: { user: { id: NEW_LOGIN, created_at: "2026-10-09T04:30:00.000Z" } },
    error: null,
  });
  listRecordings.mockResolvedValue({ data: [], error: null });
  deleteUser.mockResolvedValue({ data: {}, error: null });
  removal = { data: { outcome: "deleted", login_id: null }, error: null };
  added = null;
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
  expect(rpc).not.toHaveBeenCalledWith("admin_remove_member", expect.anything());
  expect(rpc).not.toHaveBeenCalledWith("admin_add_members", expect.anything());
  expect(revalidatePath).not.toHaveBeenCalled();
}

// Every action, called with valid arguments.
const ACTIONS = {
  addMember: () => addMember(TEAM, PERSON, null),
  createMember: () => createMember(TEAM, { name: "Ana Lee", role: "member" }),
  createMembers: () => createMembers(TEAM, [{ name: "Ana Lee", role: "member", email: EMAIL }]),
  setPendingEmail: () => setPendingEmail(PERSON, EMAIL, null),
  removeFromTeam: () => removeFromTeam(TEAM, PERSON),
  setRole: () => setRole(PERSON, "leader"),
  addLead: () => addLead(TEAM, PERSON),
  removeLead: () => removeLead(TEAM, PERSON),
  giveLogin: () => giveLogin(PERSON, EMAIL),
  resendInvite: () => resendInvite(PERSON),
  removePerson: () => removePerson(PERSON),
  changeEmail: () => changeEmail(PERSON, EMAIL),
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

// ---------- createMembers ----------

describe("createMembers", () => {
  // n people for a list, each with an address of their own unless `emails` is false.
  const listOf = (n: number, emails = true) =>
    Array.from({ length: n }, (_, i) => ({
      name: `Person ${i + 1}`,
      role: "member",
      email: emails ? `person${i + 1}@example.com` : null,
    }));
  const addressesOf = (list: { email: string | null }[]) => list.map((p) => p.email as string);
  // Is any of these addresses noted for someone's invite already? (Asked as the admin: RLS applies.)
  const lookup = (emails: string[]): Query => ({
    table: "pending_login_emails",
    calls: [["select", "email"], ["in", "email", emails]],
  });
  const notedAs = (...emails: string[]) => ({ data: emails.map((email) => ({ email })), error: null });
  const adds = () => rpc.mock.calls.filter(([fn]) => fn === "admin_add_members");
  const expectNobodyAdded = () => {
    expect(adds()).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  };
  // A database error whose message and details name the people on the list, as Postgres's can.
  const leaky = (code: string) => ({
    data: null,
    error: {
      code,
      message: `Key (email)=(ana.lee@example.com) for Ana Lee: ${code}`,
      details: "Failing row contains (Ana Lee, ana.lee@example.com)",
      hint: null,
    },
  });
  const expectNothingPersonalLogged = () =>
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/@|example|Ana|Lee/);

  it("adds the whole list in one call to admin_add_members as the admin, cleaned, and says how many", async () => {
    userQueue.pending_login_emails = [notedAs()];
    const result = await createMembers(TEAM, [
      { name: "  Ana Lee ", role: "leader", email: " Ana.Lee@Example.COM " },
      { name: "Ben Tan", role: "member", email: null },
      { name: "Chen Wei", role: "member", email: "" },
      { name: "Dev Raj", role: "member" } as never,
    ]);
    expect(result).toEqual({ ok: true, value: { added: 4 } });
    // Only the one address is asked about, as it's stored (trimmed, lower case).
    expect(userQueries).toEqual([ORG_LOOKUP, lookup(["ana.lee@example.com"])]);
    expect(adds()).toEqual([
      [
        "admin_add_members",
        {
          p_team_id: TEAM,
          p_people: [
            { name: "Ana Lee", role: "leader", email: "ana.lee@example.com" },
            { name: "Ben Tan", role: "member", email: null },
            { name: "Chen Wei", role: "member", email: null },
            { name: "Dev Raj", role: "member", email: null },
          ],
        },
      ],
    ]);
    // Nothing is written straight to members or pending_login_emails: the function does both.
    expect(userQueries.flatMap((q) => q.calls.map(([method]) => method))).not.toContain("insert");
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(inviteUserByEmail).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expectRevalidated();
  });

  it("checks the admin grant, then the organisation, then the noted addresses, before adding anyone", async () => {
    userQueue.pending_login_emails = [notedAs()];
    await createMembers(TEAM, listOf(2));
    const grantCheck = rpc.mock.invocationCallOrder[0];
    const add = rpc.mock.invocationCallOrder[rpc.mock.calls.findIndex(([fn]) => fn === "admin_add_members")];
    expect(from.mock.calls.map(([table]) => table)).toEqual(["teams", "pending_login_emails"]);
    expect(grantCheck).toBeLessThan(from.mock.invocationCallOrder[0]);
    expect(from.mock.invocationCallOrder[0]).toBeLessThan(from.mock.invocationCallOrder[1]);
    expect(from.mock.invocationCallOrder[1]).toBeLessThan(add);
    expect(add).toBeLessThan(vi.mocked(revalidatePath).mock.invocationCallOrder[0]);
  });

  it("asks about no addresses when nobody on the list has one", async () => {
    await expect(createMembers(TEAM, listOf(3, false))).resolves.toEqual({ ok: true, value: { added: 3 } });
    expect(userQueries).toEqual([ORG_LOOKUP]);
    expect(adds()[0][1]).toEqual({ p_team_id: TEAM, p_people: listOf(3, false) });
    expectRevalidated();
  });

  it("never sends anything but each person's name, role and address", async () => {
    const extra = { auth_user_id: NEW_LOGIN, team_id: OTHER_TEAM, login_given_by: ADMIN, removed_at: null, id: PERSON };
    await createMembers(TEAM, [{ name: "Ana", role: "member", email: null, ...extra } as never]);
    expect(adds()).toEqual([["admin_add_members", { p_team_id: TEAM, p_people: [{ name: "Ana", role: "member", email: null }] }]]);
  });

  // Two people can share a name (the dialog points it out); only addresses must differ.
  it("adds two people with the same name", async () => {
    await expect(
      createMembers(TEAM, [
        { name: "Ana Lee", role: "member", email: null },
        { name: "Ana Lee", role: "member", email: null },
      ]),
    ).resolves.toEqual({ ok: true, value: { added: 2 } });
  });

  it(`adds a list of exactly ${MAX_PEOPLE}, asking about their addresses 50 at a time`, async () => {
    const list = listOf(MAX_PEOPLE);
    const emails = addressesOf(list);
    userQueue.pending_login_emails = [notedAs(), notedAs(), notedAs(), notedAs()];
    await expect(createMembers(TEAM, list)).resolves.toEqual({ ok: true, value: { added: MAX_PEOPLE } });
    expect(writes()).toEqual([
      lookup(emails.slice(0, 50)),
      lookup(emails.slice(50, 100)),
      lookup(emails.slice(100, 150)),
      lookup(emails.slice(150, 200)),
    ]);
    expect((adds()[0][1] as { p_people: unknown[] }).p_people).toHaveLength(MAX_PEOPLE);
    expectRevalidated();
  });

  it.each([
    ["a bad team id", () => createMembers("x", listOf(1)), BAD_REQUEST],
    ["a team id with SQL in it", () => createMembers(`${TEAM}' or '1'='1`, listOf(1)), BAD_REQUEST],
    ["a team id that isn't a string", () => createMembers(42 as never, listOf(1)), BAD_REQUEST],
    ["no list", () => createMembers(TEAM, null as never), BAD_REQUEST],
    ["a list that isn't an array", () => createMembers(TEAM, "Ana Lee, ana.lee@example.com" as never), BAD_REQUEST],
    ["an object that looks like a list", () => createMembers(TEAM, { length: 1, 0: listOf(1)[0] } as never), BAD_REQUEST],
    ["an empty list", () => createMembers(TEAM, []), NO_PEOPLE],
    [`more than ${MAX_PEOPLE} people`, () => createMembers(TEAM, listOf(MAX_PEOPLE + 1)), TOO_MANY_PEOPLE],
  ])("refuses %s without reading or adding anything", async (_label, run, error) => {
    await expect(run()).resolves.toEqual({ ok: false, error });
    expectNothingWritten();
  });

  const ana = { name: "Ana Lee", role: "member", email: "ana.lee@example.com" };
  it.each([
    ["someone with no name", [ana, { name: "  ", role: "member", email: null }], "Person 2 on the list: Enter a name."],
    ["someone whose name isn't text", [{ name: 42, role: "member", email: null }], "Person 1 on the list: Enter a name."],
    [
      "a name with a line break",
      [{ name: "Ana\nLee", role: "member", email: null }],
      "Person 1 on the list: Names can't contain line breaks or hidden characters.",
    ],
    [
      "a name that's too long",
      [ana, { name: "Ben", role: "member", email: null }, { name: "A".repeat(121), role: "member", email: null }],
      "Person 3 on the list: Names can be at most 120 characters.",
    ],
    ["an entry that isn't a person", [ana, null], "Person 2 on the list: Enter a name."],
    ["an entry that's only a name", ["Ana Lee"], "Person 1 on the list: Enter a name."],
    ["a Master Admin", [{ ...ana, role: "hq" }], `Person 1 on the list: ${PICK_ROLE}`],
    ["someone with no role", [{ name: "Ana Lee", email: null }], `Person 1 on the list: ${PICK_ROLE}`],
    ["a role in the wrong letter case", [{ ...ana, role: "Leader" }], `Person 1 on the list: ${PICK_ROLE}`],
    [
      "an address without a dot in its domain",
      [{ ...ana, email: "ana@localhost" }],
      "Person 1 on the list: Enter an email address like name@example.com.",
    ],
    [
      "an address with two @s",
      [{ name: "Ben", role: "member", email: null }, { ...ana, email: "ana@lee@example.com" }],
      "Person 2 on the list: Enter an email address like name@example.com.",
    ],
    ["an address with a space", [{ ...ana, email: "ana lee@example.com" }], "Person 1 on the list: Email addresses can't contain spaces."],
    ["an address that isn't text", [{ ...ana, email: 42 }], "Person 1 on the list: Enter an email address."],
    [
      "an address that's too long",
      [{ ...ana, email: `${"a".repeat(250)}@example.com` }],
      "Person 1 on the list: Email addresses can be at most 254 characters.",
    ],
    [
      "the same address twice, in any letter case",
      [ana, { name: "Ben", role: "member", email: null }, { name: "Ana L", role: "leader", email: " Ana.Lee@Example.com " }],
      "ana.lee@example.com is on the list twice. Give each person their own address.",
    ],
    [
      "several problems (only the first is shown)",
      [ana, { name: "", role: "member", email: null }, { ...ana, role: "hq" }],
      "Person 2 on the list: Enter a name.",
    ],
  ])("refuses a list with %s, saying which person, without reading or adding anything", async (_label, people, error) => {
    await expect(createMembers(TEAM, people as never)).resolves.toEqual({ ok: false, error });
    expectNothingWritten();
  });

  it.each([
    ["is the organisation", TEAM, TEAM],
    ["is the organisation, its id in capitals", TEAM.toUpperCase(), TEAM],
    ["is the organisation, read back in capitals", TEAM, TEAM.toUpperCase()],
  ])("refuses a node that %s, asking about no addresses and adding nobody", async (_label, teamId, orgId) => {
    userQueue.teams = [organisationIs(orgId)];
    await expect(createMembers(teamId, listOf(2))).resolves.toEqual({ ok: false, error: ORGANISATION_OWNER_ONLY });
    expect(userQueries).toEqual([ORG_LOOKUP]);
    expectNobodyAdded();
  });

  it("still adds to any other node once there is an organisation", async () => {
    userQueue.teams = [organisationIs(OTHER_TEAM)];
    userQueue.pending_login_emails = [notedAs()];
    await expect(createMembers(TEAM, listOf(1))).resolves.toEqual({ ok: true, value: { added: 1 } });
    expect(adds()).toHaveLength(1);
  });

  it("says 'something went wrong' when it can't look for the organisation, and adds nobody", async () => {
    userQueue.teams = [dbError("08006", "down")];
    await expect(createMembers(TEAM, listOf(1))).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(userQueries).toEqual([ORG_LOOKUP]);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("createMembers failed", { code: "08006", status: undefined });
    expectNobodyAdded();
  });

  it("refuses an address already noted for someone else, adding nobody", async () => {
    userQueue.pending_login_emails = [notedAs("person2@example.com")];
    await expect(createMembers(TEAM, listOf(3))).resolves.toEqual({
      ok: false,
      error: "person2@example.com is already noted for someone else. Use another address, or change theirs first.",
    });
    expect(writes()).toEqual([lookup(addressesOf(listOf(3)))]);
    expectNobodyAdded();
  });

  it("names every address noted already, in the list's order, whatever order they come back in", async () => {
    userQueue.pending_login_emails = [notedAs("person3@example.com", "person1@example.com")];
    await expect(createMembers(TEAM, listOf(3))).resolves.toEqual({
      ok: false,
      error:
        "These emails are already noted for someone else: person1@example.com, person3@example.com. Use other addresses, or change theirs first.",
    });
    expectNobodyAdded();
  });

  it("asks about more than 50 addresses in reads of 50, and refuses one noted in a later read", async () => {
    const list = listOf(60);
    const emails = addressesOf(list);
    userQueue.pending_login_emails = [notedAs(), notedAs("person57@example.com")];
    await expect(createMembers(TEAM, list)).resolves.toEqual({
      ok: false,
      error: "person57@example.com is already noted for someone else. Use another address, or change theirs first.",
    });
    expect(writes()).toEqual([lookup(emails.slice(0, 50)), lookup(emails.slice(50))]);
    expectNobodyAdded();
  });

  it("reads every batch before refusing, so it names the noted addresses from each", async () => {
    const list = listOf(60);
    userQueue.pending_login_emails = [notedAs("person2@example.com"), notedAs("person55@example.com")];
    await expect(createMembers(TEAM, list)).resolves.toEqual({
      ok: false,
      error:
        "These emails are already noted for someone else: person2@example.com, person55@example.com. Use other addresses, or change theirs first.",
    });
    expect(writes()).toHaveLength(2);
    expectNobodyAdded();
  });

  it("asks only about the addresses on the list, in reads of 50, when some people have none", async () => {
    const list = [...listOf(55), ...listOf(5, false)];
    userQueue.pending_login_emails = [notedAs(), notedAs()];
    await expect(createMembers(TEAM, list)).resolves.toEqual({ ok: true, value: { added: 60 } });
    const emails = addressesOf(listOf(55));
    expect(writes()).toEqual([lookup(emails.slice(0, 50)), lookup(emails.slice(50))]);
  });

  it.each([
    ["the first read", [leaky("08006")]],
    ["a later read", [notedAs(), leaky("08006")]],
  ])("says 'something went wrong' when %s of the noted addresses fails, logging only code and status", async (_label, reads) => {
    userQueue.pending_login_emails = reads;
    await expect(createMembers(TEAM, listOf(60))).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(console.error).toHaveBeenCalledExactlyOnceWith("createMembers emails failed", { code: "08006", status: undefined });
    expectNothingPersonalLogged();
    expectNobodyAdded();
  });

  it("says 'no permission' when RLS refuses the read of noted addresses", async () => {
    userQueue.pending_login_emails = [dbError("42501", "permission denied for table pending_login_emails")];
    await expect(createMembers(TEAM, listOf(1))).resolves.toEqual({ ok: false, error: NO_PERMISSION });
    expectNobodyAdded();
  });

  it.each([
    ["an archived node", "23514", "That team is archived. Restore it first, or pick another."],
    ["an archived domain", "23514", "That domain is archived. Restore it first, or pick another."],
    ["the organisation, refused by the database", "42501", "Only the project owner can place people in the organisation itself."],
    ["the function's own permission check", "42501", "Only admins can add people."],
  ])("shows the database's sentence as it is for %s, and refreshes nothing", async (_label, code, message) => {
    userQueue.pending_login_emails = [notedAs()];
    added = dbError(code, message);
    await expect(createMembers(TEAM, listOf(2))).resolves.toEqual({ ok: false, error: message });
    expect(console.error).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an address another admin noted meanwhile",
      dbError("23505", 'duplicate key value violates unique constraint "pending_login_emails_email_key"'),
      EMAIL_NOTED,
    ],
    [
      "an address the table's format check refuses",
      dbError("23514", 'new row for relation "pending_login_emails" violates check constraint "pending_login_emails_email_format"'),
      "Enter an email address like name@example.com.",
    ],
    ["RLS", dbError("42501", 'new row violates row-level security policy for table "members"'), NO_PERMISSION],
    ["a missing grant", dbError("42501", "permission denied for function admin_add_members"), NO_PERMISSION],
  ])("maps %s to its sentence, and refreshes nothing", async (_label, error, message) => {
    userQueue.pending_login_emails = [notedAs()];
    added = error;
    await expect(createMembers(TEAM, listOf(2))).resolves.toEqual({ ok: false, error: message });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["a dropped connection", "08006"],
    ["a node that doesn't exist", "23503"],
    ["a list the server should have refused", "22023"],
    ["the wrong isolation level", "25000"],
    ["a duplicate on another key", "23505"],
  ])("hides %s behind the generic sentence, logging only code and status, never a name or an address", async (_label, code) => {
    userQueue.pending_login_emails = [notedAs()];
    added = leaky(code);
    await expect(createMembers(TEAM, [ana])).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(console.error).toHaveBeenCalledExactlyOnceWith("createMembers failed", { code, status: undefined });
    expectNothingPersonalLogged();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  // No error means the transaction committed: saying it failed would have the list added twice on
  // a retry.
  it.each([
    ["nothing", null],
    ["a bare string", "ok"],
    ["too few ids", [newMemberId(0)]],
    ["too many ids", [newMemberId(0), newMemberId(1), newMemberId(2)]],
    ["an object", { ids: [newMemberId(0), newMemberId(1)] }],
  ])("counts an odd answer (%s) as everyone added, logs it, and refreshes the pages", async (_label, data) => {
    userQueue.pending_login_emails = [notedAs()];
    added = { data, error: null };
    await expect(createMembers(TEAM, listOf(2))).resolves.toEqual({ ok: true, value: { added: 2 } });
    expect(console.error).toHaveBeenCalledExactlyOnceWith("createMembers failed", { code: "bad_result", status: undefined });
    expectRevalidated();
  });

  it("adds by the node id the request gave, which Postgres reads in any letter case", async () => {
    userQueue.pending_login_emails = [notedAs()];
    await expect(createMembers(TEAM.toUpperCase(), listOf(1))).resolves.toEqual({ ok: true, value: { added: 1 } });
    expect((adds()[0][1] as { p_team_id: string }).p_team_id.toLowerCase()).toBe(TEAM);
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

// Before linking a login the invite only re-sent (made before it): is a removal about to delete
// that login (members.removed_login_id)?
const pendingRemoval = (login: string): Query => ({
  table: "members",
  calls: [["select", "id"], ["eq", "removed_login_id", login], ["limit", 1]],
});

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
    ["adding a list of new people to it", () => createMembers(ORG, [{ name: "Ana", role: "member", email: EMAIL }])],
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

  // The guarded link: only while the member still has no login, isn't removed and isn't a Master
  // Admin.
  const GIVE_LINK: Query = {
    table: "members",
    calls: [
      ["update", { auth_user_id: NEW_LOGIN, login_given_by: ADMIN, login_given_at: "2026-10-09T04:30:00.000Z" }],
      ["eq", "id", PERSON],
      ["is", "auth_user_id", null],
      ["is", "removed_at", null],
      ["neq", "role", "hq"],
      ["select", "id"],
    ],
  };
  // An invite that only re-sent a login made before it.
  const resent = () => ({ data: { user: { id: NEW_LOGIN, created_at: "2026-10-01T00:00:00.000Z" } }, error: null });

  it("invites the email, links the new login to the member and records who gave it", async () => {
    loginAllowed(rows(PERSON));

    await expect(giveLogin(PERSON, "  Mei.Wong@Example.com ")).resolves.toEqual({ ok: true, value: null });

    // 3. the member and their grants, and whether the address (as stored: trimmed, lower case) is
    // noted for someone else's invite (0014), read as the admin (RLS applies)
    expect(userQueries).toEqual([
      { table: "members", calls: [["select", "id, role, auth_user_id, removed_at"], ["eq", "id", PERSON], ["maybeSingle"]] },
      { table: "member_grants", calls: [["select", "grant_name"], ["eq", "member_id", PERSON], ["limit", 1]] },
      { table: "pending_login_emails", calls: [["select", "member_id"], ["eq", "email", EMAIL], ["limit", 1]] },
    ]);
    // 4. nothing from an earlier login, then the invite, coming back to the site's callback
    expect(storageFrom).toHaveBeenCalledExactlyOnceWith("checkin-audio");
    expect(listRecordings).toHaveBeenCalledExactlyOnceWith(PERSON, { limit: 1 });
    expect(inviteUserByEmail).toHaveBeenCalledExactlyOnceWith(EMAIL, {
      redirectTo: `${SITE}/auth/callback?next=/portal`,
    });
    // 5. the guarded link (this invite made the login, so no removal can be waiting on it)
    expect(serviceQueries).toEqual([
      ...HISTORY_QUERIES,
      GIVE_LINK,
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
    ["one this invite made", "2026-10-09T04:30:00.000Z", []],
    // A re-sent login is first checked for a removal waiting on it (none here).
    ["one it only re-sent", "2026-10-01T00:00:00.000Z", [rows()]],
  ])("deletes the login (%s) when the unlink fails twice, which unlinks the row too", async (_label, createdAt, pending) => {
    loginAllowed(...pending, rows(PERSON), dbError("08006", "down"), dbError("08006", "down"));
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

  // A removed row has no login, a member's role and no grants, so nothing else would stop it.
  it("refuses someone removed from Module One before reading their grants or using the service role", async () => {
    userQueue.members = [memberRow({ removed_at: "2026-10-08T09:00:00Z" })];
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: PERSON_REMOVED });
    expect(userQueries.map((q) => q.table)).toEqual(["members"]);
    expectNoServiceRole();
    expect(revalidatePath).not.toHaveBeenCalled();
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
    // An address parseEmail lets through and Auth's stricter check refuses (a non-ASCII local part).
    ["Auth's address check", { code: "validation_failed", status: 400 }, EMAIL_FORMAT],
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
    loginAllowed(rows(), rows()); // no removal waiting on it, then the guarded link reaches no row
    inviteUserByEmail.mockResolvedValue({ data: { user: { id: NEW_LOGIN, created_at: createdAt } }, error: null });
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: INVITE_RACE });
    expect(deleteUser).not.toHaveBeenCalled();
    // no "does anyone use it?" either
    expect(serviceQueries).toEqual([...HISTORY_QUERIES, pendingRemoval(NEW_LOGIN), GIVE_LINK]);
  });

  // A removal unlinks the login and deletes it afterwards; a re-sent invite for its address returns
  // that same login meanwhile. Linked here, the deletion would leave this row a dead login.
  it("refuses an address whose re-sent login a removal is about to delete, and links nothing", async () => {
    loginAllowed(rows("a0000000-0000-4000-8000-000000000003"));
    inviteUserByEmail.mockResolvedValue(resent());
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_TAKEN });
    expect(serviceQueries).toEqual([...HISTORY_QUERIES, pendingRemoval(NEW_LOGIN)]);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says 'something went wrong' when it can't tell whether a removal waits on the re-sent login, and links nothing", async () => {
    loginAllowed(dbError("08006", `down for ${EMAIL}`));
    inviteUserByEmail.mockResolvedValue(resent());
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(serviceQueries).toEqual([...HISTORY_QUERIES, pendingRemoval(NEW_LOGIN)]);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("giveLogin pending check failed", { code: "08006", status: undefined });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("links a re-sent login no removal waits on", async () => {
    loginAllowed(rows(), rows(PERSON));
    inviteUserByEmail.mockResolvedValue(resent());
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: true, value: null });
    expect(serviceQueries).toEqual([...HISTORY_QUERIES, pendingRemoval(NEW_LOGIN), GIVE_LINK, ...LATE_QUERIES]);
    expectRevalidated();
  });

  // The admin's read saw them not removed; a removal before the link must stop it.
  it("links nothing to someone removed meanwhile (the link skips removed rows), and deletes the new login", async () => {
    loginAllowed(rows(), rows()); // the guarded link reaches no row, then "does anyone use this login?"
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: INVITE_RACE });
    expect(serviceQueries[HISTORY_QUERIES.length]).toEqual(GIVE_LINK); // filtered on removed_at
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(NEW_LOGIN);
    expect(revalidatePath).not.toHaveBeenCalled();
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

  // Migration 0014: an address noted for someone's first invite is kept for them.
  const notedFor = (memberId: string) => ({ data: [{ member_id: memberId }], error: null });
  const NOTED_LOOKUP: Query = {
    table: "pending_login_emails",
    calls: [["select", "member_id"], ["eq", "email", EMAIL], ["limit", 1]],
  };

  it("refuses an address noted for someone else's invite, before any service-role call", async () => {
    loginAllowed(rows(PERSON));
    userQueue.pending_login_emails = [notedFor("a0000000-0000-4000-8000-000000000003")];
    await expect(giveLogin(PERSON, "  Mei.Wong@Example.com ")).resolves.toEqual({ ok: false, error: NOTED_FOR_SOMEONE_ELSE });
    // Asked about as it's stored: trimmed, lower case.
    expect(userQueries.map((q) => q.table)).toEqual(["members", "member_grants", "pending_login_emails"]);
    expect(userQueries[2]).toEqual(NOTED_LOOKUP);
    expectNoServiceRole();
    expect(listRecordings).not.toHaveBeenCalled();
    expect(serviceQueries).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("asks about the address after the member and their grants, and before any service-role call", async () => {
    loginAllowed(rows(PERSON));
    await giveLogin(PERSON, EMAIL);
    expect(from.mock.calls.map(([table]) => table)).toEqual(["members", "member_grants", "pending_login_emails"]);
    const [, grantsLoad, notedLoad] = from.mock.invocationCallOrder;
    expect(grantsLoad).toBeLessThan(notedLoad);
    expect(notedLoad).toBeLessThan(vi.mocked(createServiceRoleClient).mock.invocationCallOrder[0]);
  });

  it("doesn't ask about the address for someone it refuses anyway", async () => {
    userQueue.members = [memberRow()];
    userQueue.member_grants = [{ data: [{ grant_name: "admin" }], error: null }];
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: HOLDS_GRANTS });
    expect(userQueries.map((q) => q.table)).toEqual(["members", "member_grants"]);
  });

  it.each([
    ["as the request spells it", PERSON, PERSON],
    ["when the request spells the id in capitals", PERSON.toUpperCase(), PERSON],
    ["when the noted row spells the id in capitals", PERSON, PERSON.toUpperCase()],
  ])("goes ahead with an address noted for this same person (%s)", async (_label, requestId, notedId) => {
    loginAllowed(rows(PERSON));
    userQueue.pending_login_emails = [notedFor(notedId)];
    await expect(giveLogin(requestId, EMAIL)).resolves.toEqual({ ok: true, value: null });
    expect(userQueries[2]).toEqual(NOTED_LOOKUP);
    expect(inviteUserByEmail).toHaveBeenCalledExactlyOnceWith(EMAIL, { redirectTo: `${SITE}/auth/callback?next=/portal` });
    expectRevalidated();
  });

  it.each([
    ["PGRST205", "Could not find the table 'public.pending_login_emails' in the schema cache"],
    ["42P01", 'relation "public.pending_login_emails" does not exist'],
  ])("goes ahead when the table isn't there yet (%s, before migration 0014), logging nothing", async (code, message) => {
    loginAllowed(rows(PERSON));
    userQueue.pending_login_emails = [{ data: null, error: { code, message } }];
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: true, value: null });
    expect(inviteUserByEmail).toHaveBeenCalledOnce();
    expect(console.error).not.toHaveBeenCalled();
    expectRevalidated();
  });

  it("says 'something went wrong' when it can't tell whether the address is noted, without using the service role", async () => {
    loginAllowed(rows(PERSON));
    userQueue.pending_login_emails = [dbError("08006", `down for ${EMAIL}`)];
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expectNoServiceRole();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("giveLogin noted failed", { code: "08006", status: undefined });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("example.com");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says 'no permission' when RLS refuses that read, without using the service role", async () => {
    loginAllowed(rows(PERSON));
    userQueue.pending_login_emails = [dbError("42501", "permission denied for table pending_login_emails")];
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: false, error: NO_PERMISSION });
    expectNoServiceRole();
  });

  // Send invites (asNoted): the address must still be the one noted for this person, since the page
  // that sent it may be older than another admin's correction.
  const OWN_NOTE: Query = {
    table: "pending_login_emails",
    calls: [["select", "email"], ["eq", "member_id", PERSON], ["maybeSingle"]],
  };
  const ownNote = (email: string | null) => ({ data: email === null ? null : { email }, error: null });

  // Linked through link_noted_login (0014), which links only while the address is still the one
  // noted for them, in the same transaction: the note may change while the invite goes out.
  const LINK_AS_NOTED = ["link_noted_login", { p_member_id: PERSON, p_login: NEW_LOGIN, p_email: EMAIL, p_given_by: ADMIN }];
  const linkAnswers = (answer: Result) => serviceRpc.mockResolvedValue(answer);

  it("sends an invite as noted when the address is still the one noted for them, linking it as noted", async () => {
    loginAllowed();
    linkAnswers({ data: "linked", error: null });
    userQueue.pending_login_emails = [notedFor(PERSON), ownNote(EMAIL)];
    await expect(giveLogin(PERSON, "  Mei.Wong@Example.com ", true)).resolves.toEqual({ ok: true, value: null });
    expect(userQueries.map((q) => q.table)).toEqual(["members", "member_grants", "pending_login_emails", "pending_login_emails"]);
    expect(userQueries[3]).toEqual(OWN_NOTE);
    expect(inviteUserByEmail).toHaveBeenCalledExactlyOnceWith(EMAIL, { redirectTo: `${SITE}/auth/callback?next=/portal` });
    expect(serviceRpc).toHaveBeenCalledExactlyOnceWith(...LINK_AS_NOTED);
    // No plain link: only link_noted_login, then the late checks.
    expect(serviceQueries).toEqual([...HISTORY_QUERIES, ...LATE_QUERIES]);
    expect(deleteUser).not.toHaveBeenCalled();
    expectRevalidated();
  });

  it("deletes the new login, so the emailed link opens nothing, when the note changed while the invite went out", async () => {
    loginAllowed(rows()); // "does anyone use this login?" before deleting it
    linkAnswers({ data: "note_changed", error: null });
    userQueue.pending_login_emails = [rows(), ownNote(EMAIL)];
    await expect(giveLogin(PERSON, EMAIL, true)).resolves.toEqual({ ok: false, error: NOTE_CHANGED });
    expect(inviteUserByEmail).toHaveBeenCalledOnce();
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(NEW_LOGIN);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says the person changed when they have a login, were removed or are a Master Admin by the link, deleting the new login", async () => {
    loginAllowed(rows());
    linkAnswers({ data: "changed", error: null });
    userQueue.pending_login_emails = [rows(), ownNote(EMAIL)];
    await expect(giveLogin(PERSON, EMAIL, true)).resolves.toEqual({ ok: false, error: INVITE_RACE });
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(NEW_LOGIN);
  });

  it("says the email is taken when its login already belongs to another member, deleting nothing", async () => {
    loginAllowed();
    linkAnswers(dbError("23505", 'duplicate key value violates unique constraint "members_auth_user_id_key"'));
    userQueue.pending_login_emails = [rows(), ownNote(EMAIL)];
    await expect(giveLogin(PERSON, EMAIL, true)).resolves.toEqual({ ok: false, error: EMAIL_TAKEN });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("cleans up and says 'something went wrong' when linking as noted fails otherwise, logging only code and status", async () => {
    loginAllowed(rows());
    linkAnswers(dbError("08006", `down for ${EMAIL}`));
    userQueue.pending_login_emails = [rows(), ownNote(EMAIL)];
    await expect(giveLogin(PERSON, EMAIL, true)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(NEW_LOGIN);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("giveLogin link failed", { code: "08006", status: undefined });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("example.com");
  });

  it("treats an answer it doesn't know as the person having changed, and logs it", async () => {
    loginAllowed(rows());
    linkAnswers({ data: "linked-ish", error: null });
    userQueue.pending_login_emails = [rows(), ownNote(EMAIL)];
    await expect(giveLogin(PERSON, EMAIL, true)).resolves.toEqual({ ok: false, error: INVITE_RACE });
    expect(console.error).toHaveBeenCalledWith("giveLogin link failed", { code: "bad_result", status: undefined });
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(NEW_LOGIN);
  });

  it("never links as noted for Give login on a row: that uses the plain link", async () => {
    loginAllowed(rows(PERSON));
    await expect(giveLogin(PERSON, EMAIL)).resolves.toEqual({ ok: true, value: null });
    expect(serviceRpc).not.toHaveBeenCalledWith("link_noted_login", expect.anything());
  });

  it.each([
    ["another address is noted for them now", ownNote("mei@example.org")],
    ["their address was forgotten", ownNote(null)],
    ["the table isn't there yet (nothing is noted)", { data: null, error: { code: "PGRST205", message: "no table" } }],
  ])("refuses an invite as noted when %s, before any service-role call", async (_label, own) => {
    loginAllowed(rows(PERSON));
    userQueue.pending_login_emails = [rows(), own];
    await expect(giveLogin(PERSON, EMAIL, true)).resolves.toEqual({ ok: false, error: NOTE_CHANGED });
    expectNoServiceRole();
    expect(inviteUserByEmail).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says 'something went wrong' when it can't read their note, logging only code and status", async () => {
    loginAllowed(rows(PERSON));
    userQueue.pending_login_emails = [rows(), dbError("08006", `down for ${EMAIL}`)];
    await expect(giveLogin(PERSON, EMAIL, true)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expectNoServiceRole();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("giveLogin own note failed", { code: "08006", status: undefined });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("example.com");
  });

  it.each([["yes"], [1], [{}]])("reads only true as 'as noted', not %j, so a forged flag changes nothing", async (flag) => {
    loginAllowed(rows(PERSON));
    await expect(giveLogin(PERSON, EMAIL, flag as never)).resolves.toEqual({ ok: true, value: null });
    expect(userQueries.map((q) => q.table)).toEqual(["members", "member_grants", "pending_login_emails"]);
  });

  it("checks someone else's note first: an address noted for another person is refused as such", async () => {
    loginAllowed(rows(PERSON));
    userQueue.pending_login_emails = [notedFor("a0000000-0000-4000-8000-000000000003")];
    await expect(giveLogin(PERSON, EMAIL, true)).resolves.toEqual({ ok: false, error: NOTED_FOR_SOMEONE_ELSE });
    expect(userQueries.map((q) => q.table)).toEqual(["members", "member_grants", "pending_login_emails"]);
  });
});

// ---------- setPendingEmail ----------

describe("setPendingEmail", () => {
  const LOAD: Query = {
    table: "members",
    calls: [["select", "id, role, auth_user_id, removed_at"], ["eq", "id", PERSON], ["maybeSingle"]],
  };
  const GRANTS: Query = { table: "member_grants", calls: [["select", "grant_name"], ["eq", "member_id", PERSON], ["limit", 1]] };
  // Change the noted address only while it's still the one the page showed; note one only while
  // there's none; forget it only while it's still the one shown. Only the person and the address
  // are written: who noted it, and when, are the trigger's (0014).
  const CHANGE = (from: string, to: string): Query => ({
    table: "pending_login_emails",
    calls: [["update", { email: to }], ["eq", "member_id", PERSON], ["eq", "email", from], ["select", "member_id"]],
  });
  const NOTE = (email: string): Query => ({ table: "pending_login_emails", calls: [["insert", { member_id: PERSON, email }]] });
  const FORGET = (email: string): Query => ({
    table: "pending_login_emails",
    calls: [["delete"], ["eq", "member_id", PERSON], ["eq", "email", email], ["select", "member_id"]],
  });
  const changed = (...ids: string[]) => ({ data: ids.map((member_id) => ({ member_id })), error: null });
  const LATER = "mei.w@example.net";

  // Someone an address may be noted for (no login, no grants), then what the writes answer.
  function emailAllowed(...answers: Result[]) {
    userQueue.members = [memberRow()];
    userQueue.member_grants = [rows()];
    userQueue.pending_login_emails = answers;
  }
  const pendingWrites = () => userQueries.filter((q) => q.table === "pending_login_emails");
  const expectNothingNoted = () => {
    expect(pendingWrites()).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  };

  it("notes an address for someone who has none yet, as it's stored, and refreshes the pages", async () => {
    emailAllowed(done());
    await expect(setPendingEmail(PERSON, "  Mei.Wong@Example.com ", null)).resolves.toEqual({ ok: true, value: null });
    // Checked as the admin (RLS applies), then noted.
    expect(userQueries).toEqual([LOAD, GRANTS, NOTE(EMAIL)]);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(inviteUserByEmail).not.toHaveBeenCalled();
    expectRevalidated();
  });

  it("changes the noted address only while it's still the one the page showed, read as it's stored", async () => {
    emailAllowed(changed(PERSON));
    await expect(setPendingEmail(PERSON, LATER, "  MEI.WONG@example.com ")).resolves.toEqual({ ok: true, value: null });
    expect(userQueries).toEqual([LOAD, GRANTS, CHANGE(EMAIL, LATER)]);
    expectRevalidated();
  });

  it("says the note changed when another admin changed or forgot it since the page loaded, changing nothing", async () => {
    emailAllowed(changed());
    await expect(setPendingEmail(PERSON, LATER, EMAIL)).resolves.toEqual({ ok: false, error: NOTE_CHANGED });
    expect(pendingWrites()).toEqual([CHANGE(EMAIL, LATER)]);
    expect(console.error).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says the note changed when another admin noted one since the page loaded, keeping theirs", async () => {
    emailAllowed(dbError("23505", 'duplicate key value violates unique constraint "pending_login_emails_pkey"'));
    await expect(setPendingEmail(PERSON, EMAIL, null)).resolves.toEqual({ ok: false, error: NOTE_CHANGED });
    expect(pendingWrites()).toEqual([NOTE(EMAIL)]);
    expect(console.error).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("reads and writes by the id in lower case, whatever case the request used", async () => {
    emailAllowed(done());
    await expect(setPendingEmail(PERSON.toUpperCase(), EMAIL, null)).resolves.toEqual({ ok: true, value: null });
    expect(userQueries).toEqual([LOAD, GRANTS, NOTE(EMAIL)]);
  });

  it("forgets the noted address while it's still the one shown, without checking the person, and refreshes the pages", async () => {
    userQueue.pending_login_emails = [changed(PERSON)];
    await expect(setPendingEmail(PERSON, null, " Mei.Wong@Example.com")).resolves.toEqual({ ok: true, value: null });
    expect(userQueries).toEqual([FORGET(EMAIL)]);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expectRevalidated();
  });

  it("says the note changed when forgetting reaches no row (changed or forgotten meanwhile)", async () => {
    userQueue.pending_login_emails = [changed()];
    await expect(setPendingEmail(PERSON, null, EMAIL)).resolves.toEqual({ ok: false, error: NOTE_CHANGED });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("forgets by the id in lower case", async () => {
    userQueue.pending_login_emails = [changed(PERSON)];
    await expect(setPendingEmail(PERSON.toUpperCase(), null, EMAIL)).resolves.toEqual({ ok: true, value: null });
    expect(userQueries).toEqual([FORGET(EMAIL)]);
  });

  it.each([
    ["RLS", dbError("42501", "permission denied for table pending_login_emails"), NO_PERMISSION],
    ["a dropped connection", dbError("08006", `down for ${EMAIL}`), GENERIC_ERROR],
  ])("says so when forgetting fails (%s), refreshing nothing", async (_label, error, message) => {
    userQueue.pending_login_emails = [error];
    await expect(setPendingEmail(PERSON, null, EMAIL)).resolves.toEqual({ ok: false, error: message });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("example.com");
  });

  it("logs a failed forget with its code and status only", async () => {
    userQueue.pending_login_emails = [dbError("08006", `down for ${EMAIL}`)];
    await setPendingEmail(PERSON, null, EMAIL);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("setPendingEmail forget failed", { code: "08006", status: undefined });
  });

  it.each([
    ["a bad id", () => setPendingEmail("x", EMAIL, null)],
    ["a bad id, forgetting", () => setPendingEmail("x", null, EMAIL)],
    ["an id that isn't a string", () => setPendingEmail(42 as never, EMAIL, null)],
    ["no id, forgetting", () => setPendingEmail(null as never, null, EMAIL)],
    ["an id with SQL in it", () => setPendingEmail(`${PERSON}' or '1'='1`, null, EMAIL)],
    ["nothing to forget (no address shown)", () => setPendingEmail(PERSON, null, null)],
    ["no current address at all (an older page)", () => setPendingEmail(PERSON, EMAIL, undefined as never)],
    ["a current address that isn't text", () => setPendingEmail(PERSON, EMAIL, 42 as never)],
    ["a current address that isn't an address", () => setPendingEmail(PERSON, null, "not an address")],
  ])("refuses %s without reading or writing anything", async (_label, run) => {
    await expect(run()).resolves.toEqual({ ok: false, error: BAD_REQUEST });
    expectNothingWritten();
  });

  // Only null forgets: a client that sends nothing, or an empty field, is told to enter an address.
  it.each([
    ["an empty address", () => setPendingEmail(PERSON, "", null), "Enter an email address."],
    ["only spaces", () => setPendingEmail(PERSON, "   ", null), "Enter an email address."],
    ["no address at all", () => setPendingEmail(PERSON, undefined as never, null), "Enter an email address."],
    ["an address that isn't text", () => setPendingEmail(PERSON, { toString: () => EMAIL } as never, null), "Enter an email address."],
    ["two @s", () => setPendingEmail(PERSON, "a@b@example.com", null), "Enter an email address like name@example.com."],
    ["no dot in the domain", () => setPendingEmail(PERSON, "mei@localhost", EMAIL), "Enter an email address like name@example.com."],
    ["a space", () => setPendingEmail(PERSON, "mei wong@example.com", null), "Email addresses can't contain spaces."],
    ["a control character", () => setPendingEmail(PERSON, "mei\u0000@example.com", null), "Email addresses can't contain spaces."],
    ["a long address", () => setPendingEmail(PERSON, `${"m".repeat(250)}@example.com`, null), "Email addresses can be at most 254 characters."],
  ])("refuses %s without reading or writing anything", async (_label, run, error) => {
    await expect(run()).resolves.toEqual({ ok: false, error });
    expectNothingWritten();
  });

  it.each([
    ["isn't there (or RLS hides them)", { data: null, error: null }, PERSON_GONE],
    ["was removed from Module One", memberRow({ removed_at: "2026-10-08T09:00:00Z" }), PERSON_REMOVED],
    ["is the admin themselves", memberRow({ id: ADMIN, auth_user_id: ADMIN_AUTH }), EMAIL_NOT_YOURSELF],
    ["is the admin themselves, a Master Admin", memberRow({ id: ADMIN, role: "hq", auth_user_id: ADMIN_AUTH }), EMAIL_NOT_YOURSELF],
    ["is a Master Admin", memberRow({ role: "hq" }), MASTER_ADMIN_LOGIN],
    ["is a Master Admin with a login", memberRow({ role: "hq", auth_user_id: LOGIN }), MASTER_ADMIN_LOGIN],
    ["has a login", memberRow({ auth_user_id: LOGIN }), PENDING_HAS_LOGIN],
  ])("refuses someone who %s before reading their grants, noting nothing", async (_label, row, error) => {
    userQueue.members = [row];
    await expect(setPendingEmail(PERSON, EMAIL, null)).resolves.toEqual({ ok: false, error });
    expect(userQueries).toEqual([LOAD]);
    expectNothingNoted();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("refuses the admin's own row whatever case the request used", async () => {
    userQueue.members = [memberRow({ id: ADMIN, auth_user_id: ADMIN_AUTH })];
    await expect(setPendingEmail(ADMIN.toUpperCase(), EMAIL, null)).resolves.toEqual({ ok: false, error: EMAIL_NOT_YOURSELF });
    expect(userQueries[0].calls).toContainEqual(["eq", "id", ADMIN]);
    expectNothingNoted();
  });

  it("refuses someone who holds a grant, noting nothing", async () => {
    userQueue.members = [memberRow()];
    userQueue.member_grants = [{ data: [{ grant_name: "big_five" }], error: null }];
    await expect(setPendingEmail(PERSON, EMAIL, null)).resolves.toEqual({ ok: false, error: HOLDS_GRANTS });
    expect(userQueries).toEqual([LOAD, GRANTS]);
    expectNothingNoted();
  });

  it.each([
    ["the person", () => (userQueue.members = [dbError("08006", `down for ${EMAIL}`)]), "setPendingEmail load failed"],
    [
      "their grants",
      () => {
        userQueue.members = [memberRow()];
        userQueue.member_grants = [dbError("08006", `down for ${EMAIL}`)];
      },
      "setPendingEmail grants failed",
    ],
  ])("says 'something went wrong' when %s can't be read, noting nothing and logging only code and status", async (_label, arrange, context) => {
    arrange();
    await expect(setPendingEmail(PERSON, EMAIL, null)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(console.error).toHaveBeenCalledExactlyOnceWith(context, { code: "08006", status: undefined });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("example.com");
    expectNothingNoted();
  });

  const EMAIL_KEY = dbError("23505", 'duplicate key value violates unique constraint "pending_login_emails_email_key"');
  it.each([
    ["changing theirs", LATER, EMAIL, CHANGE(LATER, EMAIL)],
    ["noting one", null, EMAIL, NOTE(EMAIL)],
  ])("says the address is noted for someone else already (%s)", async (_label, current, email, query) => {
    emailAllowed(EMAIL_KEY);
    await expect(setPendingEmail(PERSON, email, current)).resolves.toEqual({ ok: false, error: EMAIL_NOTED });
    expect(pendingWrites()).toEqual([query]);
    expect(console.error).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  // The trigger re-checks the person on every write (they may have changed since the read).
  const TRIGGER_REFUSALS: [string, string][] = [
    ["P0002", PERSON_GONE],
    ["23514", PERSON_REMOVED],
    ["23514", MASTER_ADMIN_LOGIN],
    ["23514", PENDING_HAS_LOGIN],
    ["23514", HOLDS_GRANTS],
  ];
  it.each(
    TRIGGER_REFUSALS.flatMap(([code, message]): [string, string, string | null][] => [
      [`changing theirs (${code})`, message, LATER],
      [`noting one (${code})`, message, null],
    ]),
  )("shows the trigger's sentence as it is when %s: %s", async (label, message, current) => {
    emailAllowed(dbError(label.match(/\((\w+)\)/)![1], message));
    await expect(setPendingEmail(PERSON, EMAIL, current)).resolves.toEqual({ ok: false, error: message });
    expect(console.error).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses in the same words as migration 0014's trigger", () => {
    const migration = readFileSync(new URL("../../../../../supabase/migrations/0014_pending_emails.sql", import.meta.url), "utf8");
    for (const [, message] of TRIGGER_REFUSALS) expect(migration).toContain(`'${message.replaceAll("'", "''")}'`);
  });

  it("says what the table's format check means rather than Postgres's words", async () => {
    emailAllowed(
      dbError("23514", 'new row for relation "pending_login_emails" violates check constraint "pending_login_emails_email_format"'),
    );
    await expect(setPendingEmail(PERSON, EMAIL, null)).resolves.toEqual({
      ok: false,
      error: "Enter an email address like name@example.com.",
    });
  });

  it.each([
    ["changing theirs", LATER, "setPendingEmail change failed"],
    ["noting one", null, "setPendingEmail note failed"],
  ])("hides any other failure %s behind the generic sentence, logging only code and status", async (_label, current, context) => {
    emailAllowed(dbError("08006", `down for ${EMAIL}`));
    await expect(setPendingEmail(PERSON, EMAIL, current)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(console.error).toHaveBeenCalledExactlyOnceWith(context, { code: "08006", status: undefined });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/@|example/);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says 'no permission' when RLS refuses the write", async () => {
    emailAllowed(dbError("42501", 'new row violates row-level security policy for table "pending_login_emails"'));
    await expect(setPendingEmail(PERSON, EMAIL, null)).resolves.toEqual({ ok: false, error: NO_PERMISSION });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("checks the admin grant before reading the person", async () => {
    emailAllowed(done());
    await setPendingEmail(PERSON, EMAIL, null);
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(from.mock.invocationCallOrder[0]);
    expect(rpc).toHaveBeenCalledWith("app_has_grant", { requested: "admin" });
  });
});

// ---------- resendInvite ----------

describe("resendInvite", () => {
  const invited = (changes: Record<string, unknown> = {}) => ({
    data: { id: PERSON, role: "member", auth_user_id: LOGIN, login_given_at: "2026-10-09T04:30:00Z", removed_at: null, ...changes },
    error: null,
  });
  const authUser = (changes: Record<string, unknown> = {}) => ({
    data: { user: { id: LOGIN, email: EMAIL, email_confirmed_at: null, last_sign_in_at: null, ...changes } },
    error: null,
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T04:30:00.000Z"));
    getUserById.mockResolvedValue(authUser());
    inviteUserByEmail.mockResolvedValue({ data: { user: { id: LOGIN } }, error: null });
  });
  // The address left this login meanwhile (its email was changed, or the login was deleted), so
  // the invite went to a login of its own, made by this invite or (made before it) only re-sent.
  const otherLogin = (createdAt = "2026-10-09T04:30:00.000Z") => ({
    data: { user: { id: NEW_LOGIN, created_at: createdAt } },
    error: null,
  });

  function expectNoServiceRole() {
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
    expect(inviteUserByEmail).not.toHaveBeenCalled();
  }

  it("re-sends the invite to the address of a login given here and not used yet, and refreshes the rows that say when it went out", async () => {
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
    // No member row is written and no login deleted, but each row shows when its invite went out.
    expect(serviceFrom).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    expectRevalidated();
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
    // Removing someone unlinks their login and keeps login_given_at.
    ["was removed from Module One", invited({ removed_at: "2026-10-08T09:00:00Z", auth_user_id: null }), PERSON_REMOVED],
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
    ["Auth's address check", { code: "validation_failed", status: 400 }, EMAIL_FORMAT],
    ["a server error", { code: "unexpected_failure", status: 500 }, GENERIC_ERROR],
  ])("maps an invite failure (%s)", async (_label, error, message) => {
    userQueue.members = [invited()];
    inviteUserByEmail.mockResolvedValue({ data: { user: null }, error: { ...error, name: "AuthApiError", message: EMAIL } });
    await expect(resendInvite(PERSON)).resolves.toEqual({ ok: false, error: message });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("refreshes nothing when no invite went out: a used login, a failed invite, or one for another login", async () => {
    userQueue.members = [invited(), invited(), invited()];
    getUserById.mockResolvedValueOnce(authUser({ last_sign_in_at: "2026-10-09T04:00:00Z" }));
    await expect(resendInvite(PERSON)).resolves.toEqual({ ok: false, error: INVITE_USED });
    inviteUserByEmail.mockResolvedValueOnce({ data: { user: null }, error: { name: "AuthApiError", status: 500, code: "unexpected_failure" } });
    await expect(resendInvite(PERSON)).resolves.toMatchObject({ ok: false });
    inviteUserByEmail.mockResolvedValueOnce(otherLogin("2026-10-01T00:00:00.000Z"));
    await expect(resendInvite(PERSON)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says 'something went wrong' if the invite comes back for another login, and deletes nothing", async () => {
    userQueue.members = [invited()];
    inviteUserByEmail.mockResolvedValue({ data: { user: { id: NEW_LOGIN } }, error: null });
    await expect(resendInvite(PERSON)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("deletes the login an invite for another login made, which no member row uses", async () => {
    userQueue.members = [invited()];
    inviteUserByEmail.mockResolvedValue(otherLogin());
    serviceQueue.members = [rows()];
    await expect(resendInvite(PERSON)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(serviceQueries).toEqual([
      { table: "members", calls: [["select", "id"], ["eq", "auth_user_id", NEW_LOGIN], ["limit", 1]] },
    ]);
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(NEW_LOGIN);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("resendInvite invite failed", { code: "other_user", status: undefined });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("never deletes another login made before the invite (one it only re-sent)", async () => {
    userQueue.members = [invited()];
    inviteUserByEmail.mockResolvedValue(otherLogin("2026-10-09T04:29:59.999Z"));
    await expect(resendInvite(PERSON)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(serviceFrom).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("never deletes another login a member row uses", async () => {
    userQueue.members = [invited()];
    inviteUserByEmail.mockResolvedValue(otherLogin());
    serviceQueue.members = [rows("a0000000-0000-4000-8000-000000000003")];
    await expect(resendInvite(PERSON)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("still says 'something went wrong' when deleting that login fails, and logs only code and status", async () => {
    userQueue.members = [invited()];
    inviteUserByEmail.mockResolvedValue(otherLogin());
    serviceQueue.members = [rows()];
    deleteUser.mockResolvedValue({ data: null, error: { code: "unexpected_failure", status: 500, message: EMAIL } });
    await expect(resendInvite(PERSON)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(console.error).toHaveBeenLastCalledWith("resendInvite cleanup failed", { code: "unexpected_failure", status: 500 });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("example.com");
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

// ---------- removePerson ----------

describe("removePerson", () => {
  // The row as the admin reads it first: does it have a login, or one still to delete?
  const personRow = (changes: Record<string, unknown> = {}) => ({
    data: { auth_user_id: null, removed_login_id: null, ...changes },
    error: null,
  });
  // What admin_remove_member returns.
  const removed = (outcome: string, loginId: string | null = null) => ({ data: { outcome, login_id: loginId }, error: null });
  const LOAD: Query = {
    table: "members",
    calls: [["select", "auth_user_id, removed_login_id"], ["eq", "id", PERSON], ["maybeSingle"]],
  };
  // Closing the login: does a member row use it now? Then, once it's dealt with, the row no
  // longer says it's still to delete.
  const LOGIN_CHECK: Query = { table: "members", calls: [["select", "id"], ["eq", "auth_user_id", LOGIN], ["limit", 1]] };
  const CLEAR: Query = {
    table: "members",
    calls: [["update", { removed_login_id: null }], ["eq", "id", PERSON], ["eq", "removed_login_id", LOGIN]],
  };
  // After deleting it: a row given the login between the check and the delete holds a dead one, so
  // it's unlinked (and reads "No login yet").
  const RELINK_CHECK: Query = {
    table: "members",
    calls: [["update", { auth_user_id: null, login_given_by: null, login_given_at: null }], ["eq", "auth_user_id", LOGIN]],
  };
  // The service role's members queue when nothing uses the login: the check, the unlink after the
  // delete, the clear.
  const closes = () => [rows(), done(), done()];
  const removeCalls = () => rpc.mock.calls.filter(([fn]) => fn === "admin_remove_member");
  const missingKey = () =>
    vi.mocked(createServiceRoleClient).mockImplementation(() => {
      throw new MissingServiceKeyError();
    });

  it("deletes someone who never had a login and left nothing, without the service role", async () => {
    userQueue.members = [personRow()];
    removal = removed("deleted");
    await expect(removePerson(PERSON)).resolves.toEqual({ ok: true, value: { outcome: "deleted", loginKept: false } });
    expect(userQueries).toEqual([LOAD]);
    expect(removeCalls()).toEqual([["admin_remove_member", { p_member_id: PERSON }]]);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    expectRevalidated();
  });

  it("removes someone kept for what they left behind, without the service role when they had no login", async () => {
    userQueue.members = [personRow()];
    removal = removed("removed");
    await expect(removePerson(PERSON)).resolves.toEqual({ ok: true, value: { outcome: "removed", loginKept: false } });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expectRevalidated();
  });

  it("removes someone with a login, then closes it (a soft delete) and clears removed_login_id", async () => {
    userQueue.members = [personRow({ auth_user_id: LOGIN })];
    removal = removed("removed", LOGIN);
    serviceQueue.members = closes();
    await expect(removePerson(PERSON)).resolves.toEqual({ ok: true, value: { outcome: "removed", loginKept: false } });
    expect(removeCalls()).toEqual([["admin_remove_member", { p_member_id: PERSON }]]);
    // Soft: the auth.users row stays, and with it the privacy-notice acceptances it gave.
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(LOGIN, true);
    // Then any row given the login meanwhile is unlinked; the clear is filtered on the login too,
    // so it never clears one a later removal recorded.
    expect(serviceQueries).toEqual([LOGIN_CHECK, RELINK_CHECK, CLEAR]);
    expect(console.error).not.toHaveBeenCalled();
    expectRevalidated();
  });

  it("reads the row as the admin and removes them before touching their login with the service role", async () => {
    userQueue.members = [personRow({ auth_user_id: LOGIN })];
    removal = removed("removed", LOGIN);
    serviceQueue.members = closes();
    await removePerson(PERSON);
    const grantCheck = rpc.mock.invocationCallOrder[0];
    const load = from.mock.invocationCallOrder[0];
    const remove = rpc.mock.invocationCallOrder[rpc.mock.calls.findIndex(([fn]) => fn === "admin_remove_member")];
    expect(grantCheck).toBeLessThan(load);
    expect(load).toBeLessThan(vi.mocked(createServiceRoleClient).mock.invocationCallOrder[0]);
    expect(load).toBeLessThan(remove);
    expect(remove).toBeLessThan(serviceFrom.mock.invocationCallOrder[0]);
    expect(remove).toBeLessThan(deleteUser.mock.invocationCallOrder[0]);
  });

  it("finishes an earlier removal whose login is still to delete", async () => {
    userQueue.members = [personRow({ removed_login_id: LOGIN })];
    removal = removed("removed", LOGIN); // already removed: it hands back the login still to delete
    serviceQueue.members = closes();
    await expect(removePerson(PERSON)).resolves.toEqual({ ok: true, value: { outcome: "removed", loginKept: false } });
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(LOGIN, true);
    expect(serviceQueries).toEqual([LOGIN_CHECK, RELINK_CHECK, CLEAR]);
  });

  it.each([
    ["a login", { auth_user_id: LOGIN }],
    ["a login still to delete from an earlier removal", { removed_login_id: LOGIN }],
  ])("refuses someone with %s when there's no service key, before removing anything", async (_label, changes) => {
    userQueue.members = [personRow(changes)];
    missingKey();
    await expect(removePerson(PERSON)).resolves.toEqual({ ok: false, error: REMOVE_NEEDS_SERVICE_KEY });
    expect(removeCalls()).toEqual([]);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("hides any other problem making the client, before removing anything", async () => {
    userQueue.members = [personRow({ auth_user_id: LOGIN })];
    vi.mocked(createServiceRoleClient).mockImplementation(() => {
      throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
    });
    await expect(removePerson(PERSON)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(removeCalls()).toEqual([]);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("removePerson client failed", { code: undefined, status: undefined });
  });

  it("removes someone without a login when there's no service key", async () => {
    userQueue.members = [personRow()];
    missingKey();
    removal = removed("deleted");
    await expect(removePerson(PERSON)).resolves.toEqual({ ok: true, value: { outcome: "deleted", loginKept: false } });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expectRevalidated();
  });

  it("still closes a login given after it read the row", async () => {
    userQueue.members = [personRow()];
    removal = removed("removed", LOGIN);
    serviceQueue.members = closes();
    await expect(removePerson(PERSON)).resolves.toEqual({ ok: true, value: { outcome: "removed", loginKept: false } });
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(LOGIN, true);
  });

  it("says the login was kept when one given after it read the row can't be closed for want of a service key", async () => {
    userQueue.members = [personRow()];
    removal = removed("removed", LOGIN);
    missingKey();
    await expect(removePerson(PERSON)).resolves.toEqual({ ok: true, value: { outcome: "removed", loginKept: true } });
    expect(deleteUser).not.toHaveBeenCalled();
    expectRevalidated();
  });

  it.each([
    "Master Admins can't be removed here. The project owner looks after them.",
    "You can't remove yourself.",
    "This person holds grants (such as admin), so only the project owner can remove them.",
    "This person sits in or leads the organisation, so only the project owner can remove them.",
  ])("shows the database's refusal as it is: %s", async (message) => {
    userQueue.members = [personRow({ auth_user_id: LOGIN })];
    removal = dbError("23514", message);
    await expect(removePerson(PERSON)).resolves.toEqual({ ok: false, error: message });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(serviceFrom).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("shows the function's own permission refusal, and 'no permission' for any other", async () => {
    userQueue.members = [personRow()];
    removal = dbError("42501", "Only admins can remove people.");
    await expect(removePerson(PERSON)).resolves.toEqual({ ok: false, error: "Only admins can remove people." });
    userQueue.members = [personRow()];
    removal = dbError("42501", "permission denied for function admin_remove_member");
    await expect(removePerson(PERSON)).resolves.toEqual({ ok: false, error: NO_PERMISSION });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("hides other failures behind the generic sentence and logs only code and status", async () => {
    userQueue.members = [personRow()];
    removal = dbError("25000", "Change the team tree in a READ COMMITTED transaction.");
    await expect(removePerson(PERSON)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(console.error).toHaveBeenCalledExactlyOnceWith("removePerson failed", { code: "25000", status: undefined });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["nothing", null],
    ["no outcome", { login_id: null }],
    ["an unknown outcome", { outcome: "archived", login_id: null }],
    ["a login id that isn't a uuid", { outcome: "removed", login_id: "mei.wong@example.com" }],
    ["a login id that isn't a string", { outcome: "removed", login_id: 42 }],
    ["a bare string", "removed"],
  ])("says 'something went wrong' when admin_remove_member returns %s, and deletes no login", async (_label, data) => {
    userQueue.members = [personRow()];
    removal = { data, error: null };
    await expect(removePerson(PERSON)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(console.error).toHaveBeenCalledExactlyOnceWith("removePerson failed", { code: "bad_result", status: undefined });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says 'something went wrong' when the row can't be read, and removes nothing", async () => {
    userQueue.members = [dbError("08006", "down")];
    await expect(removePerson(PERSON)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(removeCalls()).toEqual([]);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("removePerson load failed", { code: "08006", status: undefined });
  });

  it("never deletes or unlinks a login a member row uses again (it's theirs now), and still clears removed_login_id", async () => {
    userQueue.members = [personRow({ auth_user_id: LOGIN })];
    removal = removed("removed", LOGIN);
    serviceQueue.members = [rows("a0000000-0000-4000-8000-000000000003"), done()];
    await expect(removePerson(PERSON)).resolves.toEqual({ ok: true, value: { outcome: "removed", loginKept: false } });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(serviceQueries).toEqual([LOGIN_CHECK, CLEAR]);
  });

  it("counts a login that's gone already (404) as closed", async () => {
    userQueue.members = [personRow({ auth_user_id: LOGIN })];
    removal = removed("removed", LOGIN);
    serviceQueue.members = closes();
    deleteUser.mockResolvedValue({ data: null, error: { name: "AuthApiError", status: 404, code: "user_not_found" } });
    await expect(removePerson(PERSON)).resolves.toEqual({ ok: true, value: { outcome: "removed", loginKept: false } });
    expect(serviceQueries).toEqual([LOGIN_CHECK, RELINK_CHECK, CLEAR]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("says the login was kept when deleting it fails, unlinks nothing, leaves removed_login_id, and logs only code and status", async () => {
    userQueue.members = [personRow({ auth_user_id: LOGIN })];
    removal = removed("removed", LOGIN);
    serviceQueue.members = [rows()];
    deleteUser.mockResolvedValue({
      data: null,
      error: { name: "AuthApiError", status: 500, code: "unexpected_failure", message: `Couldn't delete ${EMAIL}` },
    });
    await expect(removePerson(PERSON)).resolves.toEqual({ ok: true, value: { outcome: "removed", loginKept: true } });
    expect(serviceQueries).toEqual([LOGIN_CHECK]);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("removePerson login failed", { code: "unexpected_failure", status: 500 });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("example.com");
    expectRevalidated();
  });

  it("says the login was kept when it can't tell whether a member row uses it", async () => {
    userQueue.members = [personRow({ auth_user_id: LOGIN })];
    removal = removed("removed", LOGIN);
    serviceQueue.members = [dbError("08006", "down")];
    await expect(removePerson(PERSON)).resolves.toEqual({ ok: true, value: { outcome: "removed", loginKept: true } });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("removePerson login check failed", { code: "08006", status: undefined });
  });

  it("counts the login as closed when only clearing removed_login_id fails, and logs it", async () => {
    userQueue.members = [personRow({ auth_user_id: LOGIN })];
    removal = removed("removed", LOGIN);
    serviceQueue.members = [rows(), done(), dbError("08006", "down")];
    await expect(removePerson(PERSON)).resolves.toEqual({ ok: true, value: { outcome: "removed", loginKept: false } });
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(LOGIN, true);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("removePerson clear failed", { code: "08006", status: undefined });
  });

  // giveLogin re-sends a pending invite to the same login, so a row may be given it between the
  // check and the delete: that row then holds a dead login, and is unlinked.
  it("unlinks a row given the login between the check and the delete, after deleting it", async () => {
    userQueue.members = [personRow({ auth_user_id: LOGIN })];
    removal = removed("removed", LOGIN);
    serviceQueue.members = closes();
    await expect(removePerson(PERSON)).resolves.toEqual({ ok: true, value: { outcome: "removed", loginKept: false } });
    expect(serviceQueries[1]).toEqual(RELINK_CHECK);
    expect(deleteUser.mock.invocationCallOrder[0]).toBeLessThan(serviceFrom.mock.invocationCallOrder[1]);
  });

  // A row may still hold the deleted login, so removed_login_id stays: the record of what's left.
  it("keeps removed_login_id and says the login is still to sort out when that unlink fails, logging only code and status", async () => {
    userQueue.members = [personRow({ auth_user_id: LOGIN })];
    removal = removed("removed", LOGIN);
    serviceQueue.members = [rows(), dbError("08006", `down for ${EMAIL}`)];
    await expect(removePerson(PERSON)).resolves.toEqual({ ok: true, value: { outcome: "removed", loginKept: true } });
    expect(serviceQueries).toEqual([LOGIN_CHECK, RELINK_CHECK]);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("removePerson relink check failed", { code: "08006", status: undefined });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("example.com");
    expectRevalidated();
  });

  it("reads, removes and clears by the id in lower case, whatever case the request used", async () => {
    userQueue.members = [personRow({ auth_user_id: LOGIN })];
    removal = removed("removed", LOGIN);
    serviceQueue.members = closes();
    await expect(removePerson(PERSON.toUpperCase())).resolves.toEqual({ ok: true, value: { outcome: "removed", loginKept: false } });
    expect(userQueries).toEqual([LOAD]);
    expect(removeCalls()).toEqual([["admin_remove_member", { p_member_id: PERSON }]]);
    expect(serviceQueries).toEqual([LOGIN_CHECK, RELINK_CHECK, CLEAR]);
  });

  it.each([
    ["a bad id", () => removePerson("x")],
    ["an id that isn't a string", () => removePerson(42 as never)],
    ["an id with SQL in it", () => removePerson(`${PERSON}' or '1'='1`)],
  ])("refuses %s without reading or removing anything", async (_label, run) => {
    await expect(run()).resolves.toEqual({ ok: false, error: BAD_REQUEST });
    expectNothingWritten();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });
});

// ---------- changeEmail ----------

const NEW_EMAIL = "mei.w@example.net";
const ORG = "c0000000-0000-4000-8000-0000000000aa"; // the organisation node, when a test adds it
const OTHER_ADMIN = "a0000000-0000-4000-8000-000000000003";
const NOW = "2026-10-09T04:30:00.000Z";

// The person as the admin reads them: a member of TEAM whose login another admin gave here.
const person = (changes: Record<string, unknown> = {}) => ({
  data: {
    id: PERSON,
    role: "member",
    team_id: TEAM,
    auth_user_id: LOGIN,
    removed_at: null,
    login_given_by: OTHER_ADMIN,
    login_given_at: "2026-10-01T09:00:00.000Z",
    login_email_changed_by: null,
    login_email_changed_at: null,
    ...changes,
  },
  error: null,
});

// Their login, as the service role reads it: used (its address confirmed) unless a test says not.
const authUser = (changes: Record<string, unknown> = {}) => ({
  data: {
    user: { id: LOGIN, email: EMAIL, email_confirmed_at: "2026-10-01T09:05:00Z", last_sign_in_at: "2026-10-08T08:00:00Z", ...changes },
  },
  error: null,
});
const UNUSED = { email_confirmed_at: null, last_sign_in_at: null };
// An address another admin gave the login after this change set the new one.
const LATER_EMAIL = "mei.later@example.org";

// A used login read twice: first as above, then again before its old address goes back, when it
// still has the address this change set (or `changes`, for anything else), so the old one goes back.
function readsAgain(changes: Record<string, unknown> = { email: NEW_EMAIL }) {
  getUserById.mockResolvedValueOnce(authUser()).mockResolvedValueOnce(authUser(changes));
}

// The row again, read with the service role after the change (the late check).
const stillRow = (changes: Record<string, unknown> = {}) => ({
  data: { role: "member", team_id: TEAM, auth_user_id: LOGIN, removed_at: null, ...changes },
  error: null,
});

// The admin's checks pass: no grants, and no organisation node unless a test adds one.
function changeAllowed(row: Result = person()) {
  userQueue.members = [row];
  userQueue.member_grants = [rows()];
}

// What the service role reads and writes: `members` in order (for an unused login the link
// first; then the late check's read; then whatever follows), and the late check's grants,
// organisation node and, once there is one, who leads it.
type Late = { grants?: Result; organisation?: Result; leads?: Result };
function serviceSees(members: Result[], { grants = rows(), organisation = noOrganisation(), leads }: Late = {}) {
  serviceQueue.members = members;
  serviceQueue.member_grants = [grants];
  serviceQueue.teams = [organisation];
  if (leads) serviceQueue.team_leads = [leads];
}

const CHANGE_LOAD: Query = {
  table: "members",
  calls: [
    [
      "select",
      "id, role, team_id, auth_user_id, removed_at, login_given_by, login_given_at, login_email_changed_by, login_email_changed_at",
    ],
    ["eq", "id", PERSON],
    ["maybeSingle"],
  ],
};
const GRANTS: Query = { table: "member_grants", calls: [["select", "grant_name"], ["eq", "member_id", PERSON], ["limit", 1]] };
const ORG_LEADS: Query = {
  table: "team_leads",
  calls: [["select", "member_id"], ["eq", "team_id", ORG], ["eq", "member_id", PERSON], ["limit", 1]],
};
// The late check's reads (and ORG_LEADS after them once there is an organisation node).
const STILL_QUERIES = [
  { table: "members", calls: [["select", "role, team_id, auth_user_id, removed_at"], ["eq", "id", PERSON], ["maybeSingle"]] },
  GRANTS,
  ORG_LOOKUP,
];
const usedBy = (login: string): Query => ({ table: "members", calls: [["select", "id"], ["eq", "auth_user_id", login], ["limit", 1]] });
// After soft-deleting an old login nothing used: a row given it between that check and the delete
// holds a dead one, so it's unlinked (as a removal's RELINK_CHECK does).
const unlinks = (login: string): Query => ({
  table: "members",
  calls: [["update", { auth_user_id: null, login_given_by: null, login_given_at: null }], ["eq", "auth_user_id", login]],
});

// A used login: who changes it is recorded first, only while the row still has this login, isn't
// removed and isn't a Master Admin's.
const RECORD: Query = {
  table: "members",
  calls: [
    ["update", { login_email_changed_by: ADMIN, login_email_changed_at: NOW }],
    ["eq", "id", PERSON],
    ["eq", "auth_user_id", LOGIN],
    ["is", "removed_at", null],
    ["neq", "role", "hq"],
    ["select", "id"],
  ],
};
// Taking that record back when the change is: to who changed it before (nobody, unless a test
// says otherwise), only while the record is still this change's.
const unrecord = (before: Record<string, unknown> = { login_email_changed_by: null, login_email_changed_at: null }): Query => ({
  table: "members",
  calls: [["update", before], ["eq", "id", PERSON], ["eq", "login_email_changed_at", NOW]],
});

// What the late check can find, and what each says.
const LATE_REFUSALS: [string, Record<string, unknown>, Late, string][] = [
  ["a grant arrived", {}, { grants: { data: [{ grant_name: "admin" }], error: null } }, EMAIL_HOLDS_GRANTS],
  ["they were made a Master Admin", { role: "hq" }, {}, EMAIL_MASTER_ADMIN],
  ["they were moved into the organisation", { team_id: ORG }, { organisation: organisationIs(ORG) }, EMAIL_ORGANISATION],
  [
    "they were made a lead of the organisation",
    {},
    { organisation: organisationIs(ORG), leads: { data: [{ member_id: PERSON }], error: null } },
    EMAIL_ORGANISATION,
  ],
  ["it can't tell (the grants can't be read)", {}, { grants: dbError("08006", "down") }, GENERIC_ERROR],
  ["it can't tell who leads the organisation", {}, { organisation: organisationIs(ORG), leads: dbError("08006", "down") }, GENERIC_ERROR],
];

// What the late check finds when the row isn't this login's person any more: whatever did that
// (a removal, another change) owns the login now.
const LATE_GONE: [string, Result][] = [
  ["they were removed", { data: { role: "member", team_id: null, auth_user_id: null, removed_at: NOW }, error: null }],
  ["their row was deleted", { data: null, error: null }],
  ["their row has another login now", stillRow({ auth_user_id: "b0000000-0000-4000-8000-000000000003" })],
];

describe("changeEmail", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    getUserById.mockResolvedValue(authUser());
    serviceRpc.mockResolvedValue({ data: false, error: null });
    updateUserById.mockResolvedValue({ data: { user: { id: LOGIN } }, error: null });
  });

  function expectNoServiceRole() {
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    for (const fn of [getUserById, serviceRpc, updateUserById, inviteUserByEmail, deleteUser, serviceFrom]) {
      expect(fn).not.toHaveBeenCalled();
    }
  }

  // Their login and their row are as they were.
  function expectUnchanged() {
    expect(updateUserById).not.toHaveBeenCalled();
    expect(inviteUserByEmail).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    expect(serviceFrom).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  }

  // ----- the checks, as the admin and then with the service role -----

  it.each([
    ["isn't there (or RLS hides them)", { data: null, error: null }, PERSON_GONE],
    ["was removed from Module One", person({ removed_at: "2026-10-08T09:00:00Z", auth_user_id: null, team_id: null }), PERSON_REMOVED],
    ["is the admin themselves", person({ id: ADMIN, auth_user_id: ADMIN_AUTH }), EMAIL_NOT_YOURSELF],
    ["is the admin themselves, a Master Admin", person({ id: ADMIN, role: "hq", auth_user_id: ADMIN_AUTH }), EMAIL_NOT_YOURSELF],
    ["is a Master Admin", person({ role: "hq" }), EMAIL_MASTER_ADMIN],
    ["is a Master Admin without a login", person({ role: "hq", auth_user_id: null }), EMAIL_MASTER_ADMIN],
    ["has no login yet", person({ auth_user_id: null, login_given_by: null, login_given_at: null }), NO_LOGIN_YET],
  ])("refuses a person who %s without using the service role", async (_label, result, error) => {
    userQueue.members = [result];
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error });
    expect(userQueries).toEqual([CHANGE_LOAD]);
    expectNoServiceRole();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses the admin's own row whatever the letter case of the id", async () => {
    userQueue.members = [person({ id: ADMIN, auth_user_id: ADMIN_AUTH })];
    await expect(changeEmail(ADMIN.toUpperCase(), NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_NOT_YOURSELF });
    expectNoServiceRole();
  });

  it("refuses a grant holder without using the service role", async () => {
    userQueue.members = [person()];
    userQueue.member_grants = [{ data: [{ grant_name: "recordings" }], error: null }];
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_HOLDS_GRANTS });
    expect(userQueries).toEqual([CHANGE_LOAD, GRANTS]);
    expectNoServiceRole();
  });

  it("refuses someone who sits in the organisation without using the service role", async () => {
    changeAllowed(person({ team_id: ORG, role: "leader" }));
    userQueue.teams = [organisationIs(ORG)];
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_ORGANISATION });
    expect(userQueries).toEqual([CHANGE_LOAD, GRANTS, ORG_LOOKUP]);
    expectNoServiceRole();
  });

  it("refuses someone who leads the organisation (team_leads) without using the service role", async () => {
    changeAllowed(person({ role: "leader" }));
    userQueue.teams = [organisationIs(ORG)];
    userQueue.team_leads = [{ data: [{ member_id: PERSON }], error: null }];
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_ORGANISATION });
    expect(userQueries).toEqual([CHANGE_LOAD, GRANTS, ORG_LOOKUP, ORG_LEADS]);
    expectNoServiceRole();
  });

  it.each([
    ["the person", "members", "changeEmail load failed"],
    ["their grants", "member_grants", "changeEmail grants failed"],
    ["the organisation node", "teams", "changeEmail failed"],
    ["who leads the organisation", "team_leads", "changeEmail leads failed"],
  ])("says 'something went wrong' when %s can't be read, without using the service role", async (_label, table, logged) => {
    changeAllowed();
    userQueue.teams = [organisationIs(ORG)];
    userQueue.team_leads = [rows()];
    userQueue[table] = [dbError("08006", `down for ${EMAIL}`)];
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expectNoServiceRole();
    expect(console.error).toHaveBeenCalledExactlyOnceWith(logged, { code: "08006", status: undefined });
  });

  it.each([
    ["a bad member id", () => changeEmail("x", NEW_EMAIL), BAD_REQUEST],
    ["a member id that isn't a string", () => changeEmail(null as never, NEW_EMAIL), BAD_REQUEST],
    ["no email", () => changeEmail(PERSON, "  "), "Enter an email address."],
    ["two @s", () => changeEmail(PERSON, "a@b@example.com"), "Enter an email address like name@example.com."],
    ["a space", () => changeEmail(PERSON, "mei wong@example.com"), "Email addresses can't contain spaces."],
    ["an email that isn't a string", () => changeEmail(PERSON, ["mei@example.com"] as never), "Enter an email address."],
  ])("refuses %s before reading anything or using the service role", async (_label, run, error) => {
    await expect(run()).resolves.toEqual({ ok: false, error });
    expectNothingWritten();
    expectNoServiceRole();
  });

  it("says the service key is missing before looking at their login", async () => {
    changeAllowed();
    vi.mocked(createServiceRoleClient).mockImplementation(() => {
      throw new MissingServiceKeyError();
    });
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_NEEDS_SERVICE_KEY });
    expect(getUserById).not.toHaveBeenCalled();
    expectUnchanged();
  });

  it("hides any other problem making the client", async () => {
    changeAllowed();
    vi.mocked(createServiceRoleClient).mockImplementation(() => {
      throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
    });
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(getUserById).not.toHaveBeenCalled();
  });

  it("says the person changed when their login is gone (removed and deleted meanwhile)", async () => {
    changeAllowed();
    getUserById.mockResolvedValue({ data: { user: null }, error: { name: "AuthApiError", status: 404, code: "user_not_found" } });
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_RACE });
    expect(serviceRpc).not.toHaveBeenCalled();
    expectUnchanged();
  });

  it("says they were removed when their login is being deleted (a removal under way)", async () => {
    changeAllowed();
    getUserById.mockResolvedValue(authUser({ deleted_at: "2026-10-09T04:29:00Z" }));
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: PERSON_REMOVED });
    expect(serviceRpc).not.toHaveBeenCalled();
    expectUnchanged();
  });

  it("says 'something went wrong' when their login can't be read, logging only code and status", async () => {
    changeAllowed();
    getUserById.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthApiError", status: 500, code: "unexpected_failure", message: `Couldn't read ${EMAIL}` },
    });
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(console.error).toHaveBeenCalledExactlyOnceWith("changeEmail lookup failed", { code: "unexpected_failure", status: 500 });
    expectUnchanged();
  });

  it.each([
    ["another login's address", NEW_EMAIL],
    ["the address they sign in with now", EMAIL],
  ])("says the same thing for %s: that email already has a login (it never says whose)", async (_label, email) => {
    changeAllowed();
    serviceRpc.mockResolvedValue({ data: true, error: null });
    const result = await changeEmail(PERSON, email);
    expect(result).toEqual({ ok: false, error: EMAIL_IN_USE });
    expect(serviceRpc).toHaveBeenCalledExactlyOnceWith("login_email_in_use", { p_email: email });
    expectUnchanged();
  });

  it("asks whether the new address is free as it will be stored (trimmed, lower case)", async () => {
    changeAllowed();
    serviceRpc.mockResolvedValue({ data: true, error: null });
    await changeEmail(PERSON, "  Mei.W@Example.NET ");
    expect(serviceRpc).toHaveBeenCalledExactlyOnceWith("login_email_in_use", { p_email: NEW_EMAIL });
  });

  it("counts anything but a plain 'no' from login_email_in_use as taken", async () => {
    changeAllowed();
    serviceRpc.mockResolvedValue({ data: null, error: null });
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_IN_USE });
    expectUnchanged();
  });

  it("says 'something went wrong' when it can't tell whether the address is free", async () => {
    changeAllowed();
    serviceRpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: `no function for ${NEW_EMAIL}` } });
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(console.error).toHaveBeenCalledExactlyOnceWith("changeEmail in use failed", { code: "PGRST202", status: undefined });
    expectUnchanged();
  });

  // ----- a login they've used: its address changes in place -----

  it("counts a login that has signed in as used even without a confirmed address", async () => {
    changeAllowed();
    getUserById.mockResolvedValue(authUser({ email_confirmed_at: null }));
    serviceSees([rows(PERSON), stillRow()]);
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: true, value: { invited: false } });
    expect(updateUserById).toHaveBeenCalledExactlyOnceWith(LOGIN, { email: NEW_EMAIL, email_confirm: true });
    expect(inviteUserByEmail).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("records who changes a used login, gives it the new address in place, confirmed, and invites nobody", async () => {
    changeAllowed();
    serviceSees([rows(PERSON), stillRow()]);
    await expect(changeEmail(PERSON, "  Mei.W@Example.NET ")).resolves.toEqual({ ok: true, value: { invited: false } });
    // The checks, as the admin (RLS applies)
    expect(userQueries).toEqual([CHANGE_LOAD, GRANTS, ORG_LOOKUP]);
    // then with the service role: the login, whether the address is free
    expect(getUserById).toHaveBeenCalledExactlyOnceWith(LOGIN);
    expect(serviceRpc).toHaveBeenCalledExactlyOnceWith("login_email_in_use", { p_email: NEW_EMAIL });
    // the change itself; Auth emails nobody about it
    expect(updateUserById).toHaveBeenCalledExactlyOnceWith(LOGIN, { email: NEW_EMAIL, email_confirm: true });
    expect(inviteUserByEmail).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    // who changed it, recorded first, then the late check; nothing is written after it
    expect(serviceQueries).toEqual([RECORD, ...STILL_QUERIES]);
    expectRevalidated();
  });

  it("records who changes it before changing the address, so the change is never made without the record", async () => {
    changeAllowed();
    serviceSees([rows(PERSON), stillRow()]);
    await changeEmail(PERSON, NEW_EMAIL);
    const [record, lateCheck] = serviceFrom.mock.invocationCallOrder;
    expect(record).toBeLessThan(updateUserById.mock.invocationCallOrder[0]);
    expect(updateUserById.mock.invocationCallOrder[0]).toBeLessThan(lateCheck);
  });

  it("changes nothing when the record reaches no row (the person changed meanwhile)", async () => {
    changeAllowed();
    serviceSees([rows()]);
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_RACE });
    expect(serviceQueries).toEqual([RECORD]);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("changes nothing when recording who changes it fails, and logs only code and status", async () => {
    changeAllowed();
    serviceSees([dbError("08006", `down for ${NEW_EMAIL}`)]);
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(serviceQueries).toEqual([RECORD]);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("changeEmail record failed", { code: "08006", status: undefined });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("checks everything as the admin before any service-role call, and the login and address before changing it", async () => {
    changeAllowed();
    serviceSees([rows(PERSON), stillRow()]);
    await changeEmail(PERSON, NEW_EMAIL);
    const grantCheck = rpc.mock.invocationCallOrder[0];
    const lastAdminRead = Math.max(...from.mock.invocationCallOrder);
    const client = vi.mocked(createServiceRoleClient).mock.invocationCallOrder[0];
    expect(grantCheck).toBeLessThan(from.mock.invocationCallOrder[0]);
    expect(lastAdminRead).toBeLessThan(client);
    expect(client).toBeLessThan(getUserById.mock.invocationCallOrder[0]);
    expect(getUserById.mock.invocationCallOrder[0]).toBeLessThan(serviceRpc.mock.invocationCallOrder[0]);
    expect(serviceRpc.mock.invocationCallOrder[0]).toBeLessThan(serviceFrom.mock.invocationCallOrder[0]);
    expect(serviceRpc.mock.invocationCallOrder[0]).toBeLessThan(updateUserById.mock.invocationCallOrder[0]);
  });

  it("checks again by who leads the organisation once there is one, and by the id as stored", async () => {
    changeAllowed();
    userQueue.teams = [organisationIs(ORG)];
    userQueue.team_leads = [rows()];
    serviceSees([rows(PERSON), stillRow()], { organisation: organisationIs(ORG), leads: rows() });
    await expect(changeEmail(PERSON.toUpperCase(), NEW_EMAIL)).resolves.toEqual({ ok: true, value: { invited: false } });
    expect(userQueries.slice(1)).toEqual([GRANTS, ORG_LOOKUP, ORG_LEADS]);
    // RECORD is filtered on the id as stored, too.
    expect(serviceQueries).toEqual([RECORD, ...STILL_QUERIES, ORG_LEADS]);
  });

  it("doesn't need NEXT_PUBLIC_SITE_URL for a used login (nobody is emailed)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    changeAllowed();
    serviceSees([rows(PERSON), stillRow()]);
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: true, value: { invited: false } });
  });

  it.each([
    ["email_exists", { code: "email_exists", status: 422 }, EMAIL_IN_USE, []],
    ["any 422", { code: undefined, status: 422 }, EMAIL_IN_USE, []],
    // An address parseEmail lets through and Auth's stricter check refuses (a non-ASCII local part).
    ["Auth's address check", { code: "validation_failed", status: 400 }, EMAIL_FORMAT, []],
    [
      "a server error",
      { code: "unexpected_failure", status: 500 },
      GENERIC_ERROR,
      [["changeEmail update failed", { code: "unexpected_failure", status: 500 }]],
    ],
  ])("maps a failed change (%s) and takes the record back", async (_label, error, message, logged) => {
    changeAllowed();
    serviceSees([rows(PERSON), done()]);
    updateUserById.mockResolvedValue({ data: { user: null }, error: { ...error, name: "AuthApiError", message: NEW_EMAIL } });
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: message });
    expect(updateUserById).toHaveBeenCalledOnce();
    expect(serviceQueries).toEqual([RECORD, unrecord()]);
    expect(vi.mocked(console.error).mock.calls).toEqual(logged);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("takes the record back to who changed it before, only while it's still this change's", async () => {
    const before = { login_email_changed_by: OTHER_ADMIN, login_email_changed_at: "2026-10-05T10:00:00.000Z" };
    changeAllowed(person(before));
    serviceSees([rows(PERSON), done()]);
    updateUserById.mockResolvedValue({ data: { user: null }, error: { name: "AuthApiError", code: "email_exists", status: 422, message: NEW_EMAIL } });
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_IN_USE });
    expect(serviceQueries).toEqual([RECORD, unrecord(before)]);
  });

  it("still says why the change failed when taking the record back fails too, and logs only code and status", async () => {
    changeAllowed();
    serviceSees([rows(PERSON), dbError("08006", `down for ${NEW_EMAIL}`)]);
    updateUserById.mockResolvedValue({ data: { user: null }, error: { name: "AuthApiError", code: "email_exists", status: 422, message: NEW_EMAIL } });
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_IN_USE });
    expect(console.error).toHaveBeenCalledExactlyOnceWith("changeEmail unrecord failed", { code: "08006", status: undefined });
  });

  it.each(LATE_REFUSALS)(
    "puts a used login's old address back, confirmed, takes the record back and refuses when %s meanwhile",
    async (_label, changes, late, error) => {
      changeAllowed();
      readsAgain();
      serviceSees([rows(PERSON), stillRow(changes), done()], late);
      await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error });
      expect(updateUserById.mock.calls).toEqual([
        [LOGIN, { email: NEW_EMAIL, email_confirm: true }],
        [LOGIN, { email: EMAIL, email_confirm: true }],
      ]);
      // The login is read again first: it still has the address set here.
      expect(getUserById.mock.calls).toEqual([[LOGIN], [LOGIN]]);
      expect(getUserById.mock.invocationCallOrder[1]).toBeLessThan(updateUserById.mock.invocationCallOrder[1]);
      // Nobody is recorded as having changed it any more, once the old address is back.
      expect(serviceQueries[0]).toEqual(RECORD);
      expect(serviceQueries.at(-1)).toEqual(unrecord());
      expect(updateUserById.mock.invocationCallOrder[1]).toBeLessThan(Math.max(...serviceFrom.mock.invocationCallOrder));
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("puts the old address back when the late check can't read the row, and logs only code and status", async () => {
    changeAllowed();
    readsAgain();
    serviceSees([rows(PERSON), dbError("08006", "down"), done()]);
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(updateUserById).toHaveBeenLastCalledWith(LOGIN, { email: EMAIL, email_confirm: true });
    expect(serviceQueries.at(-1)).toEqual(unrecord());
    expect(console.error).toHaveBeenCalledExactlyOnceWith("changeEmail late check failed", { code: "08006", status: undefined });
  });

  it("says the old address couldn't be put back, keeping the record, when putting it back fails", async () => {
    changeAllowed();
    readsAgain();
    serviceSees([rows(PERSON), stillRow()], { grants: { data: [{ grant_name: "admin" }], error: null } });
    updateUserById
      .mockResolvedValueOnce({ data: { user: { id: LOGIN } }, error: null })
      .mockResolvedValueOnce({ data: { user: null }, error: { name: "AuthApiError", status: 500, code: "unexpected_failure", message: EMAIL } });
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_NOT_RESTORED });
    // The new address stays, so who set it stays recorded.
    expect(serviceQueries).toEqual([RECORD, ...STILL_QUERIES]);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("changeEmail restore failed", { code: "unexpected_failure", status: 500 });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says the old address couldn't be put back when the login had none, keeping the record", async () => {
    changeAllowed();
    getUserById.mockResolvedValue(authUser({ email: undefined }));
    serviceSees([rows(PERSON), stillRow({ role: "hq" })]);
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_NOT_RESTORED });
    expect(updateUserById).toHaveBeenCalledExactlyOnceWith(LOGIN, { email: NEW_EMAIL, email_confirm: true });
    expect(serviceQueries).toEqual([RECORD, ...STILL_QUERIES]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  // Another admin changed the address again since: that change stands, so nothing of this one is
  // left to put back. Its record is still taken back, which only reaches a record that is still
  // this change's (the later change recorded its own).
  it("leaves an address another admin set since, refusing as it would, and takes back only this change's record", async () => {
    changeAllowed();
    readsAgain({ email: LATER_EMAIL });
    serviceSees([rows(PERSON), stillRow(), done()], { grants: { data: [{ grant_name: "admin" }], error: null } });
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_HOLDS_GRANTS });
    expect(getUserById.mock.calls).toEqual([[LOGIN], [LOGIN]]);
    expect(updateUserById).toHaveBeenCalledExactlyOnceWith(LOGIN, { email: NEW_EMAIL, email_confirm: true });
    expect(serviceQueries).toEqual([RECORD, ...STILL_QUERIES, unrecord()]);
    expect(console.error).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("still puts the old address back when Auth gives the address set here in other letters", async () => {
    changeAllowed();
    readsAgain({ email: NEW_EMAIL.toUpperCase() });
    serviceSees([rows(PERSON), stillRow(), done()], { grants: { data: [{ grant_name: "admin" }], error: null } });
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_HOLDS_GRANTS });
    expect(updateUserById).toHaveBeenLastCalledWith(LOGIN, { email: EMAIL, email_confirm: true });
    expect(serviceQueries.at(-1)).toEqual(unrecord());
  });

  it("still puts the old address back when it can't read the login again first, and logs only code and status", async () => {
    changeAllowed();
    getUserById
      .mockResolvedValueOnce(authUser())
      .mockResolvedValueOnce({ data: { user: null }, error: { name: "AuthApiError", status: 500, code: "unexpected_failure", message: NEW_EMAIL } });
    serviceSees([rows(PERSON), stillRow(), done()], { grants: { data: [{ grant_name: "admin" }], error: null } });
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_HOLDS_GRANTS });
    expect(updateUserById.mock.calls).toEqual([
      [LOGIN, { email: NEW_EMAIL, email_confirm: true }],
      [LOGIN, { email: EMAIL, email_confirm: true }],
    ]);
    expect(serviceQueries).toEqual([RECORD, ...STILL_QUERIES, unrecord()]);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("changeEmail recheck failed", { code: "unexpected_failure", status: 500 });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("example");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  // ----- a used login that left their row meanwhile ("gone") -----

  // A removal unlinked it and is deleting it, which frees the address: leave it to that.
  it.each(LATE_GONE)(
    "refuses, leaving the new address and the record, when %s meanwhile and a removal is deleting the login",
    async (_label, row) => {
      changeAllowed();
      serviceSees([rows(PERSON), row, rows(OTHER_ADMIN)]);
      await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_RACE });
      expect(updateUserById).toHaveBeenCalledExactlyOnceWith(LOGIN, { email: NEW_EMAIL, email_confirm: true });
      expect(serviceQueries).toEqual([RECORD, ...STILL_QUERIES, pendingRemoval(LOGIN)]);
      expect(getUserById).toHaveBeenCalledOnce();
      expect(deleteUser).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  // The owner relinked or unlinked it by hand: it mustn't keep an address an admin chose for this
  // person.
  it.each(LATE_GONE)(
    "puts the old address back, confirmed, and takes the record back when %s meanwhile and no removal is deleting the login",
    async (_label, row) => {
      changeAllowed();
      readsAgain();
      serviceSees([rows(PERSON), row, rows(), done()]);
      await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_RACE });
      // Read again once, to see whether it was deleted; putting the address back uses that read.
      expect(getUserById.mock.calls).toEqual([[LOGIN], [LOGIN]]);
      expect(updateUserById.mock.calls).toEqual([
        [LOGIN, { email: NEW_EMAIL, email_confirm: true }],
        [LOGIN, { email: EMAIL, email_confirm: true }],
      ]);
      expect(serviceQueries).toEqual([RECORD, ...STILL_QUERIES, pendingRemoval(LOGIN), unrecord()]);
      expect(deleteUser).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("puts the old address back when it can't tell whether a removal is deleting the login, and logs only code and status", async () => {
    changeAllowed();
    readsAgain();
    serviceSees([rows(PERSON), LATE_GONE[0][1], dbError("08006", `down for ${NEW_EMAIL}`), done()]);
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_RACE });
    expect(updateUserById).toHaveBeenLastCalledWith(LOGIN, { email: EMAIL, email_confirm: true });
    expect(serviceQueries).toEqual([RECORD, ...STILL_QUERIES, pendingRemoval(LOGIN), unrecord()]);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("changeEmail removal check failed", { code: "08006", status: undefined });
  });

  it("puts the old address back when it can't read the login again, and logs only code and status", async () => {
    changeAllowed();
    serviceSees([rows(PERSON), LATE_GONE[0][1], rows(), done()]);
    getUserById
      .mockResolvedValueOnce(authUser())
      .mockResolvedValueOnce({ data: { user: null }, error: { name: "AuthApiError", status: 500, code: "unexpected_failure", message: EMAIL } });
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_RACE });
    expect(updateUserById).toHaveBeenLastCalledWith(LOGIN, { email: EMAIL, email_confirm: true });
    expect(serviceQueries.at(-1)).toEqual(unrecord());
    expect(console.error).toHaveBeenCalledExactlyOnceWith("changeEmail recheck failed", { code: "unexpected_failure", status: 500 });
  });

  it("leaves an address another admin set since when the login left their row, and takes back only this change's record", async () => {
    changeAllowed();
    readsAgain({ email: LATER_EMAIL });
    serviceSees([rows(PERSON), LATE_GONE[0][1], rows(), done()]);
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_RACE });
    // The read that found it not deleted decides; nothing reads it a third time.
    expect(getUserById.mock.calls).toEqual([[LOGIN], [LOGIN]]);
    expect(updateUserById).toHaveBeenCalledExactlyOnceWith(LOGIN, { email: NEW_EMAIL, email_confirm: true });
    expect(serviceQueries).toEqual([RECORD, ...STILL_QUERIES, pendingRemoval(LOGIN), unrecord()]);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says the old address couldn't be put back, keeping the record, when the login left their row and putting it back fails", async () => {
    changeAllowed();
    readsAgain();
    serviceSees([rows(PERSON), LATE_GONE[0][1], rows()]);
    updateUserById
      .mockResolvedValueOnce({ data: { user: { id: LOGIN } }, error: null })
      .mockResolvedValueOnce({ data: { user: null }, error: { name: "AuthApiError", status: 500, code: "unexpected_failure", message: EMAIL } });
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_NOT_RESTORED });
    expect(serviceQueries).toEqual([RECORD, ...STILL_QUERIES, pendingRemoval(LOGIN)]);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("changeEmail restore failed", { code: "unexpected_failure", status: 500 });
  });

  // A removal soft-deleted the login while this change was under way, and its deletion could not
  // free an address that was only set afterwards.
  it("frees the new address when the login was deleted under this change", async () => {
    changeAllowed();
    serviceSees([rows(PERSON), LATE_GONE[0][1], rows()]);
    getUserById.mockResolvedValueOnce(authUser()).mockResolvedValueOnce(authUser({ deleted_at: "2026-10-09T04:29:59Z" }));
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_RACE });
    expect(updateUserById.mock.calls).toEqual([
      [LOGIN, { email: NEW_EMAIL, email_confirm: true }],
      [LOGIN, { email: `${LOGIN}@deleted.invalid` }],
    ]);
    expect(serviceQueries).toEqual([RECORD, ...STILL_QUERIES, pendingRemoval(LOGIN)]);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("still refuses when freeing the address fails, and logs only code and status", async () => {
    changeAllowed();
    serviceSees([rows(PERSON), LATE_GONE[0][1], rows()]);
    getUserById.mockResolvedValueOnce(authUser()).mockResolvedValueOnce(authUser({ deleted_at: "2026-10-09T04:29:59Z" }));
    updateUserById
      .mockResolvedValueOnce({ data: { user: { id: LOGIN } }, error: null })
      .mockResolvedValueOnce({ data: { user: null }, error: { name: "AuthApiError", status: 500, code: "unexpected_failure", message: NEW_EMAIL } });
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_RACE });
    expect(console.error).toHaveBeenCalledExactlyOnceWith("changeEmail free failed", { code: "unexpected_failure", status: 500 });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("example");
  });

  it("checks for an invalid address before a taken one when the change fails, as invites do", async () => {
    changeAllowed();
    serviceSees([rows(PERSON), done()]);
    updateUserById.mockResolvedValueOnce({
      data: { user: null },
      error: { name: "AuthApiError", status: 422, code: "validation_failed", message: "Unable to validate email address" },
    });
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_FORMAT });
  });

  // ----- a login they haven't used: a new login, invited at the new address, replaces it -----

  // The guarded link: the new login in place of the old one, only while the row still has the old
  // one, isn't removed and isn't a Master Admin's.
  const link = (given: Record<string, unknown> = {}) => ({
    table: "members",
    calls: [
      ["update", { auth_user_id: NEW_LOGIN, login_email_changed_by: ADMIN, login_email_changed_at: NOW, ...given }],
      ["eq", "id", PERSON],
      ["eq", "auth_user_id", LOGIN],
      ["is", "removed_at", null],
      ["neq", "role", "hq"],
      ["select", "id"],
    ],
  });

  it("replaces an unused login: invites the new address, links the new login, then soft-deletes the old one", async () => {
    changeAllowed();
    getUserById.mockResolvedValue(authUser(UNUSED));
    serviceSees([rows(PERSON), stillRow({ auth_user_id: NEW_LOGIN }), rows(), done()]);
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: true, value: { invited: true } });
    expect(inviteUserByEmail).toHaveBeenCalledExactlyOnceWith(NEW_EMAIL, { redirectTo: `${SITE}/auth/callback?next=/portal` });
    expect(updateUserById).not.toHaveBeenCalled();
    // The link keeps who gave the login; the late check is about the new login; then is the old
    // one linked to anyone? Once it's deleted, any row given it meanwhile is unlinked.
    expect(serviceQueries).toEqual([link(), ...STILL_QUERIES, usedBy(LOGIN), unlinks(LOGIN)]);
    // Its invite link dies. Soft, as a removal's: should they have signed in with it after all,
    // what they accepted stays.
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(LOGIN, true);
    expectRevalidated();
  });

  it("records the login as given here when it was made elsewhere (the Supabase dashboard)", async () => {
    changeAllowed(person({ login_given_by: null, login_given_at: null }));
    getUserById.mockResolvedValue(authUser(UNUSED));
    serviceSees([rows(PERSON), stillRow({ auth_user_id: NEW_LOGIN }), rows(), done()]);
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: true, value: { invited: true } });
    expect(serviceQueries[0]).toEqual(link({ login_given_by: ADMIN, login_given_at: NOW }));
  });

  it.each([undefined, "", "moduleone.example", "javascript:alert(1)"])(
    "needs a usable NEXT_PUBLIC_SITE_URL (%j) for an unused login, and says so before inviting or writing anything",
    async (value) => {
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", value);
      changeAllowed();
      getUserById.mockResolvedValue(authUser(UNUSED));
      await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_NEEDS_SITE_URL });
      expectUnchanged();
    },
  );

  it.each([
    ["email_exists", { code: "email_exists", status: 422 }, EMAIL_IN_USE],
    ["a rate limit", { code: "over_email_send_rate_limit", status: 429 }, TOO_MANY_EMAILS],
    ["the built-in sender's refusal", { code: "email_address_not_authorized", status: 400 }, NO_EMAIL_SENDER],
    ["Auth's address check", { code: "validation_failed", status: 400 }, EMAIL_FORMAT],
    ["a server error", { code: "unexpected_failure", status: 500 }, GENERIC_ERROR],
  ])("changes nothing when the invite fails (%s)", async (_label, error, message) => {
    changeAllowed();
    getUserById.mockResolvedValue(authUser(UNUSED));
    inviteUserByEmail.mockResolvedValue({ data: { user: null }, error: { ...error, name: "AuthApiError", message: NEW_EMAIL } });
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: message });
    expect(serviceFrom).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    expect(updateUserById).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says 'something went wrong' if the invite returns no user, and changes nothing", async () => {
    changeAllowed();
    getUserById.mockResolvedValue(authUser(UNUSED));
    inviteUserByEmail.mockResolvedValue({ data: { user: null }, error: null });
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(console.error).toHaveBeenCalledExactlyOnceWith("changeEmail invite failed", { code: "no_user", status: undefined });
    expect(serviceFrom).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("says the person changed if the invite comes back for their own login, and deletes nothing", async () => {
    changeAllowed();
    getUserById.mockResolvedValue(authUser(UNUSED));
    inviteUserByEmail.mockResolvedValue({ data: { user: { id: LOGIN, created_at: "2026-10-01T09:00:00.000Z" } }, error: null });
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_RACE });
    expect(serviceFrom).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("deletes the new login again when the link reaches no row (the person changed meanwhile)", async () => {
    changeAllowed();
    getUserById.mockResolvedValue(authUser(UNUSED));
    serviceSees([rows(), rows()]); // the guarded link, then "does anyone use the new login?"
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_RACE });
    expect(serviceQueries).toEqual([link(), usedBy(NEW_LOGIN)]);
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(NEW_LOGIN);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["was made before this invite (a re-sent pending invite)", "2026-10-09T04:29:59.999Z"],
    ["doesn't say when it was made", undefined],
  ])("never deletes a new login that %s when the link reaches no row", async (_label, createdAt) => {
    changeAllowed();
    getUserById.mockResolvedValue(authUser(UNUSED));
    inviteUserByEmail.mockResolvedValue({ data: { user: { id: NEW_LOGIN, created_at: createdAt } }, error: null });
    serviceSees([rows()]);
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_RACE });
    expect(serviceQueries).toEqual([link()]);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("says the email has a login when its pending login belongs to another member, and deletes nothing", async () => {
    changeAllowed();
    getUserById.mockResolvedValue(authUser(UNUSED));
    serviceSees([
      dbError("23505", 'duplicate key value violates unique constraint "members_auth_user_id_key"'),
      rows(OTHER_ADMIN),
    ]);
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_IN_USE });
    expect(serviceQueries).toEqual([link(), usedBy(NEW_LOGIN)]);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("deletes the new login and says 'something went wrong' when the link fails otherwise", async () => {
    changeAllowed();
    getUserById.mockResolvedValue(authUser(UNUSED));
    serviceSees([dbError("08006", "down"), rows()]);
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(NEW_LOGIN);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("changeEmail link failed", { code: "08006", status: undefined });
  });

  it.each(LATE_REFUSALS)(
    "links the old login again, as it was, and deletes the new one when %s meanwhile",
    async (_label, changes, late, error) => {
      const before = {
        login_given_by: OTHER_ADMIN,
        login_given_at: "2026-10-01T09:00:00.000Z",
        login_email_changed_by: OTHER_ADMIN,
        login_email_changed_at: "2026-10-05T10:00:00.000Z",
      };
      changeAllowed(person(before));
      getUserById.mockResolvedValue(authUser(UNUSED));
      // the link, the late check, linking the old login again, "does anyone use the new one?"
      serviceSees([rows(PERSON), stillRow({ auth_user_id: NEW_LOGIN, ...changes }), { data: null, error: null }, rows()], late);
      await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error });
      expect(serviceQueries.slice(-2)).toEqual([
        {
          table: "members",
          calls: [["update", { auth_user_id: LOGIN, ...before }], ["eq", "id", PERSON], ["eq", "auth_user_id", NEW_LOGIN]],
        },
        usedBy(NEW_LOGIN),
      ]);
      // The new login goes; the old one stays, linked again with its invite still good.
      expect(deleteUser).toHaveBeenCalledExactlyOnceWith(NEW_LOGIN);
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("puts back a login made elsewhere as it was: not given here", async () => {
    changeAllowed(person({ login_given_by: null, login_given_at: null }));
    getUserById.mockResolvedValue(authUser(UNUSED));
    serviceSees(
      [rows(PERSON), stillRow({ auth_user_id: NEW_LOGIN }), { data: null, error: null }, rows()],
      { grants: { data: [{ grant_name: "admin" }], error: null } },
    );
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_HOLDS_GRANTS });
    expect(serviceQueries[0]).toEqual(link({ login_given_by: ADMIN, login_given_at: NOW }));
    expect(serviceQueries.at(-2)?.calls[0]).toEqual([
      "update",
      {
        auth_user_id: LOGIN,
        login_given_by: null,
        login_given_at: null,
        login_email_changed_by: null,
        login_email_changed_at: null,
      },
    ]);
  });

  it("keeps a new login the invite only re-sent when the late check refuses", async () => {
    changeAllowed();
    getUserById.mockResolvedValue(authUser(UNUSED));
    inviteUserByEmail.mockResolvedValue({ data: { user: { id: NEW_LOGIN, created_at: "2026-10-01T00:00:00.000Z" } }, error: null });
    serviceSees([rows(PERSON), stillRow({ auth_user_id: NEW_LOGIN, role: "hq" }), { data: null, error: null }]);
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_MASTER_ADMIN });
    expect(serviceQueries.at(-1)?.calls).toContainEqual(["update", expect.objectContaining({ auth_user_id: LOGIN })]);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it.each([
    ["one this invite made", "2026-10-09T04:30:00.000Z"],
    ["one it only re-sent", "2026-10-01T00:00:00.000Z"],
  ])(
    "deletes the new login (%s) when linking the old one again fails, which unlinks the row too",
    async (_label, createdAt) => {
      changeAllowed();
      getUserById.mockResolvedValue(authUser(UNUSED));
      inviteUserByEmail.mockResolvedValue({ data: { user: { id: NEW_LOGIN, created_at: createdAt } }, error: null });
      serviceSees(
        [rows(PERSON), stillRow({ auth_user_id: NEW_LOGIN }), dbError("08006", "down")],
        { grants: { data: [{ grant_name: "admin" }], error: null } },
      );
      await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
      expect(deleteUser).toHaveBeenCalledExactlyOnceWith(NEW_LOGIN);
      expect(console.error).toHaveBeenCalledExactlyOnceWith("changeEmail unlink failed", { code: "08006", status: undefined });
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it.each(LATE_GONE)(
    "refuses without linking the old login again when %s meanwhile, and deletes both logins if nobody uses them",
    async (_label, row) => {
      changeAllowed();
      getUserById.mockResolvedValue(authUser(UNUSED));
      serviceSees([rows(PERSON), row, rows(), rows(), done()]);
      await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_RACE });
      expect(serviceQueries).toEqual([link(), ...STILL_QUERIES, usedBy(NEW_LOGIN), usedBy(LOGIN), unlinks(LOGIN)]);
      // The new one (this invite made it, and nobody used it), and the old one, which nothing links
      // after the swap (softly, then unlinked from any row given it meanwhile).
      expect(deleteUser.mock.calls).toEqual([[NEW_LOGIN], [LOGIN, true]]);
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("keeps the old login when a member row uses it after they were removed meanwhile", async () => {
    changeAllowed();
    getUserById.mockResolvedValue(authUser(UNUSED));
    serviceSees([rows(PERSON), LATE_GONE[0][1], rows(), rows(OTHER_ADMIN)]);
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: false, error: EMAIL_RACE });
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(NEW_LOGIN);
  });

  it("never deletes or unlinks the old login while a member row uses it", async () => {
    changeAllowed();
    getUserById.mockResolvedValue(authUser(UNUSED));
    serviceSees([rows(PERSON), stillRow({ auth_user_id: NEW_LOGIN }), rows(OTHER_ADMIN)]);
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: true, value: { invited: true } });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(serviceQueries.at(-1)).toEqual(usedBy(LOGIN));
  });

  it("leaves the old login when it can't tell whether a member row uses it, and logs it", async () => {
    changeAllowed();
    getUserById.mockResolvedValue(authUser(UNUSED));
    serviceSees([rows(PERSON), stillRow({ auth_user_id: NEW_LOGIN }), dbError("08006", "down")]);
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: true, value: { invited: true } });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(serviceQueries.at(-1)).toEqual(usedBy(LOGIN));
    expect(console.error).toHaveBeenCalledExactlyOnceWith("changeEmail old login check failed", { code: "08006", status: undefined });
  });

  it.each([
    ["is gone already (404), quietly, still unlinking it", { status: 404, code: "user_not_found" }, [], [usedBy(LOGIN), unlinks(LOGIN)]],
    [
      "fails otherwise, logging it and unlinking nothing",
      { status: 500, code: "unexpected_failure" },
      [["changeEmail old login failed", { code: "unexpected_failure", status: 500 }]],
      [usedBy(LOGIN)],
    ],
  ])("is still done when deleting the old login %s", async (_label, error, logged, after) => {
    changeAllowed();
    getUserById.mockResolvedValue(authUser(UNUSED));
    serviceSees([rows(PERSON), stillRow({ auth_user_id: NEW_LOGIN }), rows(), done()]);
    deleteUser.mockResolvedValue({ data: null, error: { ...error, name: "AuthApiError", message: EMAIL } });
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: true, value: { invited: true } });
    expect(serviceQueries).toEqual([link(), ...STILL_QUERIES, ...after]);
    expect(vi.mocked(console.error).mock.calls).toEqual(logged);
    expectRevalidated();
  });

  // giveLogin re-sends a pending invite to the same login, so a row may be given the old login
  // between the check and the delete: that row then holds a dead login, and is unlinked.
  it("unlinks a row given the old login between the check and the delete, after deleting it", async () => {
    changeAllowed();
    getUserById.mockResolvedValue(authUser(UNUSED));
    serviceSees([rows(PERSON), stillRow({ auth_user_id: NEW_LOGIN }), rows(), done()]);
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: true, value: { invited: true } });
    expect(serviceQueries.at(-1)).toEqual(unlinks(LOGIN));
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(LOGIN, true);
    expect(deleteUser.mock.invocationCallOrder[0]).toBeLessThan(Math.max(...serviceFrom.mock.invocationCallOrder));
    expect(console.error).not.toHaveBeenCalled();
  });

  it("is still done when that unlink fails, and logs only code and status", async () => {
    changeAllowed();
    getUserById.mockResolvedValue(authUser(UNUSED));
    serviceSees([rows(PERSON), stillRow({ auth_user_id: NEW_LOGIN }), rows(), dbError("08006", `down for ${NEW_EMAIL}`)]);
    await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toEqual({ ok: true, value: { invited: true } });
    expect(serviceQueries).toEqual([link(), ...STILL_QUERIES, usedBy(LOGIN), unlinks(LOGIN)]);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("changeEmail relink check failed", { code: "08006", status: undefined });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("example");
    expectRevalidated();
  });

  it("never logs an email address", async () => {
    const failure = { name: "AuthApiError", code: "unexpected_failure", status: 500, message: `Failed for ${EMAIL} and ${NEW_EMAIL}` };
    const down = dbError("08006", `down for ${NEW_EMAIL}`);
    const scenarios: (() => void)[] = [
      () => getUserById.mockResolvedValueOnce({ data: { user: null }, error: failure }),
      () => serviceRpc.mockResolvedValueOnce({ data: null, error: failure }),
      () => serviceSees([down]),
      () => {
        serviceSees([rows(PERSON), done()]);
        updateUserById.mockResolvedValueOnce({ data: { user: null }, error: failure });
      },
      () => {
        serviceSees([rows(PERSON), down]);
        updateUserById.mockResolvedValueOnce({ data: { user: null }, error: { ...failure, code: "email_exists", status: 422 } });
      },
      () => {
        readsAgain();
        serviceSees([rows(PERSON), stillRow()], { grants: { data: [{ grant_name: "admin" }], error: null } });
        updateUserById
          .mockResolvedValueOnce({ data: { user: { id: LOGIN } }, error: null })
          .mockResolvedValueOnce({ data: { user: null }, error: failure });
      },
      () => {
        getUserById.mockResolvedValueOnce(authUser()).mockResolvedValueOnce({ data: { user: null }, error: failure });
        serviceSees([rows(PERSON), stillRow(), done()], { grants: { data: [{ grant_name: "admin" }], error: null } });
      },
      () => {
        readsAgain();
        serviceSees([rows(PERSON), LATE_GONE[0][1], down, done()]);
      },
      () => {
        serviceSees([rows(PERSON), LATE_GONE[0][1], rows()]);
        getUserById.mockResolvedValueOnce(authUser()).mockResolvedValueOnce(authUser({ deleted_at: NOW }));
        updateUserById
          .mockResolvedValueOnce({ data: { user: { id: LOGIN } }, error: null })
          .mockResolvedValueOnce({ data: { user: null }, error: failure });
      },
      () => {
        getUserById.mockResolvedValueOnce(authUser(UNUSED));
        inviteUserByEmail.mockResolvedValueOnce({ data: { user: null }, error: failure });
      },
      () => {
        getUserById.mockResolvedValueOnce(authUser(UNUSED));
        serviceSees([down, rows()]);
      },
    ];
    for (const arrange of scenarios) {
      changeAllowed();
      userQueue.teams = [noOrganisation()];
      arrange();
      await expect(changeEmail(PERSON, NEW_EMAIL)).resolves.toMatchObject({ ok: false });
    }
    expect(vi.mocked(console.error).mock.calls.map(([context]) => context)).toEqual([
      "changeEmail lookup failed",
      "changeEmail in use failed",
      "changeEmail record failed",
      "changeEmail update failed",
      "changeEmail unrecord failed",
      "changeEmail restore failed",
      "changeEmail recheck failed",
      "changeEmail removal check failed",
      "changeEmail free failed",
      "changeEmail invite failed",
      "changeEmail link failed",
    ]);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/@|example/);
  });
});
