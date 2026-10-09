import { describe, expect, it } from "vitest";
import {
  formatWeek,
  isWeekStart,
  parseWeek,
  parseWeekCount,
  recentWeeks,
  shiftWeek,
  weekStartFor,
  weeksEndingAt,
} from "./weeks";

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
  it("is just this week for a one-week view", () => {
    expect(recentWeeks(new Date("2026-10-08T13:00:00Z"), 1)).toEqual(["2026-10-05"]);
  });

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
    ["0000-01-03", false], // a Monday in JavaScript, an error in Postgres
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
    ["1", 1],
    ["4", 4],
    ["12", 12],
    [["12", "4"], 12],
    ["5", 8],
    ["0", 8],
    ["100000", 8],
    ["abc", 8],
  ] as const)("%s → %s", (raw, expected) => {
    expect(parseWeekCount(raw as string | string[] | undefined)).toBe(expected);
  });
});

describe("shiftWeek and weeksEndingAt", () => {
  it("steps whole weeks, across months and years", () => {
    expect(shiftWeek("2026-10-05", -1)).toBe("2026-09-28");
    expect(shiftWeek("2025-12-29", 1)).toBe("2026-01-05");
    expect(shiftWeek("2026-10-05", 0)).toBe("2026-10-05");
  });

  it("lists the weeks ending with the given one, oldest first", () => {
    expect(weeksEndingAt("2026-10-05", 3)).toEqual(["2026-09-21", "2026-09-28", "2026-10-05"]);
    expect(weeksEndingAt("2026-10-05", 1)).toEqual(["2026-10-05"]);
  });
});

describe("parseWeek", () => {
  const latest = "2026-10-05";

  it("takes a Monday up to the latest week", () => {
    expect(parseWeek("2026-09-28", latest)).toBe("2026-09-28");
    expect(parseWeek("2026-10-05", latest)).toBe("2026-10-05");
    expect(parseWeek(["2026-09-21", "2026-09-28"], latest)).toBe("2026-09-21");
  });

  it("falls back to the latest week for anything else, the future included", () => {
    for (const raw of [undefined, "", "2026-10-12", "2026-09-29", "soon", "2026-02-30"]) {
      expect(parseWeek(raw, latest)).toBe(latest);
    }
  });
});
