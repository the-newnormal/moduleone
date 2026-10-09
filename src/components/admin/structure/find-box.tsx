"use client";

import { SearchIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { MemberRow } from "@/app/admin/teams/[id]/team-view";
import { Input } from "@/components/ui/input";
import { findMatches, type SearchMatch } from "./canvas-search";
import type { StructureRow } from "./counts";

// "Find a person or team": type part of a name, then pick a match (click it, or arrow to it and
// press Enter; Enter alone takes the first). The chart pans to it and opens its panel (onPick).
// A combobox in the ARIA sense: focus stays in the box, and the highlighted match is announced.
export function FindBox({
  rows,
  members,
  onPick,
}: {
  rows: readonly StructureRow[];
  members: readonly MemberRow[];
  onPick: (match: SearchMatch) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState(0);
  const matches = useMemo(() => findMatches(query, rows, members), [query, rows, members]);
  // The highlighted match. The chart's data can change under an open list (a save re-renders the
  // page), leaving fewer matches: then the first one is highlighted.
  const active = chosen < matches.length ? chosen : 0;
  const showing = open && query.trim() !== "";
  const optionId = (i: number) => `${id}-option-${i}`;

  const pick = (match: SearchMatch) => {
    setOpen(false);
    setQuery("");
    onPick(match);
  };

  return (
    <div className="relative w-full max-w-xs">
      <label htmlFor={`${id}-input`} className="sr-only">
        Find a person or team
      </label>
      <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        id={`${id}-input`}
        type="search"
        role="combobox"
        autoComplete="off"
        placeholder="Find a person or team"
        className="pl-8"
        aria-expanded={showing && matches.length > 0}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={showing && matches.length > 0 ? optionId(active) : undefined}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setChosen(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        // Late enough for a click on a match to land first.
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (matches.length === 0) return;
            event.preventDefault();
            setOpen(true);
            const step = event.key === "ArrowDown" ? 1 : -1;
            setChosen((active + step + matches.length) % matches.length);
          } else if (event.key === "Enter") {
            const match = matches[active];
            if (!showing || !match) return;
            event.preventDefault();
            pick(match);
          } else if (event.key === "Escape" && showing) {
            // Only closes the list, keeping what was typed (a search input clears itself on Escape
            // otherwise); the side panel's own Escape isn't for this.
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {/* Nothing to pick: said as a status, not offered as an option. */}
      <p
        role="status"
        className="absolute top-full right-0 left-0 z-30 mt-1 rounded-md border bg-popover px-3 py-2 text-sm text-muted-foreground shadow-md empty:hidden"
      >
        {showing && matches.length === 0 ? "No one and nothing by that name." : null}
      </p>
      <ul
        id={`${id}-list`}
        role="listbox"
        aria-label="Matches"
        hidden={!showing || matches.length === 0}
        className="absolute top-full right-0 left-0 z-30 mt-1 grid max-h-80 overflow-y-auto rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md"
      >
        {matches.map((match, i) => (
            <li
              key={`${match.type}:${match.id}`}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              data-match={`${match.type}:${match.id}`}
              className="flex cursor-pointer items-baseline justify-between gap-3 rounded-sm px-2 py-1.5 aria-selected:bg-accent aria-selected:text-accent-foreground"
              // pointerdown, before the input's blur closes the list.
              onPointerDown={(event) => {
                event.preventDefault();
                pick(match);
              }}
              onPointerEnter={() => setChosen(i)}
            >
              <span className="truncate font-medium">{match.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{match.detail}</span>
            </li>
        ))}
      </ul>
    </div>
  );
}
