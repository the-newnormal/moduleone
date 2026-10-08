import { describe, expect, it, vi } from "vitest";
import { playableRecordings, recordingCheckinId, recordingPath } from "./recordings";

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
