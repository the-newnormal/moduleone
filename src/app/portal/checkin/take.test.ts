import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  recordedAt: Date.parse("2026-10-08T03:30:00Z"),
  recordedAtMono: -5 * 60 * 1000, // the steady clock starts at 0 when the tests fake it, 5 minutes later
  serverRecordedAt: null,
  uploadedPath: `${MEMBER}/2026-10-05-take.webm`,
};

// The server's clock is an hour ahead of this browser's.
const HOUR = 60 * 60 * 1000;
function stamp(t: Take): Take {
  return { ...t, serverRecordedAt: t.recordedAt + HOUR };
}
// Five minutes after the take was recorded. Only the clocks are faked (setSystemTime moves Date, not
// the steady clock); the timeout tests need real timers.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance"], now: new Date("2026-10-08T03:35:00Z") });
});
afterEach(() => {
  vi.useRealTimers();
});

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
const QUICK = { clockMs: 10, prepareMs: 10, uploadMs: 10, saveMs: 10 };

// A server and a Storage that accept everything; each test makes one step go wrong.
function fakes() {
  let prepared = 0;
  return {
    prepare: vi.fn<SaveSteps["prepare"]>(async () => ready(++prepared)),
    upload: vi.fn<SaveSteps["upload"]>(async () => ({ error: null })),
    saveDraft: vi.fn<SaveSteps["saveDraft"]>(async () => ({ status: "saved" })),
    serverNow: vi.fn<SaveSteps["serverNow"]>(async () => Date.now() + HOUR),
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
    expect(steps.saveDraft).toHaveBeenCalledWith({
      path: ready(1).path,
      durationMs: 95_000,
      recordedAt: take.recordedAt + HOUR,
    });
  });

  it("keeps the recording, with nothing uploaded, when the upload fails", async () => {
    const steps = fakes();
    steps.upload.mockResolvedValueOnce({ error: new Error("Network request failed") });
    const outcome = await saveTake(fresh, steps);
    expect(outcome).toEqual({ step: "failed", take: stamp(fresh), message: UPLOAD_FAILED_MESSAGE, updated: false });
    if (outcome.step === "failed") expect(outcome.take.blob).toBe(take.blob);
    expect(steps.saveDraft).not.toHaveBeenCalled();
  });

  it("keeps the uploaded path when saveDraft fails on our side, so Try again doesn't upload again", async () => {
    const steps = fakes();
    steps.saveDraft.mockResolvedValueOnce({ status: "error", code: "failed", message: "Something went wrong." });
    const outcome = await saveTake(fresh, steps);
    expect(outcome).toEqual({
      step: "failed",
      take: { ...stamp(fresh), uploadedPath: ready(1).path },
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
    expect(outcome).toEqual({ step: "failed", take: stamp(fresh), message: "Try again.", updated: false });
    if (outcome.step !== "failed") return;

    expect(await saveTake(outcome.take, steps)).toEqual({ step: "saved" });
    expect(steps.upload.mock.calls.map(([target]) => target.path)).toEqual([ready(1).path, ready(2).path]);
    expect(steps.saveDraft).toHaveBeenLastCalledWith({
      path: ready(2).path,
      durationMs: 95_000,
      recordedAt: take.recordedAt + HOUR,
    });
  });

  it("uploads a kept take again by itself when its earlier upload is too old to save", async () => {
    const steps = fakes();
    steps.saveDraft.mockResolvedValueOnce({ status: "error", code: "upload_expired", message: "Too old." });
    expect(await saveTake(take, steps)).toEqual({ step: "saved" });
    expect(steps.upload.mock.calls.map(([target]) => target.path)).toEqual([ready(1).path]);
    expect(steps.saveDraft.mock.calls.map(([input]) => input.path)).toEqual([take.uploadedPath, ready(1).path]);
  });

  it("doesn't upload again by itself when a fresh upload is already too old", async () => {
    const steps = fakes();
    steps.saveDraft.mockResolvedValueOnce({ status: "error", code: "upload_expired", message: "Too old." });
    expect(await saveTake(fresh, steps)).toEqual({
      step: "failed",
      take: stamp(fresh),
      message: "Too old.",
      updated: false,
    });
    expect(steps.upload).toHaveBeenCalledOnce();
  });

  it("stamps the take with the server's clock once, and keeps it for retries", async () => {
    const steps = fakes();
    steps.upload.mockResolvedValueOnce({ error: new Error("Network request failed") });
    const outcome = await saveTake(fresh, steps);
    if (outcome.step !== "failed") throw new Error("expected a failed save");
    expect(outcome.take.serverRecordedAt).toBe(fresh.recordedAt + HOUR);

    // Later the server's clock reads differently (or the save waits in a queue): the stamp stays.
    steps.serverNow.mockResolvedValue(Date.now() + 5 * HOUR);
    expect(await saveTake(outcome.take, steps)).toEqual({ step: "saved" });
    expect(steps.serverNow).toHaveBeenCalledOnce();
    expect(steps.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ recordedAt: fresh.recordedAt + HOUR }));
  });

  it("allows for the clock request's round trip", async () => {
    const steps = fakes();
    // The answer comes back 2 seconds after the request: the server read its clock halfway.
    steps.serverNow.mockImplementationOnce(async () => {
      const server = Date.now() + 1000 + HOUR;
      vi.setSystemTime(Date.now() + 2000);
      return server;
    });
    await saveTake(fresh, steps);
    expect(steps.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ recordedAt: fresh.recordedAt + HOUR }));
  });

  it("doesn't make a take look newer when this browser's clock is turned back during the request", async () => {
    const steps = fakes();
    steps.serverNow.mockImplementationOnce(async () => {
      const server = Date.now() + HOUR;
      vi.setSystemTime(Date.now() - HOUR);
      return server;
    });
    await saveTake(fresh, steps);
    expect(steps.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ recordedAt: fresh.recordedAt + HOUR }));
  });

  it("counts a sleep before the first save, which the steady clock misses", async () => {
    const steps = fakes();
    vi.setSystemTime(Date.now() + 2 * HOUR);
    await saveTake(fresh, steps);
    expect(steps.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ recordedAt: fresh.recordedAt + HOUR }));
  });

  it("sends no recording time when the server's clock can't be read", async () => {
    const steps = fakes();
    steps.serverNow.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await saveTake(fresh, steps)).toEqual({ step: "saved" });
    expect(steps.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ recordedAt: null }));
  });

  it("doesn't wait long for the server's clock", async () => {
    const steps = { ...fakes(), timeouts: QUICK };
    steps.serverNow.mockReturnValueOnce(hang());
    expect(await saveTake(fresh, steps)).toEqual({ step: "saved" });
    expect(steps.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ recordedAt: null }));
  });

  it("is done when a take recorded later is already the draft", async () => {
    const steps = fakes();
    steps.saveDraft.mockResolvedValueOnce({ status: "superseded" });
    expect(await saveTake(take, steps)).toEqual({ step: "saved" });
    expect(steps.saveDraft).toHaveBeenCalledOnce();
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
    expect(await saveTake(fresh, steps)).toEqual({
      step: "failed",
      take: stamp(fresh),
      message: notice.message,
      updated: false,
    });
    expect(steps.upload).not.toHaveBeenCalled();
    expect(steps.saveDraft).not.toHaveBeenCalled();
  });

  it("asks for a refresh when the app was redeployed since the page loaded", async () => {
    const steps = fakes();
    steps.prepare.mockRejectedValueOnce(new UnrecognizedActionError('Server Action "abc" was not found on the server.'));
    expect(await saveTake(fresh, steps)).toEqual({
      step: "failed",
      take: stamp(fresh),
      message: REDEPLOYED_MESSAGE,
      updated: true,
    });
  });

  it("keeps the uploaded path when saveDraft never reaches the server", async () => {
    const steps = fakes();
    steps.saveDraft.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await saveTake(fresh, steps)).toEqual({
      step: "failed",
      take: { ...stamp(fresh), uploadedPath: ready(1).path },
      message: OFFLINE_MESSAGE,
      updated: false,
    });
  });

  it("gives up on a prepare that never answers, keeping the take", async () => {
    const steps = fakes();
    steps.prepare.mockReturnValueOnce(hang());
    expect(await saveTake(fresh, { ...steps, timeouts: QUICK })).toEqual({
      step: "failed",
      take: stamp(fresh),
      message: TOO_SLOW_MESSAGE,
      updated: false,
    });
    expect(steps.upload).not.toHaveBeenCalled();
  });

  it("gives up on an upload that never finishes, and uploads to a new path on retry", async () => {
    const steps = { ...fakes(), timeouts: QUICK };
    steps.upload.mockReturnValueOnce(hang());
    const outcome = await saveTake(fresh, steps);
    expect(outcome).toEqual({ step: "failed", take: stamp(fresh), message: TOO_SLOW_MESSAGE, updated: false });
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
      take: { ...stamp(fresh), uploadedPath: ready(1).path },
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
