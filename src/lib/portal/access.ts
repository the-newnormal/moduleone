import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cache } from "react";
import { logError } from "@/lib/admin/errors";
import { loadRole, type Role } from "@/lib/dashboard/load";
import { createClient } from "@/lib/supabase/server";

// What the portal offers the signed-in viewer. Decided once per request, on the server, and read by
// both the nav and the tiles, so the two never disagree. A check that fails hides what it guards:
// the portal still renders, just without that item. Hiding is never the only protection: Team
// health redirects members to their check-in, /admin answers non-admins with a 404, and RLS decides
// what every query returns.
export type PortalAccess = {
  role: Role | null;
  // Leaders and hq: the heat-map shows grades, which members never see.
  seesTeamHealth: boolean;
  // The admin grant (member_grants), whatever the role.
  isAdmin: boolean;
};

export async function loadPortalAccess(supabase: SupabaseClient): Promise<PortalAccess> {
  const [role, isAdmin] = await Promise.all([
    loadRole(supabase).catch((error: unknown) => {
      logError("portal role check", error);
      return null;
    }),
    Promise.resolve(supabase.rpc("app_has_grant", { requested: "admin" })).then(
      ({ data, error }) => {
        if (error) logError("portal admin check", error);
        return !error && data === true;
      },
      (error: unknown) => {
        logError("portal admin check", error);
        return false;
      },
    ),
  ]);
  return { role, seesTeamHealth: role === "leader" || role === "hq", isAdmin };
}

// The signed-in viewer's access, once per request: the app bar's nav (in the portal and admin
// layouts) and the portal's tiles share the answer. Callers check the viewer is signed in first.
export const viewerAccess = cache(async (): Promise<PortalAccess> => loadPortalAccess(await createClient()));

export type NavItem = { id: "portal" | "checkin" | "team-health" | "admin"; href: string; label: string };

// The app bar's nav: everyone gets the portal and their check-in (the check-in page explains a login
// that isn't linked to anyone yet); Team health and Admin only for those who may open them.
export function portalNav({ seesTeamHealth, isAdmin }: Pick<PortalAccess, "seesTeamHealth" | "isAdmin">): NavItem[] {
  return [
    { id: "portal", href: "/portal", label: "Portal" },
    { id: "checkin", href: "/portal/checkin", label: "Check-in" },
    ...(seesTeamHealth ? [{ id: "team-health", href: "/portal/dashboard", label: "Team health" } as const] : []),
    ...(isAdmin ? [{ id: "admin", href: "/admin", label: "Admin" } as const] : []),
  ];
}
