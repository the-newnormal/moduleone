import type { SaveOutcome } from "./take";

// A take keeps saving after the member leaves the check-in page (see the recorder's unmount
// effect). This module outlives the recorder across in-app navigation, so coming back finds the
// save here and waits for it, instead of offering a new recording that the older save could then
// replace; and Sign out waits for it too. A save that failed stays here, take and all, until a
// recorder shows it (with Try again) or it's discarded.
let inFlight: Promise<SaveOutcome | null> | null = null;

// While this tab holds a take that can still be saved (saving, or failed and kept), closing or
// reloading it would lose the take, so the browser asks first. The recorder guards a take it shows
// itself; this covers one saving or kept after the recorder has gone.
let unsaved = false;

// The draft the member just deleted, so a save of that same take that comes back failed (its
// reply was lost after it had saved) isn't offered again.
let deletedPath: string | null = null;

function warn(event: BeforeUnloadEvent) {
  if (unsaved) event.preventDefault();
}

function kept(outcome: SaveOutcome | null): boolean {
  return outcome?.step === "failed" && !outcome.updated && !wasDeleted(outcome);
}

function clear() {
  inFlight = null;
  unsaved = false;
}

export function trackSave<T extends SaveOutcome | null>(save: Promise<T>): Promise<T> {
  inFlight = save;
  unsaved = true;
  window.addEventListener("beforeunload", warn); // the same function, so adding it again does nothing
  save.then(
    (outcome) => {
      if (inFlight === save && !kept(outcome)) clear();
    },
    () => {
      if (inFlight === save) clear();
    },
  );
  return save;
}

export function currentSave(): Promise<SaveOutcome | null> | null {
  return inFlight;
}

// A recorder took this save over (it shows the outcome, and guards a failed take itself), or the
// member discarded the take.
export function releaseSave(save: Promise<SaveOutcome | null> | null = inFlight) {
  if (save !== null && inFlight === save) clear();
}

// Waits for the save in progress, and any that replaced it while waiting. Resolves with what the
// last one left: null or "saved" when nothing is held, a failed take when one is.
export async function pendingSave(): Promise<SaveOutcome | null> {
  for (let held = inFlight; held; held = inFlight) {
    const outcome = await held;
    if (inFlight === held || inFlight === null) return outcome;
  }
  return null;
}

// Called where the page shows that a take is safe: as the draft (its path), or because the week's
// check-in is in (null: nothing held can be saved any more). A save of that take whose reply was
// lost after it had saved is dropped, so neither Sign out nor closing the tab asks about it.
export function forgetSavedTake(path: string | null) {
  const held = inFlight;
  void held?.then((outcome) => {
    if (inFlight !== held) return;
    if (path === null || (outcome?.step === "failed" && outcome.take.uploadedPath === path)) clear();
  });
}

// Called once the member has deleted their draft. A failed save of that same take is dropped.
export function forgetDeletedTake(path: string) {
  deletedPath = path;
  const held = inFlight;
  void held?.then((outcome) => {
    if (inFlight === held && wasDeleted(outcome)) clear();
  });
}

// Whether the outcome is a failed save of the draft the member then deleted. A failure at the
// saveDraft step keeps the uploaded path, so this matches exactly that take.
export function wasDeleted(outcome: SaveOutcome | null): boolean {
  return outcome?.step === "failed" && outcome.take.uploadedPath !== null && outcome.take.uploadedPath === deletedPath;
}
