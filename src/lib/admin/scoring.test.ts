import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatScore } from "@/lib/health/health";
import {
  canSaveScoring,
  checkScoringForm,
  DEFAULT_FORM,
  fieldLabel,
  formFromRow,
  parseScoringValue,
  SCORING_COLUMNS,
  SCORING_FIELDS,
  type ScoringField,
  type ScoringForm,
  sameScoring,
  scoringPreview,
  toConfig,
} from "./scoring";

const MIGRATION = readFileSync(
  new URL("../../../supabase/migrations/0002_rls_hardening.sql", import.meta.url),
  "utf8",
);

const form = (changes: Partial<ScoringForm> = {}): ScoringForm => ({ ...DEFAULT_FORM, ...changes });

function config(changes: Partial<ScoringForm> = {}) {
  const check = checkScoringForm(form(changes));
  if (!check.ok) throw new Error(JSON.stringify(check.fieldErrors));
  return check.config;
}

describe("the fields", () => {
  it("are the 15 score values and two thresholds, in the database's column names", () => {
    expect(SCORING_FIELDS).toHaveLength(17);
    expect(SCORING_COLUMNS).toBe(
      "activity_1, activity_2, activity_3, activity_4, activity_5, " +
        "excellence_1, excellence_2, excellence_3, excellence_4, excellence_5, " +
        "morale_1, morale_2, morale_3, morale_4, morale_5, green_threshold, yellow_threshold",
    );
    for (const field of SCORING_FIELDS) expect(MIGRATION).toMatch(new RegExp(`\\b${field}\\s+numeric`));
  });

  it("default to 0002's column defaults", () => {
    const defaults = Object.fromEntries(
      [...MIGRATION.matchAll(/^\s+(\w+)\s+numeric\(\d,2\) not null default ([\d.]+),$/gm)].map(([, f, v]) => [
        f,
        Number(v),
      ]),
    );
    expect(Object.keys(defaults).sort()).toEqual([...SCORING_FIELDS].sort());
    for (const field of SCORING_FIELDS) expect(Number(DEFAULT_FORM[field])).toBe(defaults[field]);
  });

  it("have readable labels", () => {
    expect(fieldLabel("activity_1")).toBe("Activity 1");
    expect(fieldLabel("morale_5")).toBe("Morale 5");
    expect(fieldLabel("green_threshold")).toBe("Green threshold");
    expect(fieldLabel("yellow_threshold")).toBe("Yellow threshold");
  });
});

describe("formFromRow", () => {
  it("shows numeric values as typed numbers, whether they arrive as numbers or strings", () => {
    const row = {
      ...Object.fromEntries(SCORING_FIELDS.map((f) => [f, "1.00"])),
      morale_1: "0.60",
      morale_2: 0.8,
      green_threshold: "12.00",
      yellow_threshold: 6,
    } as Record<ScoringField, number | string>;
    const shown = formFromRow(row);
    expect(shown.activity_1).toBe("1");
    expect(shown.morale_1).toBe("0.6");
    expect(shown.morale_2).toBe("0.8");
    expect(shown.green_threshold).toBe("12");
    expect(shown.yellow_threshold).toBe("6");
  });
});

