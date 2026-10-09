import type { ReactNode } from "react";
import { cn } from "cn";

// Normal's Tag: a small pill that says a status or a category in one to three words. The word
// carries the meaning; the colour only backs it up.
const TONES = {
  neutral: "border-border bg-card text-foreground",
  outline: "border-line-strong bg-transparent text-foreground",
  ink: "border-transparent bg-primary text-primary-foreground",
  warning: "border-transparent bg-sun-soft text-warning-ink",
  success: "border-transparent bg-success-soft text-success",
} as const;

export function Tag({
  tone = "neutral",
  dot = false,
  className,
  children,
}: {
  tone?: keyof typeof TONES;
  dot?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs leading-4 font-medium tracking-[0.02em] whitespace-nowrap",
        TONES[tone],
        className,
      )}
    >
      {dot && <span aria-hidden className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}
