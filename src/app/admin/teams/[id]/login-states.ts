import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logError } from "@/lib/admin/errors";
import { readAll } from "@/lib/admin/read-all";
import type { LoginRow, LoginStates } from "./team-view";

const STATES: ReadonlySet<string> = new Set(["invited", "ready", "active"]);

const isLoginRow = (row: unknown): row is LoginRow => {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  const at = (v: unknown) => v === null || typeof v === "string";
  return typeof r.member_id === "string" && STATES.has(r.state as string) && at(r.invited_at) && at(r.last_sign_in_at);
};

// Whether each login has been used (admin_login_states, 0010), read as the signed-in admin, and
// when. Null when it couldn't be read, such as before that migration is applied: the admin pages
// then still load, and each row just says the person has a login.
export async function readLoginStates(supabase: SupabaseClient): Promise<LoginStates> {
  const readAt = new Date().toISOString();
  const result = await readAll((from, to) =>
    supabase.rpc("admin_login_states").order("member_id").range(from, to),
  );
  if (result.error) {
    logError("read login states", result.error);
    return null;
  }
  const rows = result.data as unknown[];
  if (!rows.every(isLoginRow)) {
    logError("read login states", { code: "unexpected_row" });
    return null;
  }
  return { rows, readAt };
}
