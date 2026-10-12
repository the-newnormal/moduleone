import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODE_TAKEN, EMAIL_NOTED, fail, GENERIC_ERROR, logError, NO_PERMISSION, settle, toUserMessage } from "./errors";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// What PostgREST hands back: code, message, details (may hold row values) and hint.
const pg = (code: string, message: string, details = "Failing row contains (Mei Wong, mei@example.com).") => ({
  code,
  message,
  details,
  hint: null,
});

describe("toUserMessage", () => {
  it.each([
    "Move its 2 members out first.",
    "Restore the parent first: it is archived.",
    "A team can only sit under a domain.",
    "These scoring settings leave a colour that no check-in can reach (of 125 possible check-ins: 0 green, 50 yellow, 75 red).",
    "Only members with the leader role can lead a team. Make them a leader first.",
    // 0014's pending_login_emails_check, refusing an address for someone who can't be given a login.
    "This person was removed from Module One. Reload the page.",
    "Master Admins get their login from the project owner.",
    "This person already has a login. To change the address they sign in with, use Change email.",
    "This person holds grants (such as admin), so only the project owner can give them a login.",
  ])("shows the database's own 23514 sentence: %s", (message) => {
    expect(toUserMessage(pg("23514", message))).toBe(message);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("shows 0003's P0002 sentence", () => {
    expect(toUserMessage(pg("P0002", "That team doesn't exist."))).toBe("That team doesn't exist.");
  });

  it("shows 0014's P0002 sentence for an address noted for someone who's gone", () => {
    const message = "This person doesn't exist any more. Reload the page.";
    expect(toUserMessage(pg("P0002", message))).toBe(message);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("words a table check constraint instead of naming it", () => {
    expect(
      toUserMessage(pg("23514", 'new row for relation "teams" violates check constraint "teams_code_format"')),
    ).toBe("Codes are 1–8 letters or digits, optionally a dot and 1–8 more, like IP.X or IP.1.");
    expect(
      toUserMessage(
        pg("23514", 'new row for relation "scoring_settings" violates check constraint "scoring_thresholds_order"'),
      ),
    ).toBe("The yellow threshold must be below the green one.");
  });

  it("asks for an address like name@example.com when 0014's format check refuses one, never repeating it", () => {
    const error = pg(
      "23514",
      'new row for relation "pending_login_emails" violates check constraint "pending_login_emails_email_format"',
      "Failing row contains (a0000000-0000-4000-8000-000000000001, Mei@Example.com , null, 2026-10-12 01:03:00+00).",
    );
    const message = toUserMessage(error, "setPendingEmail note");
    expect(message).toBe("Enter an email address like name@example.com.");
    expect(message).not.toMatch(/Mei|a0000000|pending_login_emails/);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("falls back to the generic sentence for a constraint it doesn't know", () => {
    const error = pg("23514", 'new row for relation "teams" violates check constraint "teams_new_rule"');
    expect(toUserMessage(error, "addTeam")).toBe(GENERIC_ERROR);
    expect(console.error).toHaveBeenCalledWith("addTeam failed", { code: "23514", status: undefined });
  });

  it.each([
    "Only admins can move teams.",
    "You lead where this is going, so another admin has to move it there.",
    "Only the project owner can place people in the organisation itself.",
    "Only the project owner can make someone a lead of the organisation itself.",
    // 0009's admin_remove_member and 0014's admin_add_members.
    "Only admins can remove people.",
    "Only admins can add people.",
  ])(
    "shows a migration's own 42501 sentence: %s",
    (message) => {
      expect(toUserMessage(pg("42501", message))).toBe(message);
      expect(console.error).not.toHaveBeenCalled();
    },
  );

  it("shows 0014's own 42501 sentence only when it's exactly that sentence", () => {
    expect(toUserMessage(pg("42501", "Only admins can add people. Ask Mei."))).toBe(NO_PERMISSION);
    expect(toUserMessage(pg("42501", "only admins can add people."))).toBe(NO_PERMISSION);
    // Spaces and line breaks around it are trimmed, as for the others.
    expect(toUserMessage(pg("42501", " Only admins can add people.\n"))).toBe("Only admins can add people.");
  });

  it.each([
    'new row violates row-level security policy for table "team_leads"',
    "permission denied for table member_grants",
    "",
  ])("says 'no permission' for any other 42501: %j", (message) => {
    expect(toUserMessage(pg("42501", message))).toBe(NO_PERMISSION);
  });

  it("says the code is taken for a duplicate team code", () => {
    expect(
      toUserMessage(pg("23505", 'duplicate key value violates unique constraint "teams_code_key"', "Key (code)=(IP.X) already exists.")),
    ).toBe(CODE_TAKEN);
  });

  it("says the address is noted for someone else for a duplicate noted email, never repeating it", () => {
    const error = pg(
      "23505",
      'duplicate key value violates unique constraint "pending_login_emails_email_key"',
      "Key (email)=(mei@example.com) already exists.",
    );
    const message = toUserMessage(error, "setPendingEmail note");
    expect(message).toBe(EMAIL_NOTED);
    expect(message).not.toMatch(/mei@|pending_login_emails/);
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([
    ["another unique violation", pg("23505", 'duplicate key value violates unique constraint "team_leads_pkey"')],
    // Someone already has an address noted (setPendingEmail handles this one itself).
    [
      "a second noted address for one person",
      pg("23505", 'duplicate key value violates unique constraint "pending_login_emails_pkey"'),
    ],
    // The constraint's name without the quotes Postgres puts round it isn't its refusal.
    ["a mention of the noted-email key that isn't the refusal", pg("23505", "pending_login_emails_email_key, mei@example.com")],
    // admin_add_members's own checks, which createMembers makes first.
    ["a list of the wrong size", pg("22023", "Add from 1 to 200 people at a time.")],
    ["a READ COMMITTED refusal", pg("25000", "Change the team tree in a READ COMMITTED transaction.")],
    ["a position out of range", pg("22023", "The position must be between 0 and 10000.")],
    ["a 23514 without a message", { code: "23514", message: "" }],
    ["a network failure", { code: "", message: "TypeError: fetch failed", status: 0 }],
    ["no error at all", null],
    ["an empty object", {}],
  ])("falls back to the generic sentence for %s, logging only code and status", (_label, error) => {
    expect(toUserMessage(error, "moveTeam")).toBe(GENERIC_ERROR);
    expect(console.error).toHaveBeenCalledOnce();
    const [context, logged] = vi.mocked(console.error).mock.calls[0];
    expect(context).toBe("moveTeam failed");
    expect(Object.keys(logged as object).sort()).toEqual(["code", "status"]);
    expect(JSON.stringify(logged)).not.toMatch(/Mei|mei@|example\.com|fetch failed|READ COMMITTED|200 people/);
  });

  it("never shows details or hints", () => {
    const message = toUserMessage(pg("23514", "Move its 1 member out first.", "Failing row contains (secret)."));
    expect(message).not.toContain("secret");
  });
});

describe("logError", () => {
  it("logs the code and status only", () => {
    logError("giveLogin", { code: "email_exists", status: 422, message: "mei@example.com is taken", name: "AuthApiError" });
    expect(console.error).toHaveBeenCalledExactlyOnceWith("giveLogin failed", { code: "email_exists", status: 422 });
  });

  it("copes with anything thrown", () => {
    for (const thrown of [new Error("boom"), "boom", null, undefined, 7, { code: { nested: true }, status: "500" }]) {
      logError("x", thrown);
    }
    for (const [, logged] of vi.mocked(console.error).mock.calls) {
      expect(logged).toEqual({ code: undefined, status: undefined });
    }
  });
});

describe("fail", () => {
  it("is a refusal with the sentence to show", () => {
    expect(fail("Enter a name.")).toEqual({ ok: false, error: "Enter a name." });
  });
});

describe("settle", () => {
  it("passes an action's answer through, refusals included", async () => {
    await expect(settle(async () => ({ ok: true, value: 1 }), "x")).resolves.toEqual({ ok: true, value: 1 });
    await expect(settle(async () => fail("Move its 2 members out first."), "x")).resolves.toEqual({
      ok: false,
      error: "Move its 2 members out first.",
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("turns a thrown error into the generic sentence and logs only its code", async () => {
    await expect(
      settle(async () => {
        throw Object.assign(new TypeError("Failed to fetch hq@example.com"), { code: "ECONN" });
      }, "moveNode"),
    ).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(console.error).toHaveBeenCalledExactlyOnceWith("moveNode failed", { code: "ECONN", status: undefined });
  });
});
