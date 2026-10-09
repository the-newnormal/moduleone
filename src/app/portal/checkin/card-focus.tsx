"use client";

import { useEffect, useRef, type ReactNode } from "react";

// The card's contents change after an action (recorder to draft, draft to submitted), which
// removes the button that had focus. Move focus to the new card's heading, so keyboard users carry
// on from there and screen readers announce what happened. Not on first load.
export function CardFocus({ state, children }: { state: string; children: ReactNode }) {
  const wrapper = useRef<HTMLDivElement>(null);
  const shown = useRef(state);

  useEffect(() => {
    if (shown.current === state) return;
    shown.current = state;
    const target = wrapper.current?.querySelector<HTMLElement>("h2") ?? wrapper.current;
    target?.focus();
  }, [state]);

  return (
    <div ref={wrapper} tabIndex={-1} className="outline-none">
      {children}
    </div>
  );
}
