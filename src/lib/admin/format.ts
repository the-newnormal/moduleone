// Dates on the admin pages ("last changed by X on Y", "Login given by X on Y"). They're rendered on
// the server, whose clock runs in UTC, so name the zone: The Normal works in Singapore time.
export const APP_TIME_ZONE = "Asia/Singapore";

const DATE = new Intl.DateTimeFormat("en-SG", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: APP_TIME_ZONE,
});

const DATE_TIME = new Intl.DateTimeFormat("en-SG", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: APP_TIME_ZONE,
});

// "8 Oct 2026". Null for a missing or unreadable timestamp.
export function formatDate(iso: string | null | undefined): string | null {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime()) ? DATE.format(date) : null;
}

// "8 Oct 2026, 3:04 pm". Null for a missing or unreadable timestamp.
export function formatDateTime(iso: string | null | undefined): string | null {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime()) ? DATE_TIME.format(date) : null;
}