describe("parseScoringValue", () => {
  it.each([
    ["1", 1],
    ["0.01", 0.01],
    ["1000", 1000],
    ["1000.00", 1000],
    ["1.5", 1.5],
    ["1.25", 1.25],
    ["1.50", 1.5],
    ["1.500", 1.5], // trailing zeros aren't a third decimal
    [" 2 ", 2],
    ["1.", 1],
    [".5", 0.5],
    ["007", 7],
  ])("accepts the score value %j", (raw, value) => {
    expect(parseScoringValue("activity_1", raw)).toEqual({ ok: true, value });
  });

  it.each([
    ["", "Enter a number."],
    ["   ", "Enter a number."],
    [undefined, "Enter a number."],
    [null, "Enter a number."],
    [{}, "Enter a number."],
    ["1e3", "Enter a plain number, like 1.25."],
    ["1E3", "Enter a plain number, like 1.25."],
    ["NaN", "Enter a plain number, like 1.25."],
    ["Infinity", "Enter a plain number, like 1.25."],
    ["-Infinity", "Enter a plain number, like 1.25."],
    ["-1", "Enter a plain number, like 1.25."],
    ["+1", "Enter a plain number, like 1.25."],
    ["0x10", "Enter a plain number, like 1.25."],
    ["1,5", "Enter a plain number, like 1.25."],
    ["1 000", "Enter a plain number, like 1.25."],
    ["1..2", "Enter a plain number, like 1.25."],
    [".", "Enter a plain number, like 1.25."],
    ["١", "Enter a plain number, like 1.25."], // an Arabic-Indic digit
    ["0.001", "Use at most two decimals."],
    ["1.234", "Use at most two decimals."],
    ["0.005", "Use at most two decimals."],
    ["0", "Use a number from 0.01 to 1,000."],
    ["0.00", "Use a number from 0.01 to 1,000."],
    ["1000.01", "Use a number from 0.01 to 1,000."],
    ["99999999999999999999", "Use a number from 0.01 to 1,000."],
    [NaN, "Enter a plain number, like 1.25."],
    [Infinity, "Enter a plain number, like 1.25."],
    [1e21, "Enter a plain number, like 1.25."],
    [0.001, "Use at most two decimals."],
  ])("refuses the score value %j", (raw, error) => {
    expect(parseScoringValue("excellence_3", raw)).toEqual({ ok: false, error });
  });

  it("accepts a number value as sent", () => {
    expect(parseScoringValue("morale_1", 0.6)).toEqual({ ok: true, value: 0.6 });
  });

  it("holds thresholds to their own column's limits", () => {
    expect(parseScoringValue("green_threshold", "999999.99")).toEqual({ ok: true, value: 999999.99 });
    expect(parseScoringValue("green_threshold", "5000")).toEqual({ ok: true, value: 5000 });
    // 0002 allows green ≤ 1,000,000, but numeric(8,2) can't hold it.
    expect(parseScoringValue("green_threshold", "1000000")).toEqual({
      ok: false,
      error: "Use a number from 0.01 to 999,999.99.",
    });
    expect(parseScoringValue("yellow_threshold", "0")).toEqual({
      ok: false,
      error: "Use a number from 0.01 to 999,999.99.",
    });
    expect(parseScoringValue("yellow_threshold", "0.01")).toEqual({ ok: true, value: 0.01 });
  });
});

describe("checkScoringForm", () => {
  it("accepts the defaults", () => {
    const check = checkScoringForm(DEFAULT_FORM);
    expect(check).toMatchObject({ ok: true, problems: [] });
    if (!check.ok) return;
    expect(check.values.morale_1).toBe(0.6);
    expect(check.config).toEqual({
      activity: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 },
      excellence: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 },
      morale: { 1: 0.6, 2: 0.8, 3: 1, 4: 1.1, 5: 1.2 },
      thresholds: { green: 12, yellow: 6 },
    });
  });

  it("reports every unusable input by field", () => {
    const check = checkScoringForm(form({ activity_2: "1e3", morale_5: "0.001", green_threshold: "" }));
    expect(check).toEqual({
      ok: false,
      fieldErrors: {
        activity_2: "Enter a plain number, like 1.25.",
        morale_5: "Use at most two decimals.",
        green_threshold: "Enter a number.",
      },
    });
  });

  it("treats missing fields, and anything that isn't an object, as empty", () => {
    const rest: Partial<ScoringForm> = { ...DEFAULT_FORM };
    delete rest.activity_1;
    expect(checkScoringForm(rest)).toEqual({ ok: false, fieldErrors: { activity_1: "Enter a number." } });
    for (const bad of [null, undefined, "x", 5, []]) {
      const check = checkScoringForm(bad);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(Object.keys(check.fieldErrors)).toHaveLength(17);
    }
  });

  it("doesn't read inherited properties", () => {
    const inherited = Object.create({ ...DEFAULT_FORM });
    expect(checkScoringForm(inherited).ok).toBe(false);
  });

  it("ignores fields it doesn't know", () => {
    expect(checkScoringForm({ ...DEFAULT_FORM, updated_by: "someone", id: 2 })).toMatchObject({
      ok: true,
      problems: [],
    });
  });

  it.each([
    [{ activity_2: "0.5" }, "Activity 2 counts for less than activity 1."],
    [{ morale_5: "1" }, "Morale 5 counts for less than morale 4."],
    [{ yellow_threshold: "12" }, "The yellow threshold (12) must be below the green one (12)."],
    [{ green_threshold: "31" }, "No check-in can be green with these settings."],
    [{ yellow_threshold: "0.5", green_threshold: "0.59" }, "No check-in can be red with these settings."],
  ])("lists what the database would refuse: %o", (changes, problem) => {
    const check = checkScoringForm(form(changes));
    expect(check.ok && check.problems).toContain(problem);
  });

  it("agrees with the database on a score exactly at a threshold", () => {
    // 5 × 4 × 0.6 is 11.999999999999998 in floating point; the database says 12.00, green.
    expect(checkScoringForm(form({ green_threshold: "12" }))).toMatchObject({ ok: true, problems: [] });
    expect(scoringPreview(config()).grids[0].rows[0][3]).toMatchObject({
      activity: 5,
      excellence: 4,
      band: "green",
    });
  });
});

