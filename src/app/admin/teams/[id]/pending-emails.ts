import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logError } from "@/lib/admin/errors";
import { readAll } from "@/lib/admin/read-all";
import type { PendingEmailRow, PendingEmails } from "./team-view";

const isPendingEmailRow = (row: unknown): row is PendingEmailRow => {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return typeof r.member_id === "string" && typeof r.email === "string";
};

// The addresses noted for people's first invites (pending_login_emails, 0014), read as the
// signed-in admin. Null when they couldn't be read, such as before that migration is applied or
// when the call throws: the admin pages then still load, without Set email, and Give login asks
// for the address as before.
export async function readPendingEmails(supabase: SupabaseClient): Promise<PendingEmails> {
  let result: Awaited<ReturnType<typeof readAll<unknown>>>;
  try {
    result = await readAll((from, to) =>
      supabase.from("pending_login_emails").select("member_id, email").order("member_id").range(from, to),
    );
  } catch (error) {
    logError("read pending emails", error);
    return null;
  }
  if (result.error) {
    logError("read pending emails", result.error);
    return null;
  }
  const rows = result.data as unknown[];
  if (!rows.every(isPendingEmailRow)) {
    logError("read pending emails", { code: "unexpected_row" });
    return null;
  }
  return rows;
}
