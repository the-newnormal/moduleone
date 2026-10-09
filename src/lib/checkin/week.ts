// The team works in Singapore time (UTC+8, no daylight saving). A check-in week runs Monday 00:00
// to Sunday 23:59 SGT and is named by its Monday, the same way the database default for
// checkins.week_start and checkin_drafts.week_start works it out (0002, 0004).
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Monday of the current Singapore week, as YYYY-MM-DD.
export function currentWeekStart(now: Date = new Date()): string {
  // Shift to Singapore wall-clock time, then read it back with the UTC getters.
  const sgt = new Date(now.getTime() + SGT_OFFSET_MS);
  const daysSinceMonday = (sgt.getUTCDay() + 6) % 7; // getUTCDay: Sunday 0 … Saturday 6
  const monday = new Date(sgt.getTime() - daysSinceMonday * DAY_MS);
  return monday.toISOString().slice(0, 10);
}

// The three questions, in the order the recorder shows them.
export const QUESTIONS = [
  { id: "activity", text: "What have you done this week?" },
  { id: "excellence", text: "Where did you / your team use your superpower?" },
  { id: "morale", text: "How are you feeling about the team?" },
] as const;

export type QuestionId = (typeof QUESTIONS)[number]["id"];
