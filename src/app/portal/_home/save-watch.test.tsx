// @vitest-environment happy-dom
import { act, Suspense, use, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentSave, forgetDeletedTake, releaseSave, trackSave } from "@/app/portal/checkin/pending-save";
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
const settleWith = (save: { resolve: (outcome: SaveOutcome) => void }, outcome: SaveOutcome) =>
  act(async () => {
    save.resolve(outcome);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

// The recorder as the member leaves it for the portal: its unmount effect starts saving the take
// (recorder.tsx), so the save only exists once React runs effect cleanups, in the same commit that
// renders the portal, after SaveWatch has already rendered.
function LeavingRecorder({ save }: { save: Promise<SaveOutcome> }) {
  useEffect(
    () => () => {
      void trackSave(save);
    },
    [save],
  );
  return <p>Recording…</p>;
}

beforeEach(() => {
  router.refresh.mockReset();
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
    expect(alert()).toBeNull();
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

  // Reading the save while rendering would miss it: the recorder's cleanup hasn't run yet then.
  it("watches a save the recorder starts as it unmounts, in the same commit that shows the portal", async () => {
    const save = deferred<SaveOutcome>();
    const page = await render(<LeavingRecorder save={save.promise} />);
    expect(currentSave()).toBeNull();

    await page.rerender(tile); // one commit: the recorder goes, the portal's tile comes
    expect(currentSave()).toBe(save.promise);
    expect(text(status()!)).toContain("Saving your recording…");
    expect(text()).not.toContain("Record this week's check-in");
    expect(text()).not.toContain("Recording…");
    expect(router.refresh).not.toHaveBeenCalled();

    await settleWith(save, { step: "saved" });
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(status()).toBeNull();
    expect(text()).toBe("Record this week's check-in");
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
    expect(alert()).toBeNull();
    expect(text()).toBe("Record this week's check-in");
  });

  // router.refresh() in Next.js updates the router in the transition it's called in, and that
  // transition waits for the server's new page. Here the refresh swaps in a tile that suspends until
  // `arrived` resolves, as the new page would. Called outside a transition, the swap would be urgent:
  // the boundary would fall back to "Loading…" and the old tile would go at once.
  it("keeps saying it's saving until the refreshed page has arrived", async () => {
    const arrived = deferred<void>();
    function RefreshedTile() {
      use(arrived.promise);
      return <p>Your draft is saved</p>;
    }
    const page = { refresh: () => {} };
    function Page() {
      const [refreshed, setRefreshed] = useState(false);
      useEffect(() => {
        page.refresh = () => setRefreshed(true);
      }, []);
      return (
        <Suspense fallback={<p>Loading…</p>}>
          <SaveWatch>{refreshed ? <RefreshedTile /> : <p>Record this week&apos;s check-in</p>}</SaveWatch>
        </Suspense>
      );
    }
    router.refresh.mockImplementation(() => page.refresh());

    const save = saving();
    await render(<Page />);
    await settleWith(save, { step: "saved" });
    expect(router.refresh).toHaveBeenCalledOnce();
    // The refresh is under way: still saying so, never the fallback, never the stale tile.
    expect(text(status()!)).toContain("Saving your recording…");
    expect(text()).not.toContain("Loading…");
    expect(text()).not.toContain("Record this week's check-in");

    await act(async () => {
      arrived.resolve();
    });
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(status()).toBeNull();
    expect(text()).toBe("Your draft is saved");
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

  // The member deleted the draft that save had made before its reply was lost: nothing is at risk.
  it("refreshes rather than offering a retry when the take that failed was the draft since deleted", async () => {
    const deletedTake: Take = { ...take, uploadedPath: "m1/deleted-take.webm" };
    const save = saving();
    await render(tile);
    forgetDeletedTake("m1/deleted-take.webm");
    await settleWith(save, { ...failed, take: deletedTake });
    expect(alert()).toBeNull();
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(text()).toBe("Record this week's check-in");
  });

  // A save kept in this tab from an earlier visit has already ended: the portal mustn't claim it's
  // saving, nor reload the page for it every time the member comes back.
  it("says nothing and doesn't refresh for a take that ended earlier as not kept (superseded)", async () => {
    await trackSave(Promise.resolve<SaveOutcome>({ step: "superseded" }));
    expect(currentSave()).not.toBeNull(); // still held, for the recorder to tell the member
    await render(tile);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(status()).toBeNull();
    expect(alert()).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(text()).toBe("Record this week's check-in");
  });

  it("sends the member straight back to the check-in for a take that failed earlier, without saying it's saving", async () => {
    await trackSave(Promise.resolve(failed));
    await render(tile);
    expect(status()).toBeNull();
    expect(text(alert()!)).toBe("Your last recording hasn't been saved yet.");
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("doesn't refresh a page the member has already left", async () => {
    const save = saving();
    const page = await render(tile);
    await page.rerender(null);
    await settleWith(save, { step: "saved" });
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
