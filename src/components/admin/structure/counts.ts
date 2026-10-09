import type { TeamRow } from "@/lib/admin/tree";

// A teams row with what the Structure page shows beside it.
export type StructureRow = TeamRow & {
  members: number; // people whose team this is (members.team_id): the ones archiving waits for
  leads: number; // leaders who lead it: leaders placed in it, plus its team_leads rows
};

type MemberRow = { id: string; team_id: string | null; role: string };
type LeadRow = { team_id: string; member_id: string };

// Adds the counts to every teams row. A leader placed in a node leads it; a team_leads row adds
// one more; someone counted both ways counts once.
export function withCounts(
  teams: readonly TeamRow[],
  members: readonly MemberRow[],
  leads: readonly LeadRow[],
): StructureRow[] {
  const people = new Map<string, number>();
  const leaders = new Map<string, Set<string>>();
  const lead = (teamId: string, memberId: string) => {
    const set = leaders.get(teamId) ?? new Set<string>();
    set.add(memberId);
    leaders.set(teamId, set);
  };
  for (const m of members) {
    if (m.team_id === null) continue;
    people.set(m.team_id, (people.get(m.team_id) ?? 0) + 1);
    if (m.role === "leader") lead(m.team_id, m.id);
  }
  for (const l of leads) lead(l.team_id, l.member_id);

  return teams.map((t) => ({ ...t, members: people.get(t.id) ?? 0, leads: leaders.get(t.id)?.size ?? 0 }));
}
