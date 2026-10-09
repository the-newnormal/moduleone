// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseSave, trackSave } from "@/app/portal/checkin/pending-save";
import type { SaveOutcome, Take } from "@/app/portal/checkin/take";
import { deferred, render, text } from "@/test/dom";
import { SaveWatch } from "./save-watch";

// Coming back to the portal from the recorder can beat the take's upload, so the check-in tile
// would read "Not started" for a take that is still saving. SaveWatch holds the tile until the save
// settles, then refreshes the page so the tile reads the draft the save left.

// One router for the page, as Next.js gives it: the effect depends on it, so a new one on each
// render would watch the save again.
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const take: Take = {
  blob: new Blob([new Uint8Array([1])], { type: "audio/webm" }),
  mimeType: "audio/webm",
  durationMs: 1000,
  recordedAt: 1,
  recordedAtMono: 0,
  serverRecordedAt: null,
  uploadedPath: null,
};
const failed: SaveOutcome = { step: "failed", take, message: "Try again.", updated: false };

const tile = (
  <SaveWatch>
    <p>Record this week&apos;s check-in</p>
  </SaveWatch>
);
const status = () => document.querySelector('[role="status"]');
const alert = () => document.querySelector('[role="alert"]');
const links = () => [...document.querySelectorAll("a")].map((a) => ({ text: text(a), href: a.getAttribute("href") }));

// A save the recorder left running when the member came back here: tracked before the portal renders.
function saving() {
  const save = deferred<SaveOutcome>();
  void trackSave(save.promise);
  return save;
}

// Settles the save and lets everything waiting on it run (pendingSave, then the tile's re-render).
const settleWith = (save: ReturnType<typeof saving>, outcome: SaveOutcome) =>
  act(async () => {
    save.resolve(outcome);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

beforeEach(() => {
  router.refresh.mockClear();
});

// The save module lives as long as the tab; let go of whatever a test left held.
afterEach(() => {
  releaseSave();
});

describe("SaveWatch", () => {
  it("shows the tile as it is when nothing is saving", async () => {
    await render(tile);
    expect(text()).toBe("Record this week's check-in");
    expect(status()).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("says the recording is saving instead of offering a new one", async () => {
    saving();
    await render(tile);
    expect(text(status()!)).toContain("Saving your recording…");
    expect(text()).not.toContain("Record this week's check-in");
    expect(links()).toEqual([{ text: "Open your check-in", href: "/portal/checkin" }]);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it.each<[string, SaveOutcome]>([
    ["saved", { step: "saved" }],
    // A newer take is already the draft; the page shows that one.
    ["superseded", { step: "superseded" }],
    // The app was updated, so no retry from here can work; the page shows what is saved.
    ["failed after an update", { ...failed, updated: true }],
  ])("refreshes the page once the save has %s", async (_, outcome) => {
    const save = saving();
    await render(tile);
    await settleWith(save, outcome);
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(status()).toBeNull();
    expect(text()).toBe("Record this week's check-in");
  });

  it("sends the member back to the check-in when the take failed to save, without refreshing", async () => {
    const save = saving();
    await render(tile);
    await settleWith(save, failed);
    expect(router.refresh).not.toHaveBeenCalled();
    expect(status()).toBeNull();
    expect(text(alert()!)).toBe("Your last recording hasn't been saved yet.");
    expect(links()).toEqual([{ text: "Open your check-in to try again", href: "/portal/checkin" }]);
    expect(text()).not.toContain("Record this week's check-in");
  });

  it("doesn't refresh a page the member has already left", async () => {
    const save = saving();
    const page = await render(tile);
    await page.rerender(null);
    await settleWith(save, { step: "saved" });
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
