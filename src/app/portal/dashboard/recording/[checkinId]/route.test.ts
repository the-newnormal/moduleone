import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@/lib/supabase/server";
import { GET } from "./route";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ID = "0a2a0934-0640-4c5f-87b9-4d50688ef9c6";
const OWNER = "3e3b0000-0000-4000-8000-000000000004";
const VIEWER = "3e3b0000-0000-4000-8000-000000000009"; // a leader or hq with the recordings grant
const PATH = `${OWNER}/2026-09-21.webm`;
const getClaims = vi.fn();
// The viewer's database functions, by name: who they are (app_current_member_id) and the view log.
let me: { data: string | null; error: unknown };
let noted: { data: null; error: unknown };
const rpc = vi.fn<(fn: string, args?: unknown) => Promise<{ data: unknown; error: unknown }>>(async (fn) =>
  fn === "app_current_member_id"
    ? me
    : fn === "log_checkin_views"
      ? noted
      : { data: null, error: { code: "42883", message: `unexpected rpc ${fn}` } },
);
const logged = () => rpc.mock.calls.filter(([fn]) => fn === "log_checkin_views");
const maybeSingle = vi.fn();
const eq = vi.fn(() => ({ maybeSingle }));
const select = vi.fn(() => ({ eq }));
const createSignedUrl = vi.fn();
const storageFrom = vi.fn(() => ({ createSignedUrl }));

function get(id: string) {
  return GET(new NextRequest(`https://moduleone.test/portal/dashboard/recording/${id}`), {
    params: Promise.resolve({ checkinId: id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createClient).mockResolvedValue({
    auth: { getClaims },
    from: vi.fn(() => ({ select })),
    rpc,
    storage: { from: storageFrom },
  } as never);
  getClaims.mockResolvedValue({ data: { claims: { sub: "user" } } });
  maybeSingle.mockResolvedValue({ data: { audio_path: PATH, member_id: OWNER }, error: null });
  me = { data: VIEWER, error: null };
  noted = { data: null, error: null };
  vi.spyOn(console, "error").mockImplementation(() => {});
  createSignedUrl.mockImplementation(async () => ({
    data: { signedUrl: `https://supabase.test/sign/${PATH}?token=${createSignedUrl.mock.calls.length}` },
    error: null,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /portal/dashboard/recording/[checkinId]", () => {
  it("redirects to a freshly signed link, uncached", async () => {
    const res = await get(ID);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`https://supabase.test/sign/${PATH}?token=1`);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(select).toHaveBeenCalledWith("audio_path, member_id");
    expect(eq).toHaveBeenCalledWith("id", ID);
    expect(storageFrom).toHaveBeenCalledWith("checkin-audio");
    expect(createSignedUrl).toHaveBeenCalledWith(PATH, 600);
  });

  it("accepts the address with the file's extension, which only Safari needs", async () => {
    const res = await get(`${ID}.webm`);
    expect(res.status).toBe(307);
    expect(eq).toHaveBeenCalledWith("id", ID);
    expect(createSignedUrl).toHaveBeenCalledWith(PATH, 600);
  });

  it("signs a new link on every request, so an open page never goes stale", async () => {
    const first = await get(ID);
    const second = await get(ID);
    expect(first.headers.get("location")).not.toBe(second.headers.get("location"));
  });

  it("answers 401 when signed out, without reading or noting anything", async () => {
    getClaims.mockResolvedValue({ data: null });
    const res = await get(ID);
    expect(res.status).toBe(401);
    expect(select).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["the check-in is hidden by RLS or missing", () => maybeSingle.mockResolvedValue({ data: null, error: null })],
    ["it has no recording", () => maybeSingle.mockResolvedValue({ data: { audio_path: null }, error: null })],
    [
      "Storage won't sign it for this viewer",
      () => createSignedUrl.mockResolvedValue({ data: null, error: { message: "Object not found" } }),
    ],
  ])("answers 404 when %s, noting nothing", async (_label, arrange) => {
    arrange();
    const res = await get(ID);
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(logged()).toEqual([]);
  });

  it.each(["not-a-uuid", "not-a-uuid.webm", `${ID}.webm.webm`, `${ID}x`, "..%2F..%2Fsecret", ""])(
    "answers 404 for a malformed id (%s)",
    async (id) => {
      const res = await get(id);
      expect(res.status).toBe(404);
      expect(createClient).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("fails loudly when the check-in can't be read", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(get(ID)).rejects.toThrow("Couldn't load the check-in: boom");
    expect(logged()).toEqual([]);
  });
});

// Someone else's recording is noted in its owner's Diary before the link is handed over (0015).
describe("who played it", () => {
  it("never notes the speaker's own plays, so their Diary plays even without the log", async () => {
    me = { data: OWNER, error: null };
    noted = { data: null, error: { code: "42883", message: "function log_checkin_views does not exist" } };
    const res = await get(ID);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`https://supabase.test/sign/${PATH}?token=1`);
    expect(logged()).toEqual([]);
  });

  it("notes someone else's play, then redirects", async () => {
    const res = await get(ID);
    expect(logged()).toEqual([["log_checkin_views", { p_checkin_ids: [ID], p_kind: "played" }]]);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`https://supabase.test/sign/${PATH}?token=1`);
  });

  it("notes the check-in's bare id from the address with the file's extension", async () => {
    const res = await get(`${ID}.webm`);
    expect(res.status).toBe(307);
    expect(logged()).toEqual([["log_checkin_views", { p_checkin_ids: [ID], p_kind: "played" }]]);
  });

  it("answers 503 with no link when the play can't be noted, logging only the code", async () => {
    noted = { data: null, error: { code: "57014", message: `canceling statement for ${ID}` } };
    const res = await get(ID);
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toBe("");
    expect(console.error).toHaveBeenCalledWith("recording: noting the play failed", { code: "57014" });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(ID);
  });

  it.each([
    ["answers with an error", () => (me = { data: null, error: { code: "57014", message: "timeout" } })],
    ["has no member row", () => (me = { data: null, error: null })],
    ["throws", () => rpc.mockImplementationOnce(async () => Promise.reject(new Error("fetch failed")))],
  ])("treats the play as someone else's when who's asking %s", async (_label, arrange) => {
    arrange();
    const res = await get(ID);
    expect(res.status).toBe(307);
    expect(logged()).toEqual([["log_checkin_views", { p_checkin_ids: [ID], p_kind: "played" }]]);
  });
});
