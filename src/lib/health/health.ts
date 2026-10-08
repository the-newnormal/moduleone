export type Band = "green" | "yellow" | "red";

type Score = 1 | 2 | 3 | 4 | 5;

// What each 1–5 score of one metric counts for.
export type ScoreValues = Readonly<Record<Score, number>>;

// The R/Y/G rules. The live values are the single row in the scoring_settings table, which admins
// edit; read them with settingsToConfig(). A check-in's score is
// activity[a] × excellence[e] × morale[m]; at or above thresholds.green it is green, at or above
// thresholds.yellow yellow, otherwise red.
export type HealthConfig = {
  activity: ScoreValues;
  excellence: ScoreValues;
  morale: ScoreValues;
  thresholds: Readonly<{ green: number; yellow: number }>;
};

export type Scores = { activity: number; excellence: number; morale: number };

// As read from the checkins table: every score is null until the grader has run.
export type MaybeScores = {
  activity_score: number | null;
  excellence_score: number | null;
  morale_score: number | null;
};

export type CellHealth = {
  band: Band;
  score: number;
  graded: number;
  bands: Record<Band, number>;
};

// The scoring_settings row. Postgres numeric may arrive as a number or a numeric string.
type Numeric = number | string;
export type ScoringSettingsRow = Record<
  `${"activity" | "excellence" | "morale"}_${Score}` | "green_threshold" | "yellow_threshold",
  Numeric
>;

const SCORES = [1, 2, 3, 4, 5] as const;
const METRICS = ["activity", "excellence", "morale"] as const;

// Floating-point products land a hair off the true value (3 × 0.6 is 1.7999999999999998), so a
// score counts as reaching a threshold within this tolerance. Bands always use the exact score;
// rounding is for display only, so a mean of 5.995 stays red rather than rounding up to 6.
const TOLERANCE = 1e-9;

function assertScore(name: string, value: number): asserts value is Score {
  if (!SCORES.includes(value as Score)) {
    throw new RangeError(`${name} must be a whole number from 1 to 5, got ${value}`);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function healthScore(scores: Scores, config: HealthConfig): number {
  assertScore("activity", scores.activity);
  assertScore("excellence", scores.excellence);
  assertScore("morale", scores.morale);
  return (
    config.activity[scores.activity] *
    config.excellence[scores.excellence] *
    config.morale[scores.morale]
  );
}

export function healthBand(score: number, config: HealthConfig): Band {
  if (score + TOLERANCE >= config.thresholds.green) return "green";
  if (score + TOLERANCE >= config.thresholds.yellow) return "yellow";
  return "red";
}

// One team's cell for one week. Check-ins the grader hasn't scored yet are left out, and a week
// with no graded check-ins returns null (an empty cell, not a red one). `score` is the mean rounded
// to 2 decimals for display. `bands` counts the check-ins in each colour, so a green mean can still
// show that someone on the team is red.
export function teamWeekHealth(
  checkins: readonly MaybeScores[],
  config: HealthConfig,
): CellHealth | null {
  const bands: Record<Band, number> = { green: 0, yellow: 0, red: 0 };
  let total = 0;
  let graded = 0;

  for (const c of checkins) {
    if (c.activity_score === null || c.excellence_score === null || c.morale_score === null) continue;
    const score = healthScore(
      { activity: c.activity_score, excellence: c.excellence_score, morale: c.morale_score },
      config,
    );
    bands[healthBand(score, config)] += 1;
    total += score;
    graded += 1;
  }

  if (graded === 0) return null;
  const mean = total / graded;
  return { band: healthBand(mean, config), score: round2(mean), graded, bands };
}

// Problems with a config, as readable sentences. Empty means the config is usable. The database
// enforces the same rules on scoring_settings (plus two decimals and a 0.01–1000 range, which keep
// every product clear of TOLERANCE); the admin settings form can show these before saving.
export function healthConfigProblems(config: HealthConfig): string[] {
  const problems: string[] = [];

  for (const metric of METRICS) {
    for (const score of SCORES) {
      const value = config[metric][score];
      if (!Number.isFinite(value) || value <= 0) {
        problems.push(`${metric} ${score} must be a positive number, got ${value}`);
      } else if (score > 1 && value < config[metric][(score - 1) as Score]) {
        problems.push(`${metric} ${score} counts for less than ${metric} ${score - 1}`);
      }
    }
  }

  const { green, yellow } = config.thresholds;
  if (!Number.isFinite(green) || !Number.isFinite(yellow)) {
    problems.push("the green and yellow thresholds must be numbers");
  } else if (yellow >= green) {
    problems.push(`the yellow threshold (${yellow}) must be below the green one (${green})`);
  }
  if (problems.length > 0) return problems;

  // Score all 125 possible check-ins; every colour must come up at least once.
  const reachable = new Set<Band>();
  for (const activity of SCORES) {
    for (const excellence of SCORES) {
      for (const morale of SCORES) {
        reachable.add(healthBand(healthScore({ activity, excellence, morale }, config), config));
      }
    }
  }
  for (const band of ["green", "yellow", "red"] as const) {
    if (!reachable.has(band)) problems.push(`no check-in can be ${band} with these settings`);
  }
  return problems;
}

function scoreValues(row: ScoringSettingsRow, metric: (typeof METRICS)[number]): ScoreValues {
  return {
    1: Number(row[`${metric}_1`]),
    2: Number(row[`${metric}_2`]),
    3: Number(row[`${metric}_3`]),
    4: Number(row[`${metric}_4`]),
    5: Number(row[`${metric}_5`]),
  };
}

// The scoring_settings row as a HealthConfig. Throws if the row is unusable, which the database's
// own checks should make impossible.
export function settingsToConfig(row: ScoringSettingsRow): HealthConfig {
  const config: HealthConfig = {
    activity: scoreValues(row, "activity"),
    excellence: scoreValues(row, "excellence"),
    morale: scoreValues(row, "morale"),
    thresholds: { green: Number(row.green_threshold), yellow: Number(row.yellow_threshold) },
  };
  const problems = healthConfigProblems(config);
  if (problems.length > 0) throw new Error(`Unusable scoring settings: ${problems.join("; ")}`);
  return config;
}
