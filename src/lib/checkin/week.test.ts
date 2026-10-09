import { describe, expect, it } from "vitest";
import { currentWeekStart, QUESTIONS } from "./week";

describe("currentWeekStart", () => {
  it("returns the Singapore Monday", () => {
    // Thursday 8 Oct 2026, 15:00 UTC = 23:00 SGT Thursday.
    expect(currentWeekStart(new Date("2026-10-08T15:00:00Z"))).toBe("2026-10-05");
  });

  it("moves to the new week at Monday 00:00 SGT, which is Sunday 16:00 UTC", () => {
    expect(currentWeekStart(new Date("2026-10-11T15:59:59Z"))).toBe("2026-10-05");
    expect(currentWeekStart(new Date("2026-10-11T16:00:00Z"))).toBe("2026-10-12");
  });

  it("keeps Sunday evening SGT in the same week", () => {
    // Sunday 11 Oct 2026, 23:59 SGT.
    expect(currentWeekStart(new Date("2026-10-11T15:59:00Z"))).toBe("2026-10-05");
  });

  it("handles a Monday morning in SGT that is still Sunday in UTC", () => {
    // Monday 12 Oct 2026, 07:59 SGT = Sunday 23:59 UTC.
    expect(currentWeekStart(new Date("2026-10-11T23:59:00Z"))).toBe("2026-10-12");
  });

  it("crosses month and year boundaries", () => {
    expect(currentWeekStart(new Date("2027-01-01T04:00:00Z"))).toBe("2026-12-28");
  });
});

describe("QUESTIONS", () => {
  it("asks activity, excellence, then morale", () => {
    expect(QUESTIONS.map((q) => q.id)).toEqual(["activity", "excellence", "morale"]);
  });
});
