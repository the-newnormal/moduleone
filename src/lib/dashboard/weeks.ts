// Weeks are Singapore-time weeks starting on Monday, matching the checkins.week_start default.
// Singapore has no daylight saving, so a fixed +08:00 offset is exact.
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// The Monday (YYYY-MM-DD) of the Singapore week that `instant` falls in.
export function weekStartFor(instant: Date): string {
  const sgt = new Date(instant.getTime() + SGT_OFFSET_MS);
  const daysSinceMonday = (sgt.getUTCDay() + 6) % 7;
  const monday = Date.UTC(sgt.getUTCFullYear(), sgt.getUTCMonth(), sgt.getUTCDate() - daysSinceMonday);
  return new Date(monday).toISOString().slice(0, 10);
}

// The last `count` weeks, oldest first, ending with the week `now` falls in.
export function recentWeeks(now: Date, count: number): string[] {
  const latest = Date.parse(`${weekStartFor(now)}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) =>
    new Date(latest - (count - 1 - i) * 7 * DAY_MS).toISOString().slice(0, 10),
  );
}

// True for a real calendar date (YYYY-MM-DD) that is a Monday, in a sane range (Postgres rejects
// year 0000, which JavaScript accepts).
export function isWeekStart(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < 2000 || year > 2100) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value) && date.getUTCDay() === 1;
}

// "5 Oct" for column headers; "5 Oct 2026" when `withYear` is set.
export function formatWeek(week: string, withYear = false): string {
  return new Date(`${week}T00:00:00Z`).toLocaleDateString("en-SG", {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
}

// The dashboard's range presets. Anything else in ?weeks= falls back to the default.
export const WEEK_COUNTS = [4, 8, 12] as const;
export type WeekCount = (typeof WEEK_COUNTS)[number];
export const DEFAULT_WEEK_COUNT: WeekCount = 8;

export function parseWeekCount(raw: string | string[] | undefined): WeekCount {
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  return (WEEK_COUNTS as readonly number[]).includes(value) ? (value as WeekCount) : DEFAULT_WEEK_COUNT;
}
