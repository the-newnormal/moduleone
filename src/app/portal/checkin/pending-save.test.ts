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
