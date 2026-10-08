import { HEALTH_CONFIG } from "./config";

export type Band = "green" | "yellow" | "red";

export type HealthConfig = {
  moraleMultiplier: Readonly<Record<1 | 2 | 3 | 4 | 5, number>>;
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

const SCORES = [1, 2, 3, 4, 5] as const;

function assertScore(name: string, value: number): asserts value is 1 | 2 | 3 | 4 | 5 {
  if (!SCORES.includes(value as 1)) {
    throw new RangeError(`${name} must be a whole number from 1 to 5, got ${value}`);
  }
}

// Floating-point products land a hair off the true value (3 × 0.6 is 1.7999999999999998), so a
// score counts as reaching a threshold within this tolerance. Bands always use the exact score;
// rounding is for display only, so a mean of 5.995 stays red rather than rounding up to 6.
const TOLERANCE = 1e-9;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function healthScore(scores: Scores, config: HealthConfig = HEALTH_CONFIG): number {
  assertScore("activity", scores.activity);
  assertScore("excellence", scores.excellence);
  assertScore("morale", scores.morale);
  return scores.activity * scores.excellence * config.moraleMultiplier[scores.morale];
}

export function healthBand(score: number, config: HealthConfig = HEALTH_CONFIG): Band {
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
  config: HealthConfig = HEALTH_CONFIG,
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

// Problems with a config, as readable sentences. Empty means the config is usable.
export function healthConfigProblems(config: HealthConfig): string[] {
  const problems: string[] = [];
  const { green, yellow } = config.thresholds;

  for (const morale of SCORES) {
    const m = config.moraleMultiplier[morale];
    if (!Number.isFinite(m) || m <= 0) {
      problems.push(`moraleMultiplier[${morale}] must be a positive number, got ${m}`);
    }
    if (morale > 1 && m < config.moraleMultiplier[(morale - 1) as 1]) {
      problems.push(`moraleMultiplier[${morale}] is lower than moraleMultiplier[${morale - 1}]`);
    }
  }
  if (!Number.isFinite(green) || !Number.isFinite(yellow)) {
    problems.push("thresholds.green and thresholds.yellow must be numbers");
  } else if (yellow >= green) {
    problems.push(`thresholds.yellow (${yellow}) must be below thresholds.green (${green})`);
  } else {
    const lowest = 1 * 1 * config.moraleMultiplier[1];
    const highest = 5 * 5 * config.moraleMultiplier[5];
    if (healthBand(highest, config) !== "green") {
      problems.push(`no check-in can be green: the highest score is ${round2(highest)}`);
    }
    if (healthBand(lowest, config) !== "red") {
      problems.push(`no check-in can be red: the lowest score is ${round2(lowest)}`);
    }
  }
  return problems;
}
