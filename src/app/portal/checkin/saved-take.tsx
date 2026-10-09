"use client";

import { useEffect, useState } from "react";
import { currentSave, forgetSavedTake } from "./pending-save";
import { Recorder } from "./recorder";

// Rendered with the draft (its path) and with the submitted check-in (null). Tells this tab which
// take is safe (see forgetSavedTake). With a draft, a take this tab still holds beyond that one (a
// newer take still saving or failed, or the news that one wasn't kept) is shown here too, so it
// isn't hidden behind the draft: the recorder offers Try again or Discard, or says what happened.
export function SavedTake({ path }: { path: string | null }) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    forgetSavedTake(path);
    const save = path === null ? null : currentSave();
    if (!save) return;
    let mounted = true;
    // After forgetSavedTake's own check of the same save, which was registered first.
    void save.then(() => {
      if (mounted && currentSave() === save) setHeld(true);
    });
    return () => {
      mounted = false;
    };
  }, [path]);
  return held ? <Recorder heldOnly /> : null;
}
