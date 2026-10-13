import "server-only";
import { createClient } from "@/lib/supabase/server";

// Who is checking in, for the check-in's server actions (src/app/portal/checkin/actions.ts) and the
// live check-in's routes (src/app/portal/checkin/live): always the member the session belongs to,
// never anyone a request names. Read through RLS (members_select lets a user read their own row).
// In its own server-only module because a "use server" file makes every export a public endpoint.

export type Session = {
  supabase: Awaited<ReturnType<typeof createClient>>;
  authUserId: string;
  member: { id: string; team_id: string | null };
};

export type SessionProblem = "signed_out" | "no_member" | "failed";

export async function sessionMember(): Promise<Session | SessionProblem> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) return "signed_out";
  const { data: member, error } = await supabase
    .from("members")
    .select("id, team_id")
    .eq("auth_user_id", data.claims.sub)
    .maybeSingle();
  if (error) {
    console.error("checkin: reading the member failed", { code: error.code });
    return "failed";
  }
  if (!member) return "no_member";
  return { supabase, authUserId: data.claims.sub, member };
}