describe("sameScoring", () => {
  it("compares the values as the database stores them", () => {
    expect(sameScoring(DEFAULT_FORM, { ...DEFAULT_FORM })).toBe(true);
    expect(sameScoring(DEFAULT_FORM, { ...DEFAULT_FORM, morale_1: "0.60", green_threshold: " 12.0 " })).toBe(true);
    expect(sameScoring(DEFAULT_FORM, { ...DEFAULT_FORM, morale_1: "0.61" })).toBe(false);
    expect(sameScoring({ ...DEFAULT_FORM, activity_1: "x" }, { ...DEFAULT_FORM, activity_1: "x" })).toBe(true);
    expect(sameScoring({ ...DEFAULT_FORM, activity_1: "x" }, DEFAULT_FORM)).toBe(false);
  });
});

describe("canSaveScoring", () => {
  const usable = checkScoringForm(DEFAULT_FORM);
  const refused = checkScoringForm({ ...DEFAULT_FORM, yellow_threshold: "12" });
  const unusable = checkScoringForm({ ...DEFAULT_FORM, activity_1: "1e3" });

  it("offers Save once something changed and the database would take it", () => {
    expect(canSaveScoring(usable, true, false)).toBe(true);
  });

  it("holds Save back when nothing changed, while saving, or while anything is wrong", () => {
    expect(canSaveScoring(usable, false, false)).toBe(false);
    expect(canSaveScoring(usable, true, true)).toBe(false);
    expect(refused.ok && refused.problems.length).toBeGreaterThan(0);
    expect(canSaveScoring(refused, true, false)).toBe(false);
    expect(canSaveScoring(unusable, true, false)).toBe(false);
  });
});

describe("toConfig", () => {
  it("builds the HealthConfig the heat-map uses", () => {
    const check = checkScoringForm(form({ morale_3: "1.05" }));
    if (!check.ok) throw new Error("unexpected");
    expect(toConfig(check.values).morale[3]).toBe(1.05);
  });
});

describe("scoringPreview", () => {
  it("colours all 125 possible check-ins", () => {
    const preview = scoringPreview(config());
    expect(preview.counts).toEqual({ green: 35, yellow: 35, red: 55 });
    expect(preview.grids.map((g) => [g.morale, g.weight])).toEqual([
      [1, 0.6],
      [2, 0.8],
      [3, 1],
      [4, 1.1],
      [5, 1.2],
    ]);
    const cells = preview.grids.flatMap((g) => g.rows.flat());
    expect(cells).toHaveLength(125);
    expect(new Set(cells.map((c) => `${c.activity}${c.excellence}${c.morale}`)).size).toBe(125);
  });

  it("lays each grid out with activity 5 at the top and excellence 1 to 5 across", () => {
    const grid = scoringPreview(config()).grids[4];
    expect(grid.rows.map((row) => row[0].activity)).toEqual([5, 4, 3, 2, 1]);
    expect(grid.rows[0].map((cell) => cell.excellence)).toEqual([1, 2, 3, 4, 5]);
    expect(grid.rows[0][4]).toEqual({ activity: 5, excellence: 5, morale: 5, score: 30, band: "green" });
    expect(grid.rows[4][0]).toMatchObject({ activity: 1, excellence: 1, score: 1.2, band: "red" });
  });

  it("follows the settings", () => {
    const strict = scoringPreview(config({ green_threshold: "30", yellow_threshold: "29.99" }));
    expect(strict.counts).toEqual({ green: 1, yellow: 0, red: 124 });
  });

  it("shows scores that never contradict their colour", () => {
    // 4 × 1 × 1.49 is 5.96: red while yellow starts at 6, so it must not read "6.0".
    const c = config({ morale_3: "1.49", morale_4: "1.49", morale_5: "1.5" });
    const cell = scoringPreview(c).grids[2].rows[1][0];
    expect(cell).toMatchObject({ activity: 4, excellence: 1, morale: 3, band: "red" });
    expect(formatScore(cell.score, c)).toBe("5.96");
  });
});
