// "Find a person or team" on the Structure page: which nodes and people match what's typed, best
// first. Archived nodes and people removed from Module One are never offered, nor anyone sitting
// in an archived node (the chart doesn't show them either; see canvasPeopleOf).

import type { MemberRow } from "@/app/admin/teams/[id]/team-view";
import { KIND_LABELS } from "@/lib/admin/tree";
import type { StructureRow } from "./counts";

export type SearchMatch =
  | { type: "node"; id: string; name: string; detail: string }
  // teamId: the node they sit in, or null for no team.
  | { type: "person"; id: string; name: string; detail: string; teamId: string | null };

export const MAX_MATCHES = 8;

// Lower case, accents dropped, runs of spaces as one.
const fold = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

// 0: the name starts with the query; 1: a later word does; 2: it's somewhere in the name (or, for
// a node, its code starts with it); null: no match.
function rank(name: string, query: string, code: string | null = null): number | null {
  const folded = fold(name);
  if (folded.startsWith(query)) return 0;
  if (folded.split(" ").some((word) => word.startsWith(query))) return 1;
  if (folded.includes(query) || (code !== null && fold(code).startsWith(query))) return 2;
  return null;
}

export function findMatches(
  query: string,
  rows: readonly StructureRow[],
  members: readonly MemberRow[],
  limit: number = MAX_MATCHES,
): SearchMatch[] {
  const q = fold(query);
  if (q === "") return [];
  const active = new Map(rows.filter((r) => r.archived_at === null).map((r) => [r.id, r]));

  const found: { match: SearchMatch; rank: number }[] = [];
  for (const row of active.values()) {
    const r = rank(row.name, q, row.code);
    if (r === null) continue;
    const detail = row.code ? `${KIND_LABELS[row.kind]} · ${row.code}` : KIND_LABELS[row.kind];
    found.push({ match: { type: "node", id: row.id, name: row.name, detail }, rank: r });
  }
  for (const m of members) {
    if (m.removed_at !== null) continue;
    const team = m.team_id === null ? null : active.get(m.team_id);
    if (m.team_id !== null && !team) continue;
    const r = rank(m.name, q);
    if (r === null) continue;
    found.push({
      match: { type: "person", id: m.id, name: m.name, detail: team ? `In ${team.name}` : "No team", teamId: m.team_id },
      rank: r,
    });
  }
  // Best match first; then teams and other nodes before people, then by name.
  return found
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (a.match.type === b.match.type ? 0 : a.match.type === "node" ? -1 : 1) ||
        a.match.name.localeCompare(b.match.name),
    )
    .slice(0, limit)
    .map(({ match }) => match);
}
