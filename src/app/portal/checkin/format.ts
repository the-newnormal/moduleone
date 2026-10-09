// How the check-in page shows dates and lengths. Everything is in Singapore time, whatever the
// server's or the browser's time zone, because that is when the week opens and closes.

const DAY = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Singapore",
  weekday: "long",
  day: "numeric",
  month: "long",
});

const DAY_AND_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Singapore",
  weekday: "long",
  day: "numeric",
  month: "long",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const DAY_MS = 24 * 60 * 60 * 1000;

// A week's Monday ('2026-10-05') → 'Monday 5 October'.
export function formatWeekStart(weekStart: string): string {
  return DAY.format(sgtMidnight(weekStart));
}

// A week's Monday ('2026-10-05') → its Sunday, 'Sunday 11 October', when the window closes.
export function formatWeekEnd(weekStart: string): string {
  return DAY.format(new Date(sgtMidnight(weekStart).getTime() + 6 * DAY_MS));
}

// A timestamp → 'Friday 9 October at 2:15 pm' (Singapore time).
export function formatDateTime(iso: string): string {
  return DAY_AND_TIME.format(new Date(iso));
}

// A recording's length → '45 s', '3 min 12 s' or '10 min'.
export function formatLength(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds} s`;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

// The recorder's running clock → '0:07', '4:05', '10:00'.
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function sgtMidnight(weekStart: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw new RangeError(`Not a date: ${weekStart}`);
  return new Date(`${weekStart}T00:00:00+08:00`);
}
