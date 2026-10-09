import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveOutcome, Take } from "./take";

// The module keeps its state for the life of the page, so each test loads a fresh copy.
async function load() {
  vi.resetModules();
  return import("./pending-save");
}

const take: Take = {
  blob: new Blob([new Uint8Array([1])], { type: "audio/webm" }),
  mimeType: "audio/webm",
  durationMs: 1000,
  recordedAt: 1,
  recordedAtMono: 0,
  serverRecordedAt: null,
  uploadedPath: "member/2026-10-05-a.webm",
};
const saved: SaveOutcome = { step: "saved" };
const failed: SaveOutcome = { step: "failed", take, message: "Try again.", updated: false };
const redeployed: SaveOutcome = { ...failed, updated: true };

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Whether closing or reloading the tab now would ask first.
function asksBeforeLeaving(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("trackSave", () => {
  it("asks before the tab closes while a save is running, and not once it has saved", async () => {
    const { trackSave, currentSave } = await load();
    const save = deferred<SaveOutcome>();
    void trackSave(save.promise);
    expect(currentSave()).toBe(save.promise);
    expect(asksBeforeLeaving()).toBe(true);

    save.resolve(saved);
    await save.promise;
    expect(currentSave()).toBeNull();
    expect(asksBeforeLeaving()).toBe(false);
  });

  it("keeps a failed take, and keeps asking, until a recorder takes it over", async () => {
    const { trackSave, currentSave, releaseSave } = await load();
    const save = Promise.resolve(failed);
    await trackSave(save);
    expect(currentSave()).toBe(save);
    expect(asksBeforeLeaving()).toBe(true);

    releaseSave(save);
    expect(currentSave()).toBeNull();
    expect(asksBeforeLeaving()).toBe(false);
  });

  it("doesn't ask for a take that can't be saved from this page (the app was updated)", async () => {
    const { trackSave, currentSave } = await load();
    await trackSave(Promise.resolve(redeployed));
    expect(currentSave()).toBeNull();
    expect(asksBeforeLeaving()).toBe(false);
  });

  it("leaves a newer save in place when an older one settles", async () => {
    const { trackSave, currentSave, releaseSave } = await load();
    const older = deferred<SaveOutcome>();
    void trackSave(older.promise);
    const newer = deferred<SaveOutcome>();
    void trackSave(newer.promise);

    older.resolve(saved);
    await older.promise;
    releaseSave(older.promise);
    expect(currentSave()).toBe(newer.promise);
    expect(asksBeforeLeaving()).toBe(true);
  });
});

describe("a superseded save", () => {
  it("is kept for a recorder to tell the member, without asking before the tab closes", async () => {
    const { trackSave, currentSave } = await load();
    const save = Promise.resolve<SaveOutcome>({ step: "superseded" });
    await trackSave(save);
    await Promise.resolve();
    expect(currentSave()).toBe(save);
    expect(asksBeforeLeaving()).toBe(false);
  });

  it("is dropped once the week's check-in is in", async () => {
    const { trackSave, currentSave, forgetSavedTake } = await load();
    const save = Promise.resolve<SaveOutcome>({ step: "superseded" });
    await trackSave(save);
    forgetSavedTake(null);
    await save;
    await Promise.resolve();
    expect(currentSave()).toBeNull();
  });
});

describe("heldOutcome", () => {
  it("is undefined while the save runs and when nothing is held", async () => {
    const { trackSave, heldOutcome } = await load();
    expect(heldOutcome()).toBeUndefined();
    const save = deferred<SaveOutcome>();
    void trackSave(save.promise);
    expect(heldOutcome()).toBeUndefined();
    save.resolve(saved);
    await save.promise;
    // Saved: nothing is held any more.
    expect(heldOutcome()).toBeUndefined();
  });

  it("is what a kept save came to: a failed take, or the news that it wasn't kept", async () => {
    const { trackSave, heldOutcome } = await load();
    await trackSave(Promise.resolve(failed));
    expect(heldOutcome()).toEqual(failed);
    await trackSave(Promise.resolve<SaveOutcome>({ step: "superseded" }));
    expect(heldOutcome()).toEqual({ step: "superseded" });
  });

  it("is undefined again for a newer save still running, and once a recorder takes the old one over", async () => {
    const { trackSave, heldOutcome, releaseSave } = await load();
    await trackSave(Promise.resolve(failed));
    const newer = deferred<SaveOutcome>();
    void trackSave(newer.promise);
    expect(heldOutcome()).toBeUndefined();
    newer.resolve(failed);
    await newer.promise;
    expect(heldOutcome()).toEqual(failed);
    releaseSave();
    expect(heldOutcome()).toBeUndefined();
  });
});

describe("takeSavedSignal", () => {
  it("says once that a save landed, and nothing for one that failed or wasn't kept", async () => {
    const { trackSave, takeSavedSignal } = await load();
    expect(takeSavedSignal()).toBe(false);
    await trackSave(Promise.resolve(failed));
    await trackSave(Promise.resolve<SaveOutcome>({ step: "superseded" }));
    expect(takeSavedSignal()).toBe(false);
    await trackSave(Promise.resolve(saved));
    expect(takeSavedSignal()).toBe(true);
    expect(takeSavedSignal()).toBe(false);
  });

  it("counts an older save that landed after a newer one replaced it", async () => {
    const { trackSave, takeSavedSignal } = await load();
    const older = deferred<SaveOutcome>();
    void trackSave(older.promise);
    void trackSave(deferred<SaveOutcome>().promise);
    older.resolve(saved);
    await older.promise;
    expect(takeSavedSignal()).toBe(true);
  });
});

describe("pendingSave", () => {
  it("is null when nothing is saving", async () => {
    const { pendingSave } = await load();
    expect(await pendingSave()).toBeNull();
  });

  it("waits for the save, and for any save that replaced it meanwhile", async () => {
    const { trackSave, pendingSave } = await load();
    const first = deferred<SaveOutcome>();
    void trackSave(first.promise);
    const waiting = pendingSave();

    const second = deferred<SaveOutcome>();
    void trackSave(second.promise);
    first.resolve(saved);
    let done = false;
    void waiting.then(() => {
      done = true;
    });
    await first.promise;
    await Promise.resolve();
    expect(done).toBe(false);

    second.resolve(failed);
    expect(await waiting).toBe(failed);
  });
});

describe("forgetSavedTake", () => {
  it("drops a failed save of the take the page shows as the draft (its reply was lost)", async () => {
    const { trackSave, currentSave, forgetSavedTake } = await load();
    const save = Promise.resolve(failed);
    await trackSave(save);
    forgetSavedTake(take.uploadedPath);
    await save;
    await Promise.resolve();
    expect(currentSave()).toBeNull();
    expect(asksBeforeLeaving()).toBe(false);
  });

  it("keeps a failed save of a take other than the draft", async () => {
    const { trackSave, currentSave, forgetSavedTake } = await load();
    const save = Promise.resolve(failed);
    await trackSave(save);
    forgetSavedTake("member/2026-10-05-other.webm");
    await save;
    await Promise.resolve();
    expect(currentSave()).toBe(save);
  });

  it("drops any held save once the week's check-in is in", async () => {
    const { trackSave, currentSave, forgetSavedTake } = await load();
    const save = Promise.resolve<SaveOutcome>({ ...failed, take: { ...take, uploadedPath: null } });
    await trackSave(save);
    forgetSavedTake(null);
    await save;
    await Promise.resolve();
    expect(currentSave()).toBeNull();
  });
});

describe("forgetDeletedTake", () => {
  it("drops a failed save of the draft the member deleted", async () => {
    const { trackSave, currentSave, forgetDeletedTake, wasDeleted } = await load();
    const save = Promise.resolve(failed);
    await trackSave(save);
    forgetDeletedTake(take.uploadedPath as string);
    await save;
    await Promise.resolve();
    expect(wasDeleted(failed)).toBe(true);
    expect(currentSave()).toBeNull();
    expect(asksBeforeLeaving()).toBe(false);
  });

  it("keeps a failed save of any other take", async () => {
    const { trackSave, currentSave, forgetDeletedTake, wasDeleted } = await load();
    const other: SaveOutcome = { ...failed, take: { ...take, uploadedPath: "member/2026-10-05-b.webm" } };
    const save = Promise.resolve(other);
    await trackSave(save);
    forgetDeletedTake(take.uploadedPath as string);
    await save;
    await Promise.resolve();
    expect(wasDeleted(other)).toBe(false);
    expect(currentSave()).toBe(save);
  });

  it("never matches a take that was never uploaded", async () => {
    const { forgetDeletedTake, wasDeleted } = await load();
    forgetDeletedTake(take.uploadedPath as string);
    expect(wasDeleted({ ...failed, take: { ...take, uploadedPath: null } })).toBe(false);
  });
});

// Sign out sits beside the recorder in the app bar, so it finishes a recording still going first.
describe("finishRecording", () => {
  it("does nothing when nothing is recording", async () => {
    const { finishRecording, currentSave } = await load();
    finishRecording();
    expect(currentSave()).toBeNull();
  });

  it("finishes the recording held, once, and its save is then the one in progress", async () => {
    const { holdRecording, finishRecording, trackSave, currentSave } = await load();
    const save = deferred<SaveOutcome | null>();
    const finish = vi.fn(() => void trackSave(save.promise));
    holdRecording(finish);
    finishRecording();
    finishRecording();
    expect(finish).toHaveBeenCalledTimes(1);
    expect(currentSave()).toBe(save.promise);
  });

  it("leaves a recording that ended by itself alone, and a newer one held", async () => {
    const { holdRecording, finishRecording } = await load();
    const first = vi.fn();
    const second = vi.fn();
    const releaseFirst = holdRecording(first);
    releaseFirst();
    finishRecording();
    expect(first).not.toHaveBeenCalled();
    holdRecording(first);
    holdRecording(second); // a new recording replaced it
    releaseFirst(); // the old one's release can't drop the new one
    finishRecording();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("failedTakeShown", () => {
  it("is true while any recorder shows a failed take, and each release counts once", async () => {
    const { holdFailedTake, failedTakeShown } = await load();
    expect(failedTakeShown()).toBe(false);
    const first = holdFailedTake();
    const second = holdFailedTake();
    first();
    first(); // releasing twice doesn't drop the other's hold
    expect(failedTakeShown()).toBe(true);
    second();
    expect(failedTakeShown()).toBe(false);
  });
});
