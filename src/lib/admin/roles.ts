// members.role as people read it. The database value 'hq' is the project owner's see-everything
// role, shown as "Master Admin"; it has nothing to do with the HQ division, nor with the admin
// grant (which lets someone edit structure and scoring). Never show the raw value.

export type Role = "member" | "leader" | "hq";

export const ROLE_LABELS: Record<Role, string> = {
  member: "Member",
  leader: "Leader",
  hq: "Master Admin",
};

const ROLES: readonly Role[] = ["member", "leader", "hq"];

// An unexpected role (the database allows only these three) is treated like a Master Admin: shown,
// never editable.
export const asRole = (role: string): Role => (ROLES.includes(role as Role) ? (role as Role) : "hq");

export function roleLabel(role: Role): string {
  return ROLE_LABELS[role] ?? "Unknown role";
}

// Whether an admin's page offers edit controls for a member row. RLS refuses changes to hq rows
// and to the admin's own row (0002), so the page hides them rather than letting the click fail.
export function isEditableMember(
  member: { id: string; role: Role },
  adminMemberId: string,
): boolean {
  return member.role !== "hq" && member.id !== adminMemberId;
}
