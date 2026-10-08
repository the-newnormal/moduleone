import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";
import { describe, expect, it, vi } from "vitest";
import type { CheckinErrorCode } from "./actions";
import {
  REDEPLOYED_MESSAGE,
  saveTake,
  takeToRetry,
  TOO_SLOW_MESSAGE,
  UPLOAD_FAILED_MESSAGE,
  type ReadyToUpload,
  type SaveSteps,
  type Take,
} from "./take";
import { OFFLINE_MESSAGE } from "./unreachable";

const MEMBER = "3e3b0000-0000-4000-8000-000000000003";

const take: Take = {
  blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm;codecs=opus" }),
  mimeType: "audio/webm",
  durationMs: 95_000,
  uploadedPath: `${MEMBER}/2026-10-05-take.webm`,
};
// Just recorded: nothing uploaded yet.
const fresh: Take = { ...take, uploadedPath: null };

// prepareRecording's answer: a new path every time, as draftPath makes.
function ready(n: number): ReadyToUpload {
  return { status: "ready", path: `${MEMBER}/2026-10-05-${n}.webm`, token: `token-${n}`, contentType: "audio/webm" };
}

// A request on a connected but dead network: it never answers.
function hang(): Promise<never> {
  return new Promise(() => {});
}

// Short limits, so the timeout tests run quickly.
const QUICK = { prepareMs: 10, uploadMs: 10, saveMs: 10 };

// A server and a Storage that accept everything; each test makes one step go wrong.
function fakes() {
  let prepared = 0;
  return {
    prepare: vi.fn<SaveSteps["prepare"]>(async () => ready(++prepared)),
    upload: vi.fn<SaveSteps["upload"]>(async () => ({ error: null })),
    saveDraft: vi.fn<SaveSteps["saveDraft"]>(async () => ({ status: "saved" })),
  };
}

