import type { SaveOutcome } from "./take";

// A take keeps saving after the member leaves the check-in page (see the recorder's unmount
// effect). This module outlives the recorder across in-app navigation, so coming back finds the
// save here and waits for it, instead of offering a new recording that the older save could then
// replace; and Sign out waits for it too. A save that failed stays here, take and all, until a
// recorder shows it (with Try again) or it's discarded; so does one that was superseded (a newer
// take was already the draft), until a recorder has told the member.
let inFlight: Promise<SaveOutcome | null> | null = null;

// What the held save came to, once it has settled (see heldOutcome).
let settled: { save: Promise<SaveOutcome | null>; outcome: SaveOutcome | null } | null = null;

// A save landed in this tab and the portal hasn't looked since (see takeSavedSignal).
let savedUnseen = false;

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

// A take this tab could still save, and would lose if it closed.
function atRisk(outcome: SaveOutcome | null): boolean {
  return outcome?.step === "failed" && !outcome.updated && !wasDeleted(outcome);
}

// What stays here for a recorder to show: a take at risk, or the news that it wasn't kept.
function kept(outcome: SaveOutcome | null): boolean {
  return atRisk(outcome) || outcome?.step === "superseded";
}

function clear() {
  inFlight = null;
  settled = null;
  unsaved = false;
}

export function trackSave<T extends SaveOutcome | null>(save: Promise<T>): Promise<T> {
  inFlight = save;
  settled = null;
  unsaved = true;
  window.addEventListener("beforeunload", warn); // the same function, so adding it again does nothing
  save.then(
    (outcome) => {
      if (outcome?.step === "saved") savedUnseen = true;
      if (inFlight !== save) return;
      settled = { save, outcome };
      if (!kept(outcome)) clear();
      else unsaved = atRisk(outcome);
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

// How the save held now ended: a failed take or the news that one wasn't kept, both waiting for a
// recorder to show them. Undefined while it is still running, or when nothing is held.
export function heldOutcome(): SaveOutcome | null | undefined {
  return inFlight !== null && settled?.save === inFlight ? settled.outcome : undefined;
}

// Whether a save has landed in this tab since the last call; true once per landing. The portal can
// have been rendered before the draft was (the member left the recorder while it saved, and the save
// finished before the portal appeared), so it asks, and refreshes once if it may be out of date.
export function takeSavedSignal(): boolean {
  const landed = savedUnseen;
  savedUnseen = false;
  return landed;
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
