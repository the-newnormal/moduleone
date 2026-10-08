import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@/lib/supabase/server";
import { GET } from "./route";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ID = "0a2a0934-0640-4c5f-87b9-4d50688ef9c6";
const PATH = "3e3b0000-0000-4000-8000-000000000004/2026-09-21.webm";
const getClaims = vi.fn();
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
    storage: { from: storageFrom },
  } as never);
  getClaims.mockResolvedValue({ data: { claims: { sub: "user" } } });
  maybeSingle.mockResolvedValue({ data: { audio_path: PATH }, error: null });
  createSignedUrl.mockImplementation(async () => ({
    data: { signedUrl: `https://supabase.test/sign/${PATH}?token=${createSignedUrl.mock.calls.length}` },
    error: null,
  }));
});

describe("GET /portal/dashboard/recording/[checkinId]", () => {
  it("redirects to a freshly signed link, uncached", async () => {
    const res = await get(ID);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`https://supabase.test/sign/${PATH}?token=1`);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
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

  it("answers 401 when signed out, without reading anything", async () => {
    getClaims.mockResolvedValue({ data: null });
    const res = await get(ID);
    expect(res.status).toBe(401);
    expect(select).not.toHaveBeenCalled();
  });

  it.each([
    ["the check-in is hidden by RLS or missing", () => maybeSingle.mockResolvedValue({ data: null, error: null })],
    ["it has no recording", () => maybeSingle.mockResolvedValue({ data: { audio_path: null }, error: null })],
    [
      "Storage won't sign it for this viewer",
      () => createSignedUrl.mockResolvedValue({ data: null, error: { message: "Object not found" } }),
    ],
  ])("answers 404 when %s", async (_label, arrange) => {
    arrange();
    const res = await get(ID);
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it.each(["not-a-uuid", "not-a-uuid.webm", `${ID}.webm.webm`, `${ID}x`, "..%2F..%2Fsecret", ""])(
    "answers 404 for a malformed id (%s)",
    async (id) => {
      const res = await get(id);
      expect(res.status).toBe(404);
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it("fails loudly when the check-in can't be read", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(get(ID)).rejects.toThrow("Couldn't load the check-in: boom");
  });
});
