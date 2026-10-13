import { describe, expect, it, vi } from "vitest";
import { playableRecordings, recordingCheckinId, recordingLink, recordingPath } from "./recordings";

function storage(result: unknown) {
  const createSignedUrls = vi.fn().mockResolvedValue(result);
  const supabase = { storage: { from: vi.fn(() => ({ createSignedUrls })) } };
  return { supabase: supabase as never, createSignedUrls };
}

describe("playableRecordings", () => {
  it("keeps only the files Storage agreed to sign", async () => {
    const { supabase, createSignedUrls } = storage({
      data: [
        { path: "a/1.webm", signedUrl: "https://s/1", error: null },
        { path: "b/2.webm", signedUrl: null, error: "Either the object does not exist or you do not have access to it" },
      ],
      error: null,
    });
    expect(await playableRecordings(supabase, ["a/1.webm", "b/2.webm"])).toEqual(new Set(["a/1.webm"]));
    expect(createSignedUrls).toHaveBeenCalledOnce();
  });

  it("shows no players when Storage is unavailable", async () => {
    const { supabase } = storage({ data: null, error: { message: "down" } });
    expect(await playableRecordings(supabase, ["a/1.webm"])).toEqual(new Set());
  });

  it("doesn't ask Storage when there are no recordings", async () => {
    const { supabase, createSignedUrls } = storage({ data: [], error: null });
    expect(await playableRecordings(supabase, [])).toEqual(new Set());
    expect(createSignedUrls).not.toHaveBeenCalled();
  });
});

describe("recordingPath", () => {
  it("points at the same-site route that signs on request, ending with the file's extension", () => {
    expect(recordingPath("abc", "member/2026-09-21-take2.webm")).toBe("/portal/dashboard/recording/abc.webm");
    expect(recordingPath("abc", "member/2026-09-21.MP4")).toBe("/portal/dashboard/recording/abc.MP4");
  });

  it("leaves the extension off when the file has none", () => {
    expect(recordingPath("abc", "member/recording")).toBe("/portal/dashboard/recording/abc");
    expect(recordingPath("abc", "member.dir/recording")).toBe("/portal/dashboard/recording/abc");
  });
});

describe("recordingCheckinId", () => {
  it("takes the check-in id back out of an address, with or without its extension", () => {
    expect(recordingCheckinId("abc.webm")).toBe("abc");
    expect(recordingCheckinId("abc")).toBe("abc");
    expect(recordingCheckinId("abc.webm.webm")).toBe("abc.webm"); // one extension only
  });
});

describe("recordingLink", () => {
  const OWNER = "3e3b0000-0000-4000-8000-000000000004";
  function client(row: unknown, signed: unknown) {
    const select = vi.fn(() => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }));
    const createSignedUrl = vi.fn().mockResolvedValue(signed);
    const supabase = { from: vi.fn(() => ({ select })), storage: { from: vi.fn(() => ({ createSignedUrl })) } };
    return { supabase: supabase as never, select, createSignedUrl };
  }

  it("signs a ten-minute link, and says whose check-in it is", async () => {
    const { supabase, select, createSignedUrl } = client(
      { audio_path: `${OWNER}/2026-09-21.webm`, member_id: OWNER },
      { data: { signedUrl: "https://s/1" }, error: null },
    );
    expect(await recordingLink(supabase, "abc")).toEqual({ link: "https://s/1", ownerId: OWNER });
    expect(select).toHaveBeenCalledExactlyOnceWith("audio_path, member_id");
    expect(createSignedUrl).toHaveBeenCalledExactlyOnceWith(`${OWNER}/2026-09-21.webm`, 600);
  });

  it.each([
    ["the check-in can't be read", null, { data: { signedUrl: "https://s/1" }, error: null }],
    ["it has no recording", { audio_path: null, member_id: OWNER }, { data: { signedUrl: "https://s/1" }, error: null }],
    ["Storage won't sign it", { audio_path: "x/y.webm", member_id: OWNER }, { data: null, error: { message: "denied" } }],
  ])("is null when %s", async (_label, row, signed) => {
    expect(await recordingLink(client(row, signed).supabase, "abc")).toBeNull();
  });
});
