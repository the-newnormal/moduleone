// The scoring settings form (/admin/scoring): the 15 score values and two thresholds of the single
// scoring_settings row (migration 0002), checked the way the database checks them, plus the live
// preview of all 125 possible check-ins.
//
// The database refuses (with 23514) values outside 0.01–1000, thresholds outside yellow > 0 and
// green ≤ 1,000,000, a better score counting for less, yellow not below green, and settings that
// leave a colour unreachable. Its columns are numeric(6,2) and numeric(8,2): it would silently
// round a third decimal, and can't hold a green of 1,000,000 at all (the most is 999,999.99), so
// those are refused here too.

import {
  type Band,
  type HealthConfig,
  healthBand,
  healthConfigProblems,
  healthScore,
} from "@/lib/health/health";

export const METRICS = ["activity", "excellence", "morale"] as const;
export type Metric = (typeof METRICS)[number];

export const SCORES = [1, 2, 3, 4, 5] as const;
export type Score = (typeof SCORES)[number];

export type ScoreField = `${Metric}_${Score}`;
export type ThresholdField = "green_threshold" | "yellow_threshold";
export type ScoringField = ScoreField | ThresholdField;

export const SCORE_FIELDS: readonly ScoreField[] = METRICS.flatMap((m) =>
  SCORES.map((s) => `${m}_${s}` as const),
);
export const THRESHOLD_FIELDS: readonly ThresholdField[] = ["green_threshold", "yellow_threshold"];
export const SCORING_FIELDS: readonly ScoringField[] = [...SCORE_FIELDS, ...THRESHOLD_FIELDS];

// For supabase.from("scoring_settings").select(SCORING_COLUMNS).
export const SCORING_COLUMNS = SCORING_FIELDS.join(", ");

// What the inputs hold (text, as typed) and what gets saved.
export type ScoringForm = Record<ScoringField, string>;
export type ScoringValues = Record<ScoringField, number>;

// 0002's column defaults: activity × excellence × a morale weight of 0.6–1.2; green ≥ 12,
// yellow ≥ 6.
export const DEFAULT_FORM: Readonly<ScoringForm> = {
  activity_1: "1",
  activity_2: "2",
  activity_3: "3",
  activity_4: "4",
  activity_5: "5",
  excellence_1: "1",
  excellence_2: "2",
  excellence_3: "3",
  excellence_4: "4",
  excellence_5: "5",
  morale_1: "0.6",
  morale_2: "0.8",
  morale_3: "1",
  morale_4: "1.1",
  morale_5: "1.2",
  green_threshold: "12",
  yellow_threshold: "6",
};

export const METRIC_LABELS: Record<Metric, string> = {
  activity: "Activity",
  excellence: "Excellence",
  morale: "Morale",
};

export function fieldLabel(field: ScoringField): string {
  if (field === "green_threshold") return "Green threshold";
  if (field === "yellow_threshold") return "Yellow threshold";
  const [metric, score] = field.split("_") as [Metric, string];
  return `${METRIC_LABELS[metric]} ${score}`;
}

// The form as loaded: Postgres numeric arrives as a number or a numeric string ("0.60").
export function formFromRow(row: Record<ScoringField, number | string>): ScoringForm {
  return Object.fromEntries(
    SCORING_FIELDS.map((field) => [field, String(Number(row[field]))]),
  ) as ScoringForm;
}

export const VALUE_MIN = 0.01;
export const VALUE_MAX = 1000;
export const THRESHOLD_MIN = 0.01;
export const THRESHOLD_MAX = 999_999.99;

// Plain decimals only: digits, at most one dot. No sign, exponent ("1e3"), "NaN", "Infinity",
// hex, commas or inner spaces.
const DECIMAL = /^(\d+(\.\d*)?|\.\d+)$/;

