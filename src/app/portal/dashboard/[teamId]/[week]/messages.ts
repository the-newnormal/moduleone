// What the Master Admin's delete and reset actions (./actions.ts) say when the database refuses.
// Kept here because a "use server" file may only export async functions.

export const CHECKIN_GONE = "That check-in has already been reset. Reload the page.";
export const NOT_GRADED =
  "This check-in hasn't been graded yet, and the grader needs its recording. Reset the check-in instead, or try again once it's graded.";
