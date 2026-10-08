import { CircleCheck, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import type { Band } from "@/lib/health/health";

// How each colour looks everywhere on the dashboard: a distinct icon shape plus a word, so the
// band never rests on colour alone.
export const BANDS: Record<Band, { label: string; Icon: LucideIcon; icon: string; tint: string }> = {
  green: { label: "Green", Icon: CircleCheck, icon: "text-status-good", tint: "bg-status-good/12" },
  yellow: { label: "Yellow", Icon: TriangleAlert, icon: "text-status-warning", tint: "bg-status-warning/20" },
  red: { label: "Red", Icon: OctagonAlert, icon: "text-status-critical", tint: "bg-status-critical/12" },
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
