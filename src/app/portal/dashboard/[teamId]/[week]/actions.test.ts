import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GENERIC_ERROR, NO_PERMISSION } from "@/lib/admin/errors";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { deleteRecording, resetCheckin } from "./actions";
import { CHECKIN_GONE, FILES_PENDING, NOT_GRADED } from "./messages";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
// Mocked whole, so its `import "server-only"` never runs.
vi.mock("@/lib/supabase/admin", () => ({ createServiceRoleClient: vi.fn() }));

const CHECKIN = "d7d00000-0000-4000-8000-000000000001";
const MEMBER = "d7c00000-0000-4000-8000-000000000002";
const PATH = `${MEMBER}/2026-10-05-take.webm`;
const DRAFT = `${MEMBER}/2026-10-05-stray.webm`;
const RESET = "d7e00000-0000-4000-8000-000000000001"; // the checkin_resets row

const getClaims = vi.fn();
const rpc = vi.fn();
const remove = vi.fn();
const storageFrom = vi.fn(() => ({ remove }));
// The service role's stamp on the log row: update(...).eq("id", …).
const stampEq = vi.fn();
const update = vi.fn(() => ({ eq: stampEq }));
const adminFrom = vi.fn(() => ({ update }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  getClaims.mockResolvedValue({ data: { claims: { sub: "user" } } });
  remove.mockResolvedValue({ data: [], error: null });
  stampEq.mockResolvedValue({ error: null });
  vi.mocked(createClient).mockResolvedValue({ auth: { getClaims }, rpc } as never);
  vi.mocked(createServiceRoleClient).mockReturnValue({ storage: { from: storageFrom }, from: adminFrom } as never);
});

describe.each([
  ["deleteRecording", deleteRecording, "hq_delete_checkin_recording", [PATH]],
  ["resetCheckin", resetCheckin, "hq_reset_checkin", [PATH, DRAFT]],
] as const)("%s", (_name, action, fn, paths) => {
  const returned = [{ reset_id: RESET, audio_paths: [...paths] }];

  it("asks the database as the signed-in user, removes the files it hands back, then stamps the log", async () => {
    rpc.mockResolvedValue({ data: returned, error: null });
    await expect(action(CHECKIN.toUpperCase())).resolves.toEqual({ ok: true, value: null });
    expect(rpc).toHaveBeenCalledWith(fn, { p_checkin_id: CHECKIN });
    expect(storageFrom).toHaveBeenCalledWith("checkin-audio");
    expect(remove).toHaveBeenCalledWith(paths);
    expect(adminFrom).toHaveBeenCalledWith("checkin_resets");
    expect(update).toHaveBeenCalledWith({ files_removed_at: expect.any(String) });
    expect(stampEq).toHaveBeenCalledWith("id", RESET);
    expect(revalidatePath).toHaveBeenCalledWith("/portal/dashboard", "layout");
    expect(revalidatePath).toHaveBeenCalledWith("/portal/checkin");
  });

  it("removes nothing when there is no file", async () => {
    // A reset of a check-in without a recording logs a row with no files; deleting a recording
    // that isn't there returns no row at all.
    rpc.mockResolvedValue({
      data: fn === "hq_reset_checkin" ? [{ reset_id: RESET, audio_paths: [] }] : [],
      error: null,
    });
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

  it("says so when Storage doesn't delete the file, and leaves the log row for the daily retry", async () => {
    rpc.mockResolvedValue({ data: returned, error: null });
    remove.mockResolvedValue({ data: null, error: { name: "StorageError" } });
    await expect(action(CHECKIN)).resolves.toEqual({ ok: false, error: FILES_PENDING });
    expect(update).not.toHaveBeenCalled();
    // The check-in did change, so the page still re-renders.
    expect(revalidatePath).toHaveBeenCalledWith("/portal/dashboard", "layout");
  });

  it("says so when the service role can't be used at all", async () => {
    rpc.mockResolvedValue({ data: returned, error: null });
    vi.mocked(createServiceRoleClient).mockImplementation(() => {
      throw new Error("no key");
    });
    await expect(action(CHECKIN)).resolves.toEqual({ ok: false, error: FILES_PENDING });
  });

  it("succeeds when the files went but the stamp failed (the retry finds nothing left)", async () => {
    rpc.mockResolvedValue({ data: returned, error: null });
    stampEq.mockResolvedValue({ error: { code: "57014" } });
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
