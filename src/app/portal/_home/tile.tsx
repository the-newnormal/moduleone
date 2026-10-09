import type { ReactNode } from "react";
import { Tag } from "@/components/normal/tag";

// A portal tile: Normal's flat card (warm stone on the white page, no border or shadow), a section
// named by its heading. `eyebrow` puts the tile's name small above a bigger heading of its own (the
// check-in tile's state).
export function Tile({
  id,
  title,
  aside,
  small = false,
  className = "",
  children,
}: {
  id: string;
  title: string;
  aside?: ReactNode;
  // The title as a small label rather than a heading-size one.
  small?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className={`flex min-w-0 flex-col gap-4 rounded-[20px] bg-card p-6 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <h2
          id={`${id}-title`}
          className={
            small
              ? "font-sans text-xs leading-4 font-medium tracking-[0.02em] text-muted-foreground"
              : "text-xl leading-[26px]"
          }
        >
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

// A tile still to come: a dashed outline on the page, a "Coming soon" tag and one sentence. No
// numbers, colours or links, and nothing to focus, so it can't pass for real data.
export function ComingSoonTile({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      data-placeholder
      className="flex min-w-0 flex-col gap-3 rounded-[20px] border border-dashed border-line-strong p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <h2 id={`${id}-title`} className="text-xl leading-[26px]">
          {title}
        </h2>
        <Tag tone="outline">Coming soon</Tag>
      </div>
      <p className="text-[15px] leading-[22px] text-muted-foreground">{children}</p>
    </section>
  );
}
