import { describe, expect, it } from "vitest";
import type { CheckinErrorCode } from "./actions";
import { takeToRetry, type Take } from "./take";

const take: Take = {
  blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
  mimeType: "audio/webm",
  durationMs: 95_000,
  uploadedPath: "3e3b0000-0000-4000-8000-000000000003/2026-10-05-take.webm",
};

describe("takeToRetry", () => {
  it("keeps the uploaded file after a failure on our side, so Try again doesn't upload it twice", () => {
    expect(takeToRetry("failed", take)).toBe(take);
  });

  it.each<CheckinErrorCode>(["upload_missing", "upload_expired", "bad_path", "upload_too_big", "upload_not_audio"])(
    "uploads afresh after %s",
    (code) => {
      const retry = takeToRetry(code, take);
      expect(retry).toEqual({ ...take, uploadedPath: null });
      expect(retry.blob).toBe(take.blob); // the recording itself is kept
    },
  );
});
