import type { ReactNode } from "react";

// Normal's Stat: one headline number with its label and a hint saying what it counts. Laid out in a
// row of two to four.
export function Stat({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-[20px] bg-card p-4 sm:p-6">
      <dt className="text-xs leading-4 font-medium tracking-[0.02em] text-muted-foreground">{label}</dt>
      <dd className="font-mono text-[32px] leading-9 tracking-[-0.02em] tabular-nums">{value}</dd>
      {hint && <dd className="text-[13px] leading-[18px] text-muted-foreground">{hint}</dd>}
    </div>
  );
}
