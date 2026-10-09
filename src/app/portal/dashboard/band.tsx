import { CircleCheck, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import type { HeatmapCell } from "@/lib/dashboard/org";
import type { Band } from "@/lib/health/health";

// How each colour looks everywhere on the dashboard: a distinct icon shape plus a word, so the
// band never rests on colour alone.
export const BANDS: Record<Band, { label: string; Icon: LucideIcon; icon: string; tint: string; bar: string }> = {
  green: {
    label: "Green",
    Icon: CircleCheck,
    icon: "text-status-good",
    tint: "bg-status-good/12",
    bar: "bg-status-good",
  },
  yellow: {
    label: "Yellow",
    Icon: TriangleAlert,
    icon: "text-status-warning",
    tint: "bg-status-warning/20",
    bar: "bg-status-warning",
  },
  red: {
    label: "Red",
    Icon: OctagonAlert,
    icon: "text-status-critical",
    tint: "bg-status-critical/12",
    bar: "bg-status-critical",
  },
};

// `score` comes from formatScore, so the number never contradicts the colour.
export function BandBadge({ band, score }: { band: Band; score?: string }) {
  const { label, Icon, icon, tint } = BANDS[band];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-sm font-medium ${tint}`}>
      <Icon aria-hidden className={`size-4 ${icon}`} strokeWidth={2.25} />
      {label}
      {score !== undefined && <span className="text-muted-foreground tabular-nums">{score}</span>}
    </span>
  );
}

// A week's bar on the org chart. Taller is better: the bar's height repeats its colour, so the run
// reads without colour too, and a darker edge keeps every bar at 3:1 against the row (yellow alone
// is under 2:1 on white). Weeks with nothing graded sit off that scale: a dashed outline while
// waiting for the grader, a flat line when nobody checked in.
const BAR_HEIGHT: Record<Band, string> = { green: "h-5", yellow: "h-3.5", red: "h-2" };

export function barClass(cell: Pick<HeatmapCell, "health" | "pending">): string {
  const band = cell.health?.band;
  if (band) return `${BAR_HEIGHT[band]} ${BANDS[band].bar} ring-1 ring-black/30 ring-inset`;
  return cell.pending > 0 ? "h-full border border-dashed border-muted-foreground" : "h-0.5 bg-muted-foreground/40";
}
