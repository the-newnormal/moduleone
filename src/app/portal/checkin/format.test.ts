import { describe, expect, it } from "vitest";
import {
  formatClock,
  formatDateTime,
  formatDay,
  formatDayMonth,
  formatLength,
  formatLongDate,
  formatWeekEnd,
  formatWeekStart,
} from "./format";

describe("check-in formatting", () => {
  it("names a week by its Monday and its closing Sunday", () => {
    expect(formatWeekStart("2026-10-05")).toBe("Monday 5 October");
    expect(formatWeekEnd("2026-10-05")).toBe("Sunday 11 October");
    expect(formatWeekEnd("2026-12-28")).toBe("Sunday 3 January");
  });

  it("refuses something that isn't a date", () => {
    expect(() => formatWeekStart("next week")).toThrow(RangeError);
    expect(() => formatDayMonth("next week")).toThrow(RangeError);
    expect(() => formatLongDate("2026-10-08T00:00:00Z")).toThrow(RangeError);
    expect(() => formatDay("next week")).toThrow(RangeError);
  });

  it("names a day by its date and month, and with the year when it can be in another year", () => {
    expect(formatDayMonth("2026-09-28")).toBe("28 September");
    expect(formatDayMonth("2026-01-05")).toBe("5 January");
    expect(formatLongDate("2027-10-08")).toBe("8 October 2027");
    expect(formatLongDate("2026-09-28")).toBe("28 September 2026");
    expect(formatLongDate("2026-01-05")).toBe("5 January 2026");
  });

  it("names the Singapore day of a timestamp, with the year only when asked, and no comma", () => {
    expect(formatDay("2026-10-01T03:00:00Z")).toBe("Thursday 1 October");
    expect(formatDay("2026-10-01T03:00:00Z", true)).toBe("Thursday 1 October 2026");
    // 31 December in UTC, already 1 January in Singapore.
    expect(formatDay("2025-12-31T16:30:00Z", true)).toBe("Thursday 1 January 2026");
    expect(formatDay("2026-01-02T03:00:00Z", true)).toBe("Friday 2 January 2026");
  });

  it("shows times in Singapore time, whatever the server's time zone", () => {
    expect(formatDateTime("2026-10-09T06:15:00Z")).toBe("Friday 9 October at 2:15 pm");
    expect(formatDateTime("2026-10-11T15:59:00Z")).toBe("Sunday 11 October at 11:59 pm");
  });

  it.each([
    [0, "0 s"],
    [45_400, "45 s"],
    [60_000, "1 min"],
    [192_000, "3 min 12 s"],
    [-5, "0 s"],
  ])("shows a length of %s ms as %s", (ms, text) => {
    expect(formatLength(ms)).toBe(text);
  });

  it.each([
    [0, "0:00"],
    [7_900, "0:07"],
    [245_000, "4:05"],
    [600_000, "10:00"],
  ])("shows the clock at %s ms as %s", (ms, text) => {
    expect(formatClock(ms)).toBe(text);
  });
});
