import { describe, expect, it } from "vitest";
import { formatWeek, isWeekStart, parseWeekCount, recentWeeks, weekStartFor } from "./weeks";

describe("weekStartFor", () => {
  it("returns the Monday of the Singapore week", () => {
    expect(weekStartFor(new Date("2026-10-08T13:00:00Z"))).toBe("2026-10-05"); // Thu 21:00 SGT
    expect(weekStartFor(new Date("2026-10-05T00:00:00+08:00"))).toBe("2026-10-05"); // Mon 00:00 SGT
    expect(weekStartFor(new Date("2026-10-11T23:59:59+08:00"))).toBe("2026-10-05"); // Sun 23:59 SGT
  });

  it("uses Singapore time, not UTC, near midnight on Monday", () => {
    // Monday 07:30 in Singapore is still Sunday in UTC.
    expect(weekStartFor(new Date("2026-10-11T23:30:00Z"))).toBe("2026-10-12");
  });

  it("crosses month and year boundaries", () => {
    expect(weekStartFor(new Date("2026-01-01T12:00:00+08:00"))).toBe("2025-12-29");
  });
});

describe("recentWeeks", () => {
  it("lists the weeks oldest first, ending with this week", () => {
    expect(recentWeeks(new Date("2026-10-08T13:00:00Z"), 4)).toEqual([
      "2026-09-14",
      "2026-09-21",
      "2026-09-28",
      "2026-10-05",
    ]);
  });
});

describe("isWeekStart", () => {
  it.each([
    ["2026-10-05", true],
    ["2026-10-06", false], // a Tuesday
    ["2026-02-30", false], // not a real date
    ["2026-10-5", false],
    ["2026-10-05'; drop table", false],
    ["", false],
  ])("%s → %s", (value, expected) => {
    expect(isWeekStart(value)).toBe(expected);
  });
});

describe("formatWeek", () => {
  it("formats a week for headers", () => {
    expect(formatWeek("2026-10-05")).toBe("5 Oct");
    expect(formatWeek("2026-10-05", true)).toBe("5 Oct 2026");
  });
});

describe("parseWeekCount", () => {
  it.each([
    [undefined, 8],
    ["4", 4],
    ["12", 12],
    [["12", "4"], 12],
    ["5", 8],
    ["100000", 8],
    ["abc", 8],
  ] as const)("%s → %s", (raw, expected) => {
    expect(parseWeekCount(raw as string | string[] | undefined)).toBe(expected);
  });
});
