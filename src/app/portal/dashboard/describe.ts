import type { HeatmapCell } from "@/lib/dashboard/org";
import { formatWeek } from "@/lib/dashboard/weeks";
import { formatScore, type HealthConfig } from "@/lib/health/health";
import { BANDS } from "./band";

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// A team's week as the tooltip and the accessible name say it, with the number the page shows.
export function describeCell(name: string, cell: HeatmapCell, config: HealthConfig) {
  const title = `${name} · week of ${formatWeek(cell.week, true)}`;
  const lines: string[] = [];
  if (cell.health) {
    const { band, score, graded, bands } = cell.health;
    lines.push(`${BANDS[band].label} · mean score ${formatScore(score, config)}`);
    lines.push(
      `${plural(graded, "graded check-in")}: ${bands.green} green, ${bands.yellow} yellow, ${bands.red} red`,
    );
  } else if (cell.pending === 0) {
    lines.push("No check-ins");
  } else {
    lines.push("Nothing graded yet");
  }
  if (cell.pending > 0) lines.push(`${cell.pending} waiting for the grader`);
  return { title, lines };
}

// One word or two for a week, for reading a run of weeks aloud.
export function cellWord(cell: HeatmapCell): string {
  if (cell.health) return BANDS[cell.health.band].label.toLowerCase();
  return cell.pending > 0 ? "waiting" : "no check-ins";
}

// How many of the week's graded check-ins were red. Boxes print it whatever their colour, since a
// green or yellow mean can hide red check-ins.
export const redCount = (cell: HeatmapCell) => cell.health?.bands.red ?? 0;
