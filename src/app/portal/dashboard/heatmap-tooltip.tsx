"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

type Tip = { title: string; lines: string[]; x: number; y: number; below: boolean };

const HALF_WIDTH = 150; // half the tooltip's max width, to keep it on screen

// One tooltip for the whole grid: any element inside with data-tip-title (and optional
// data-tip-body, one line per "\n") shows it on hover and on keyboard focus. Escape or scrolling
// hides it. It only repeats what the cell's aria-label and the drill-in page already say.
// It also scrolls a data-scroll-to-end container to its right edge (the latest week) on load.
export function HeatmapTooltip({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;

    // On a narrow screen, open on the latest weeks rather than the oldest.
    const scroller = el.querySelector<HTMLElement>("[data-scroll-to-end]");
    if (scroller) scroller.scrollLeft = scroller.scrollWidth;

    const show = (event: Event) => {
      const target = (event.target as Element | null)?.closest<HTMLElement>("[data-tip-title]");
      if (!target || !el.contains(target)) {
        if (event.type === "pointerover") setTip(null);
        return;
      }
      const box = target.getBoundingClientRect();
      const below = box.top < 110;
      setTip({
        title: target.dataset.tipTitle ?? "",
        lines: (target.dataset.tipBody ?? "").split("\n").filter(Boolean),
        x: Math.min(Math.max(box.left + box.width / 2, HALF_WIDTH + 8), window.innerWidth - HALF_WIDTH - 8),
        y: below ? box.bottom + 6 : box.top - 6,
        below,
      });
    };
    const hide = () => setTip(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };

    el.addEventListener("pointerover", show);
    el.addEventListener("focusin", show);
    el.addEventListener("pointerleave", hide);
    el.addEventListener("focusout", hide);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("pointerover", show);
      el.removeEventListener("focusin", show);
      el.removeEventListener("pointerleave", hide);
      el.removeEventListener("focusout", hide);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div ref={root}>
      {children}
      {tip && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-50 max-w-[300px] rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
          style={{
            left: tip.x,
            top: tip.y,
            transform: `translate(-50%, ${tip.below ? "0" : "-100%"})`,
          }}
        >
          <p className="font-medium">{tip.title}</p>
          {tip.lines.map((line) => (
            <p key={line} className="text-muted-foreground">
              {line}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
