import type { HealthConfig } from "./health";

// The heat-map rules. To retune the colours, edit the numbers below and open a PR.
// Colours are worked out from each check-in's stored scores when a page loads and are never stored
// (the dashboard must not colour cells from checkins.category), so an edit here recolours every
// past week too. health.test.ts fails CI only if an edit leaves the rules inconsistent (say, a
// yellow threshold above the green one), not because the numbers changed.
export const HEALTH_CONFIG = {
  // A check-in's health score is activity × excellence × this multiplier for its morale score.
  // Low morale pulls the score down and high morale lifts it.
  // activity and excellence are 1–5, so with these multipliers the score runs from 0.6 to 30.
  moraleMultiplier: { 1: 0.6, 2: 0.8, 3: 1.0, 4: 1.1, 5: 1.2 },

  // A score at or above `green` is green, at or above `yellow` is yellow, and anything lower is red.
  // A team's cell for a week uses the mean score of that week's graded check-ins.
  thresholds: { green: 12, yellow: 6 },
} as const satisfies HealthConfig;
