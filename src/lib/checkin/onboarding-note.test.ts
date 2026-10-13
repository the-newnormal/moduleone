import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServiceRoleClient, MissingServiceKeyError } from "@/lib/supabase/admin";
import { noteOnboardingForm, ONBOARDING_NOTE_VERSION, RECORDING_KEEP_DAYS } from "./onboarding-note";

// The Diary's note that a login is assumed to have agreed on the onboarding form, outside Module One
// (no privacy notice in the app since the product owner's decision of 13 October 2026). 0013's
// submit_checkin_draft keeps a take a year only when its login had such a row before the take
// started (supabase/tests/diary_retention_test.sql covers that side).

// Mocked whole, so its `import "server-only"` never runs.
vi.mock("@/lib/supabase/admin", () => ({
  createServiceRoleClient: vi.fn(),
  MissingServiceKeyError: class MissingServiceKeyError extends Error {
    name = "MissingServiceKeyError";
  },
}));

const USER = "5eed0000-0000-4000-8000-000000000003";
const MEMBER = "3e3b0000-0000-4000-8000-000000000003";

const from = vi.fn();
const upsert = vi.fn();

beforeEach(() => {
  from.mockReset().mockReturnValue({ upsert });
  upsert.mockReset().mockResolvedValue({ data: null, error: null });
  vi.mocked(createServiceRoleClient).mockReset().mockReturnValue({ from } as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("noteOnboardingForm", () => {
  it("notes the assumed onboarding form for this member and login, keeping the first note", async () => {
    expect(await noteOnboardingForm(MEMBER, USER)).toEqual({ error: null });
    expect(from).toHaveBeenCalledExactlyOnceWith("recording_notices");
    expect(upsert).toHaveBeenCalledExactlyOnceWith(
      {
        member_id: MEMBER,
        auth_user_id: USER,
        notice_version: "assumed:onboarding-form.2026-10-13",
        recording_keep_days: 365,
      },
      { onConflict: "member_id,auth_user_id,notice_version", ignoreDuplicates: true },
    );
  });

  // accepted_at is the database's now(): when Module One first relied on the form for this login.
  // Sending one could backdate it, and lengthen a take recorded under a 90-day notice.
  it("never sends a time of its own", async () => {
    await noteOnboardingForm(MEMBER, USER);
    const [row] = upsert.mock.calls[0];
    expect(Object.keys(row).sort()).toEqual(["auth_user_id", "member_id", "notice_version", "recording_keep_days"]);
    expect(row).not.toHaveProperty("accepted_at");
  });

  it("passes on only the code of a database error, and logs nothing", async () => {
    upsert.mockResolvedValue({ data: null, error: { code: "42501", message: `permission denied for ${MEMBER}` } });
    expect(await noteOnboardingForm(MEMBER, USER)).toEqual({ error: { code: "42501" } });
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
  });

  it("never throws: a missing service key is an error like any other", async () => {
    vi.mocked(createServiceRoleClient).mockImplementation(() => {
      throw new MissingServiceKeyError();
    });
    expect(await noteOnboardingForm(MEMBER, USER)).toEqual({ error: { code: "MissingServiceKeyError" } });
  });

  it("never throws when the request fails", async () => {
    upsert.mockRejectedValue(new TypeError("fetch failed"));
    expect(await noteOnboardingForm(MEMBER, USER)).toEqual({ error: { code: "TypeError" } });
  });
});

describe("the note", () => {
  it("promises a year, as the onboarding form says", () => {
    expect(RECORDING_KEEP_DAYS).toBe(365);
  });

  // recording_notices.notice_version is 1-100 characters (0004). Every in-app notice's version
  // started with its date, so "assumed:" never collides with one, and says what the row is.
  it("has a version that says it is an assumption, and can't be taken for an in-app notice", () => {
    expect(ONBOARDING_NOTE_VERSION.length).toBeGreaterThanOrEqual(1);
    expect(ONBOARDING_NOTE_VERSION.length).toBeLessThanOrEqual(100);
    expect(ONBOARDING_NOTE_VERSION.startsWith("assumed:")).toBe(true);
    expect(ONBOARDING_NOTE_VERSION).not.toMatch(/^\d/);
  });
});
