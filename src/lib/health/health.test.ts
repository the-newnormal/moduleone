import { describe, expect, it } from "vitest";
import {
  type HealthConfig,
  type ScoringSettingsRow,
  healthBand,
  healthConfigProblems,
  healthScore,
  settingsToConfig,
  teamWeekHealth,
} from "./health";

// The defaults the 0002 migration installs in scoring_settings: activity × excellence × a morale
// multiplier, green ≥ 12, yellow ≥ 6.
const RULES: HealthConfig = Object.freeze({
  activity: Object.freeze({ 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 }),
  excellence: Object.freeze({ 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 }),
  morale: Object.freeze({ 1: 0.6, 2: 0.8, 3: 1.0, 4: 1.1, 5: 1.2 }),
  thresholds: Object.freeze({ green: 12, yellow: 6 }),
});

const graded = (activity: number, excellence: number, morale: number) => ({
  activity_score: activity,
  excellence_score: excellence,
  morale_score: morale,
});
const ungraded = { activity_score: null, excellence_score: null, morale_score: null };

describe("healthScore", () => {
  it("multiplies the value of each metric's score", () => {
    expect(healthScore({ activity: 3, excellence: 3, morale: 3 }, RULES)).toBe(9);
    expect(healthScore({ activity: 4, excellence: 4, morale: 1 }, RULES)).toBeCloseTo(9.6);
    expect(healthScore({ activity: 5, excellence: 5, morale: 5 }, RULES)).toBe(30);
    expect(healthScore({ activity: 1, excellence: 1, morale: 1 }, RULES)).toBeCloseTo(0.6);
  });

  it("uses each metric's own values", () => {
    const activityHeavy: HealthConfig = { ...RULES, activity: { 1: 1, 2: 3, 3: 5, 4: 7, 5: 9 } };
    expect(healthScore({ activity: 5, excellence: 2, morale: 3 }, activityHeavy)).toBe(18);
  });

  it.each([
    ["zero", { activity: 0, excellence: 3, morale: 3 }],
    ["above 5", { activity: 3, excellence: 6, morale: 3 }],
    ["fractional", { activity: 3, excellence: 3, morale: 2.5 }],
    ["NaN", { activity: Number.NaN, excellence: 3, morale: 3 }],
  ])("rejects a score that is %s", (_label, scores) => {
    expect(() => healthScore(scores, RULES)).toThrow(RangeError);
  });
});

describe("healthBand", () => {
  it.each([
    [30, "green"],
    [12, "green"],
    [11.99, "yellow"],
    [6, "yellow"],
    [5.99, "red"],
    [0.6, "red"],
  ] as const)("colours %s as %s", (score, band) => {
    expect(healthBand(score, RULES)).toBe(band);
  });

  it("treats floating-point noise just under a threshold as reaching it", () => {
    // 3 × 3 × 0.6 is 5.3999999999999995 in floating point, not 5.4.
    const score = healthScore({ activity: 3, excellence: 3, morale: 1 }, RULES);
    expect(score).not.toBe(5.4);
    const rules: HealthConfig = { ...RULES, thresholds: { green: 12, yellow: 5.4 } };
    expect(healthBand(score, rules)).toBe("yellow");
  });

  it("applies the default rules end to end", () => {
    const band = (a: number, e: number, m: number) =>
      healthBand(healthScore({ activity: a, excellence: e, morale: m }, RULES), RULES);
    expect(band(4, 3, 3)).toBe("green"); // 12
    expect(band(3, 3, 3)).toBe("yellow"); // 9
    expect(band(5, 5, 1)).toBe("green"); // 15: strong work outweighs very low morale
    expect(band(4, 3, 1)).toBe("yellow"); // 7.2
    expect(band(2, 3, 3)).toBe("yellow"); // 6
    expect(band(2, 2, 5)).toBe("red"); // 4.8: high morale can't rescue low output
  });
});

