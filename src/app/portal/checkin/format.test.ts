import { describe, expect, it } from "vitest";
import { formatClock, formatDateTime, formatLength, formatWeekEnd, formatWeekStart } from "./format";

describe("check-in formatting", () => {
  it("names a week by its Monday and its closing Sunday", () => {
    expect(formatWeekStart("2026-10-05")).toBe("Monday 5 October");
    expect(formatWeekEnd("2026-10-05")).toBe("Sunday 11 October");
    expect(formatWeekEnd("2026-12-28")).toBe("Sunday 3 January");
  });

  it("refuses something that isn't a date", () => {
    expect(() => formatWeekStart("next week")).toThrow(RangeError);
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
