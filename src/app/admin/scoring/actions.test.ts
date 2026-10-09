import { revalidatePath } from "next/cache";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENERIC_ERROR, NO_PERMISSION } from "@/lib/admin/errors";
import { DEFAULT_FORM } from "@/lib/admin/scoring";
import { createClient } from "@/lib/supabase/server";
import { saveScoring } from "./actions";

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

// The signed-in user's client: claims, the admin grant check, and
// from("scoring_settings").update(values).eq("id", 1).select("id").
const getClaims = vi.fn();
const rpc = vi.fn();
const select = vi.fn();
const eq = vi.fn(() => ({ select }));
const update = vi.fn<(values: unknown) => { eq: typeof eq }>(() => ({ eq }));
const from = vi.fn<(table: string) => { update: typeof update }>(() => ({ update }));

function signedIn({ admin }: { admin: boolean }) {
  getClaims.mockResolvedValue({ data: { claims: { sub: "b0000000-0000-4000-8000-000000000001" } }, error: null });
  rpc.mockImplementation(async (fn: string) =>
    fn === "app_has_grant"
      ? { data: admin, error: null }
      : { data: "a0000000-0000-4000-8000-000000000001", error: null },
  );
}

const SAVED_DEFAULTS = {
  activity_1: 1,
  activity_2: 2,
  activity_3: 3,
  activity_4: 4,
  activity_5: 5,
  excellence_1: 1,
  excellence_2: 2,
  excellence_3: 3,
  excellence_4: 4,
  excellence_5: 5,
  morale_1: 0.6,
  morale_2: 0.8,
  morale_3: 1,
  morale_4: 1.1,
  morale_5: 1.2,
  green_threshold: 12,
  yellow_threshold: 6,
};

beforeEach(() => {
  vi.mocked(createClient).mockResolvedValue({ auth: { getClaims }, rpc, from } as never);
  for (const fn of [getClaims, rpc, select, eq, update, from, vi.mocked(revalidatePath)]) fn.mockClear();
  select.mockResolvedValue({ data: [{ id: 1 }], error: null });
  signedIn({ admin: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function expectNothingWritten() {
  expect(from).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(revalidatePath).not.toHaveBeenCalled();
}

describe("saveScoring", () => {
  it("saves the settings as numbers on row 1 and refreshes the scoring page and the heat-map", async () => {
    await expect(saveScoring({ ...DEFAULT_FORM, morale_3: "1.05", green_threshold: " 12.50 " })).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(from).toHaveBeenCalledExactlyOnceWith("scoring_settings");
    expect(update).toHaveBeenCalledExactlyOnceWith({ ...SAVED_DEFAULTS, morale_3: 1.05, green_threshold: 12.5 });
    expect(eq).toHaveBeenCalledExactlyOnceWith("id", 1);
    expect(select).toHaveBeenCalledExactlyOnceWith("id");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/scoring");
    expect(revalidatePath).toHaveBeenCalledWith("/portal/dashboard", "layout");
  });

  it("sends only the 17 setting columns, whatever else the client sends", async () => {
    await saveScoring({ ...DEFAULT_FORM, id: 2, updated_by: "a0000000-0000-4000-8000-000000000009", updated_at: "x" });
    expect(update).toHaveBeenCalledExactlyOnceWith(SAVED_DEFAULTS);
  });

  it("refuses someone without the admin grant without writing", async () => {
    signedIn({ admin: false });
    await expect(saveScoring(DEFAULT_FORM)).resolves.toEqual({ ok: false, error: NO_PERMISSION });
    expectNothingWritten();
  });

  it("refuses a signed-out caller without writing", async () => {
    getClaims.mockResolvedValue({ data: null, error: null });
    await expect(saveScoring(DEFAULT_FORM)).resolves.toEqual({ ok: false, error: NO_PERMISSION });
    expect(rpc).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it("checks the grant before looking at the input", async () => {
    signedIn({ admin: false });
    await expect(saveScoring("garbage")).resolves.toEqual({ ok: false, error: NO_PERMISSION });
  });

  it.each([
    [{ activity_2: "0.001" }, "Activity 2: Use at most two decimals."],
    [{ excellence_4: "1e3" }, "Excellence 4: Enter a plain number, like 1.25."],
    [{ morale_1: "NaN" }, "Morale 1: Enter a plain number, like 1.25."],
    [{ morale_5: "Infinity" }, "Morale 5: Enter a plain number, like 1.25."],
    [{ activity_5: "1000.01" }, "Activity 5: Use a number from 0.01 to 1,000."],
    [{ green_threshold: "1000000" }, "Green threshold: Use a number from 0.01 to 999,999.99."],
    [{ yellow_threshold: "" }, "Yellow threshold: Enter a number."],
  ])("refuses an unusable value without writing: %o", async (changes, error) => {
    await expect(saveScoring({ ...DEFAULT_FORM, ...changes })).resolves.toEqual({ ok: false, error });
    expectNothingWritten();
  });

  it("refuses something that isn't a form", async () => {
    await expect(saveScoring(null)).resolves.toEqual({ ok: false, error: "Activity 1: Enter a number." });
    expectNothingWritten();
  });

  it.each([
    [{ activity_3: "1" }, "Activity 3 counts for less than activity 2."],
    [{ yellow_threshold: "13" }, "The yellow threshold (13) must be below the green one (12)."],
    [{ green_threshold: "40" }, "No check-in can be green with these settings."],
  ])("refuses settings the database would refuse, without writing: %o", async (changes, error) => {
    await expect(saveScoring({ ...DEFAULT_FORM, ...changes })).resolves.toEqual({ ok: false, error });
    expectNothingWritten();
  });

  it("shows the database's own refusal as it is", async () => {
    const message =
      "These scoring settings leave a colour that no check-in can reach (of 125 possible check-ins: 0 green, 50 yellow, 75 red).";
    select.mockResolvedValue({ data: null, error: { code: "23514", message, details: null, hint: null } });
    await expect(saveScoring(DEFAULT_FORM)).resolves.toEqual({ ok: false, error: message });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says 'no permission' when RLS refuses the update", async () => {
    select.mockResolvedValue({
      data: null,
      error: { code: "42501", message: 'permission denied for table scoring_settings', details: null, hint: null },
    });
    await expect(saveScoring(DEFAULT_FORM)).resolves.toEqual({ ok: false, error: NO_PERMISSION });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says 'no permission' when the update reaches no row", async () => {
    select.mockResolvedValue({ data: [], error: null });
    await expect(saveScoring(DEFAULT_FORM)).resolves.toEqual({ ok: false, error: NO_PERMISSION });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("hides anything else behind the generic sentence and logs only the code and status", async () => {
    select.mockResolvedValue({
      data: null,
      error: { code: "08006", message: "connection to hq@example.com failed", details: "secret", hint: null },
    });
    await expect(saveScoring(DEFAULT_FORM)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(console.error).toHaveBeenCalledExactlyOnceWith("saveScoring failed", { code: "08006", status: undefined });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
