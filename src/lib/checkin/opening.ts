import { coachRubric } from "@/lib/coach/rubric";
import { RubricError } from "@/lib/rubrics/markdown";
import { liveCheckinEnabled } from "./live-config";
import { DEFAULT_OPENING_QUESTION } from "./week";

// The one open question a check-in asks (rubrics/coach.md's opening question), and whether the live
// coach follows it up with questions while the member talks (LIVE_CHECKIN). A broken rubric means the
// built-in opening question and no follow-ups, rather than coaching with half a rubric; its test
// catches that on every pull request.
export function checkinQuestion(): { opening: string; live: boolean } {
  try {
    return { opening: coachRubric().opening, live: liveCheckinEnabled() };
  } catch (error) {
    if (error instanceof RubricError) return { opening: DEFAULT_OPENING_QUESTION, live: false };
    throw error;
  }
}
