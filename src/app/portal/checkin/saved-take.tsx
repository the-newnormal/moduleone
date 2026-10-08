"use client";

import { useEffect } from "react";
import { forgetSavedTake } from "./pending-save";

// Tells this tab that a take is safe (see forgetSavedTake): rendered with the draft (its path) and
// with the submitted check-in (null).
export function SavedTake({ path }: { path: string | null }) {
  useEffect(() => forgetSavedTake(path), [path]);
  return null;
}