describe("teamWeekHealth", () => {
  it("returns null when nothing is graded yet", () => {
    expect(teamWeekHealth([], RULES)).toBeNull();
    expect(teamWeekHealth([ungraded, ungraded], RULES)).toBeNull();
  });

  it("averages the graded check-ins and skips ungraded ones", () => {
    const cell = teamWeekHealth([graded(4, 3, 3), graded(3, 3, 3), ungraded], RULES);
    expect(cell).toEqual({
      band: "yellow",
      score: 10.5,
      graded: 2,
      bands: { green: 1, yellow: 1, red: 0 },
    });
  });

  it("skips a check-in with only some scores", () => {
    const partial = { activity_score: 5, excellence_score: null, morale_score: 5 };
    expect(teamWeekHealth([partial, graded(5, 5, 5)], RULES)?.graded).toBe(1);
  });

  it("counts a red member even when the team's mean is green", () => {
    const cell = teamWeekHealth([graded(5, 5, 5), graded(5, 5, 4), graded(1, 2, 2)], RULES);
    expect(cell?.band).toBe("green");
    expect(cell?.bands.red).toBe(1);
  });

  it("colours the exact mean, not the rounded one", () => {
    // 18 × 6 + 2 + 9.9 = 119.9 over 20 check-ins: a mean of 5.995, which displays as 6 but is red.
    const cell = teamWeekHealth(
      [...Array(18).fill(graded(2, 3, 3)), graded(1, 2, 3), graded(3, 3, 4)],
      RULES,
    );
    expect(cell?.score).toBe(6);
    expect(cell?.band).toBe("red");
  });

  it("follows the config it is given", () => {
    const strict: HealthConfig = { ...RULES, thresholds: { green: 20, yellow: 10 } };
    expect(teamWeekHealth([graded(4, 3, 3)], strict)?.band).toBe("yellow");
  });
});

describe("healthConfigProblems", () => {
  const withThresholds = (green: number, yellow: number): HealthConfig => ({
    ...RULES,
    thresholds: { green, yellow },
  });

  it("accepts the default rules", () => {
    expect(healthConfigProblems(RULES)).toEqual([]);
  });

  it("flags a yellow threshold at or above green", () => {
    expect(healthConfigProblems(withThresholds(6, 12))).toHaveLength(1);
    expect(healthConfigProblems(withThresholds(6, 6))).toHaveLength(1);
  });

  it("flags green or red that no check-in can reach", () => {
    expect(healthConfigProblems(withThresholds(31, 6))).toEqual(["no check-in can be green with these settings"]);
    expect(healthConfigProblems(withThresholds(12, 0.6))).toEqual(["no check-in can be red with these settings"]);
  });

  it("flags yellow that no check-in can reach, even with green and red reachable", () => {
    // Every score is a whole number here, so nothing lands between 1.2 and 1.5.
    const flat: HealthConfig = {
      ...RULES,
      morale: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 },
      thresholds: { green: 1.5, yellow: 1.2 },
    };
    expect(healthConfigProblems(flat)).toEqual(["no check-in can be yellow with these settings"]);
  });

  it("flags a non-positive or decreasing value", () => {
    const zero: HealthConfig = { ...RULES, morale: { ...RULES.morale, 1: 0 } };
    const decreasing: HealthConfig = { ...RULES, activity: { ...RULES.activity, 4: 2.5 } };
    expect(healthConfigProblems(zero)).toContain("morale 1 must be a positive number, got 0");
    expect(healthConfigProblems(decreasing)).toContain("activity 4 counts for less than activity 3");
  });
});

describe("settingsToConfig", () => {
  const row: ScoringSettingsRow = {
    activity_1: 1, activity_2: 2, activity_3: 3, activity_4: 4, activity_5: 5,
    excellence_1: 1, excellence_2: 2, excellence_3: 3, excellence_4: 4, excellence_5: 5,
    // Postgres numeric can come back as a string.
    morale_1: "0.6", morale_2: "0.8", morale_3: "1.0", morale_4: "1.1", morale_5: "1.2",
    green_threshold: "12", yellow_threshold: 6,
  };

  it("reads the scoring_settings row", () => {
    expect(settingsToConfig(row)).toEqual(RULES);
  });

  it("refuses an unusable row", () => {
    expect(() => settingsToConfig({ ...row, yellow_threshold: 20 })).toThrow(/Unusable scoring settings/);
  });
});
