import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GENERIC_ERROR, NO_PERMISSION } from "@/lib/admin/errors";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { deleteRecording, resetCheckin } from "./actions";
import { CHECKIN_GONE, NOT_GRADED } from "./messages";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
// Mocked whole, so its `import "server-only"` never runs.
vi.mock("@/lib/supabase/admin", () => ({ createServiceRoleClient: vi.fn() }));

const CHECKIN = "d7d00000-0000-4000-8000-000000000001";
const MEMBER = "d7c00000-0000-4000-8000-000000000002";
const PATH = `${MEMBER}/2026-10-05-take.webm`;
const DRAFT = `${MEMBER}/2026-10-05-stray.webm`;

const getClaims = vi.fn();
const rpc = vi.fn();
const remove = vi.fn();
const storageFrom = vi.fn(() => ({ remove }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  getClaims.mockResolvedValue({ data: { claims: { sub: "user" } } });
  remove.mockResolvedValue({ data: [], error: null });
  vi.mocked(createClient).mockResolvedValue({ auth: { getClaims }, rpc } as never);
  vi.mocked(createServiceRoleClient).mockReturnValue({ storage: { from: storageFrom } } as never);
});

describe.each([
  ["deleteRecording", deleteRecording, "hq_delete_checkin_recording", PATH, [PATH]],
  ["resetCheckin", resetCheckin, "hq_reset_checkin", [PATH, DRAFT], [PATH, DRAFT]],
] as const)("%s", (_name, action, fn, returned, removed) => {
  it("asks the database as the signed-in user, then removes the files it hands back", async () => {
    rpc.mockResolvedValue({ data: returned, error: null });
    await expect(action(CHECKIN.toUpperCase())).resolves.toEqual({ ok: true, value: null });
    expect(rpc).toHaveBeenCalledWith(fn, { p_checkin_id: CHECKIN });
    expect(storageFrom).toHaveBeenCalledWith("checkin-audio");
    expect(remove).toHaveBeenCalledWith(removed);
    expect(revalidatePath).toHaveBeenCalledWith("/portal/dashboard", "layout");
    expect(revalidatePath).toHaveBeenCalledWith("/portal/checkin");
  });

  it("removes nothing when there is no file", async () => {
    rpc.mockResolvedValue({ data: fn === "hq_reset_checkin" ? [] : null, error: null });
    await expect(action(CHECKIN)).resolves.toEqual({ ok: true, value: null });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("refuses anyone the database refuses, and touches no file", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "Only a Master Admin can …" } });
    await expect(action(CHECKIN)).resolves.toEqual({ ok: false, error: NO_PERMISSION });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller before asking the database", async () => {
    getClaims.mockResolvedValue({ data: null });
    await expect(action(CHECKIN)).resolves.toEqual({ ok: false, error: NO_PERMISSION });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("says when the check-in is already gone", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "no_checkin" } });
    await expect(action(CHECKIN)).resolves.toEqual({ ok: false, error: CHECKIN_GONE });
  });

  it("refuses an id that isn't one", async () => {
    await expect(action("../not-an-id")).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    await expect(action(42 as never)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("still succeeds when removing the file fails (housekeeping removes it later)", async () => {
    rpc.mockResolvedValue({ data: returned, error: null });
    remove.mockResolvedValue({ data: null, error: { name: "StorageError" } });
    await expect(action(CHECKIN)).resolves.toEqual({ ok: true, value: null });
    vi.mocked(createServiceRoleClient).mockImplementation(() => {
      throw new Error("no key");
    });
    await expect(action(CHECKIN)).resolves.toEqual({ ok: true, value: null });
  });

  it("hides any other database error behind a generic sentence", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "canceling statement" } });
    await expect(action(CHECKIN)).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
  });
});

it("deleteRecording explains that an ungraded check-in keeps its recording", async () => {
  rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "not_graded" } });
  await expect(deleteRecording(CHECKIN)).resolves.toEqual({ ok: false, error: NOT_GRADED });
});