describe("saveTake", () => {
  it("prepares a path, uploads the take there and saves it as the draft", async () => {
    const steps = fakes();
    expect(await saveTake(fresh, steps)).toEqual({ step: "saved" });
    expect(steps.prepare).toHaveBeenCalledWith("audio/webm");
    const [target, body] = steps.upload.mock.calls[0];
    expect(target).toEqual(ready(1));
    expect(body.type).toBe("audio/webm"); // the plain type the server allowed, not the recorder's
    expect(body.size).toBe(3);
    expect(steps.saveDraft).toHaveBeenCalledWith({ path: ready(1).path, durationMs: 95_000 });
  });

  it("keeps the recording, with nothing uploaded, when the upload fails", async () => {
    const steps = fakes();
    steps.upload.mockResolvedValueOnce({ error: new Error("Network request failed") });
    const outcome = await saveTake(fresh, steps);
    expect(outcome).toEqual({ step: "failed", take: fresh, message: UPLOAD_FAILED_MESSAGE, updated: false });
    if (outcome.step === "failed") expect(outcome.take.blob).toBe(take.blob);
    expect(steps.saveDraft).not.toHaveBeenCalled();
  });

  it("keeps the uploaded path when saveDraft fails on our side, so Try again doesn't upload again", async () => {
    const steps = fakes();
    steps.saveDraft.mockResolvedValueOnce({ status: "error", code: "failed", message: "Something went wrong." });
    const outcome = await saveTake(fresh, steps);
    expect(outcome).toEqual({
      step: "failed",
      take: { ...fresh, uploadedPath: ready(1).path },
      message: "Something went wrong.",
      updated: false,
    });
    if (outcome.step !== "failed") return;

    expect(await saveTake(outcome.take, steps)).toEqual({ step: "saved" });
    expect(steps.prepare).toHaveBeenCalledOnce();
    expect(steps.upload).toHaveBeenCalledOnce();
    expect(steps.saveDraft.mock.calls.map(([input]) => input.path)).toEqual([ready(1).path, ready(1).path]);
  });

  it("uploads again, to a new path, when the server says the upload never arrived", async () => {
    const steps = fakes();
    steps.saveDraft.mockResolvedValueOnce({ status: "error", code: "upload_missing", message: "Try again." });
    const outcome = await saveTake(fresh, steps);
    expect(outcome).toEqual({ step: "failed", take: fresh, message: "Try again.", updated: false });
    if (outcome.step !== "failed") return;

    expect(await saveTake(outcome.take, steps)).toEqual({ step: "saved" });
    expect(steps.upload.mock.calls.map(([target]) => target.path)).toEqual([ready(1).path, ready(2).path]);
    expect(steps.saveDraft).toHaveBeenLastCalledWith({ path: ready(2).path, durationMs: 95_000 });
  });

  it("stops when this week's check-in is already in", async () => {
    const steps = fakes();
    steps.prepare.mockResolvedValueOnce({ status: "submitted" });
    expect(await saveTake(fresh, steps)).toEqual({ step: "saved" });
    expect(steps.upload).not.toHaveBeenCalled();
    expect(steps.saveDraft).not.toHaveBeenCalled();
  });

  it("is done when the check-in was submitted from elsewhere while uploading", async () => {
    const steps = fakes();
    steps.saveDraft.mockResolvedValueOnce({ status: "submitted" });
    expect(await saveTake(fresh, steps)).toEqual({ step: "saved" });
  });

  it("uploads nothing until the privacy notice is accepted", async () => {
    const steps = fakes();
    const notice = { status: "error", code: "notice_required", message: "Read the privacy notice first." } as const;
    steps.prepare.mockResolvedValueOnce(notice);
    expect(await saveTake(fresh, steps)).toEqual({ step: "failed", take: fresh, message: notice.message, updated: false });
    expect(steps.upload).not.toHaveBeenCalled();
    expect(steps.saveDraft).not.toHaveBeenCalled();
  });

  it("asks for a refresh when the app was redeployed since the page loaded", async () => {
    const steps = fakes();
    steps.prepare.mockRejectedValueOnce(new UnrecognizedActionError('Server Action "abc" was not found on the server.'));
    expect(await saveTake(fresh, steps)).toEqual({
      step: "failed",
      take: fresh,
      message: REDEPLOYED_MESSAGE,
      updated: true,
    });
  });

  it("keeps the uploaded path when saveDraft never reaches the server", async () => {
    const steps = fakes();
    steps.saveDraft.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await saveTake(fresh, steps)).toEqual({
      step: "failed",
      take: { ...fresh, uploadedPath: ready(1).path },
      message: OFFLINE_MESSAGE,
      updated: false,
    });
  });

  it("gives up on a prepare that never answers, keeping the take", async () => {
    const steps = fakes();
    steps.prepare.mockReturnValueOnce(hang());
    expect(await saveTake(fresh, { ...steps, timeouts: QUICK })).toEqual({
      step: "failed",
      take: fresh,
      message: TOO_SLOW_MESSAGE,
      updated: false,
    });
    expect(steps.upload).not.toHaveBeenCalled();
  });

  it("gives up on an upload that never finishes, and uploads to a new path on retry", async () => {
    const steps = { ...fakes(), timeouts: QUICK };
    steps.upload.mockReturnValueOnce(hang());
    const outcome = await saveTake(fresh, steps);
    expect(outcome).toEqual({ step: "failed", take: fresh, message: TOO_SLOW_MESSAGE, updated: false });
    if (outcome.step !== "failed") return;
    expect(steps.saveDraft).not.toHaveBeenCalled();

    // The first upload may still land; its path is never saved.
    expect(await saveTake(outcome.take, steps)).toEqual({ step: "saved" });
    expect(steps.upload.mock.calls.map(([target]) => target.path)).toEqual([ready(1).path, ready(2).path]);
    expect(steps.saveDraft.mock.calls.map(([input]) => input.path)).toEqual([ready(2).path]);
  });

  it("gives up on a saveDraft that never answers, and saves the same upload on retry", async () => {
    const steps = { ...fakes(), timeouts: QUICK };
    steps.saveDraft.mockReturnValueOnce(hang());
    const outcome = await saveTake(fresh, steps);
    expect(outcome).toEqual({
      step: "failed",
      take: { ...fresh, uploadedPath: ready(1).path },
      message: TOO_SLOW_MESSAGE,
      updated: false,
    });
    if (outcome.step !== "failed") return;

    expect(await saveTake(outcome.take, steps)).toEqual({ step: "saved" });
    expect(steps.upload).toHaveBeenCalledOnce();
    expect(steps.saveDraft.mock.calls.map(([input]) => input.path)).toEqual([ready(1).path, ready(1).path]);
  });
});

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