// One input's value, or the sentence to show under it.
export function parseScoringValue(
  field: ScoringField,
  raw: unknown,
): { ok: true; value: number } | { ok: false; error: string } {
  const text = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  if (text === "") return { ok: false, error: "Enter a number." };
  if (!DECIMAL.test(text)) return { ok: false, error: "Enter a plain number, like 1.25." };
  // Trailing zeros are fine ("1.50"); a third significant decimal isn't ("0.001").
  const decimals = (text.split(".")[1] ?? "").replace(/0+$/, "");
  if (decimals.length > 2) return { ok: false, error: "Use at most two decimals." };

  const value = Number(text);
  const threshold = field === "green_threshold" || field === "yellow_threshold";
  const [min, max] = threshold ? [THRESHOLD_MIN, THRESHOLD_MAX] : [VALUE_MIN, VALUE_MAX];
  if (!(value >= min && value <= max)) {
    return { ok: false, error: `Use a number from ${min} to ${max.toLocaleString("en-SG")}.` };
  }
  return { ok: true, value };
}

export function toConfig(values: ScoringValues): HealthConfig {
  const metric = (m: Metric) =>
    Object.fromEntries(SCORES.map((s) => [s, values[`${m}_${s}`]])) as Record<Score, number>;
  return {
    activity: metric("activity"),
    excellence: metric("excellence"),
    morale: metric("morale"),
    thresholds: { green: values.green_threshold, yellow: values.yellow_threshold },
  };
}

export type ScoringCheck =
  // Every value is a usable number. `problems` lists what the database would still refuse (order,
  // thresholds, an unreachable colour), as sentences; empty means it can be saved.
  | { ok: true; values: ScoringValues; config: HealthConfig; problems: string[] }
  // Some inputs aren't usable numbers; `fieldErrors` says why, per input.
  | { ok: false; fieldErrors: Partial<Record<ScoringField, string>> };

const sentence = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}.`;

// Check the whole form, as the database will. Accepts anything (the server action passes what the
// client sent); missing fields count as empty.
export function checkScoringForm(form: unknown): ScoringCheck {
  const input = (typeof form === "object" && form !== null ? form : {}) as Record<string, unknown>;
  const values = {} as ScoringValues;
  const fieldErrors: Partial<Record<ScoringField, string>> = {};
  for (const field of SCORING_FIELDS) {
    const parsed = parseScoringValue(field, Object.hasOwn(input, field) ? input[field] : undefined);
    if (parsed.ok) values[field] = parsed.value;
    else fieldErrors[field] = parsed.error;
  }
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  const config = toConfig(values);
  return { ok: true, values, config, problems: healthConfigProblems(config).map(sentence) };
}

// Whether two forms hold the same settings, as the database would store them ("1.50" is "1.5").
// Text that isn't a usable number is compared as typed.
export function sameScoring(a: ScoringForm, b: ScoringForm): boolean {
  const stored = (field: ScoringField, text: string) => {
    const parsed = parseScoringValue(field, text);
    return parsed.ok ? String(parsed.value) : text;
  };
  return SCORING_FIELDS.every((field) => stored(field, a[field]) === stored(field, b[field]));
}

// Save is offered once every value is usable, the database would take them all, something
// changed, and nothing is saving.
export function canSaveScoring(check: ScoringCheck, changed: boolean, pending: boolean): boolean {
  return check.ok && check.problems.length === 0 && changed && !pending;
}

// ---------- preview ----------

export type PreviewCell = { activity: Score; excellence: Score; morale: Score; score: number; band: Band };

// One morale level: rows by activity (5 at the top), columns by excellence (1 to 5).
export type PreviewGrid = { morale: Score; weight: number; rows: PreviewCell[][] };

export type ScoringPreview = { counts: Record<Band, number>; grids: PreviewGrid[] };

// All 125 possible check-ins under a config, as the heat-map would colour them.
export function scoringPreview(config: HealthConfig): ScoringPreview {
  const counts: Record<Band, number> = { green: 0, yellow: 0, red: 0 };
  const grids = SCORES.map((morale) => ({
    morale,
    weight: config.morale[morale],
    rows: [...SCORES].reverse().map((activity) =>
      SCORES.map((excellence) => {
        const score = healthScore({ activity, excellence, morale }, config);
        const band = healthBand(score, config);
        counts[band] += 1;
        return { activity, excellence, morale, score, band };
      }),
    ),
  }));
  return { counts, grids };
}
