import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { type ActionResult, GENERIC_ERROR, logError, NO_PERMISSION } from "./errors";

// Who may use /admin: signed-in holders of the `admin` grant (member_grants, which only the
// project owner changes). Pages call requireAdminPage, server actions call requireAdmin; both
// check on every request (layouts don't re-run on client navigation, and actions are reachable
// by a direct POST). RLS is still the real gate: the client returned here is the signed-in
// user's, never the service role.

export type AdminContext = {
  supabase: SupabaseClient; // the signed-in admin's client; RLS applies
  memberId: string; // the admin's own members.id (the UI never edits this row)
  authUserId: string; // auth.users.id, from the verified claims
};

type AdminCheck =
  | { status: "signed-out" }
  | { status: "not-admin" }
  | { status: "failed" }
  | { status: "admin"; context: AdminContext };

async function checkAdmin(): Promise<AdminCheck> {
  const supabase = await createClient();
  // getClaims verifies the session token; never trust getSession() on the server.
  const { data } = await supabase.auth.getClaims();
  const authUserId = data?.claims?.sub;
  if (typeof authUserId !== "string" || authUserId === "") return { status: "signed-out" };

  const [grant, member] = await Promise.all([
    supabase.rpc("app_has_grant", { requested: "admin" }),
    supabase.rpc("app_current_member_id"),
  ]);
  if (grant.error || member.error) {
    logError("checkAdmin", grant.error ?? member.error);
    return { status: "failed" };
  }
  // A grant belongs to a member row, so an admin always has one; check anyway.
  if (grant.data !== true || typeof member.data !== "string") return { status: "not-admin" };
  return { status: "admin", context: { supabase, memberId: member.data, authUserId } };
}

// Once per request: the layout and the page share the answer (and the client).
const checkAdminOnce = cache(checkAdmin);

// For admin pages and layouts: the signed-in admin, or else redirect a signed-out visitor to
// /login?next=<next> and show everyone else a 404 (so /admin doesn't reveal it exists). Call it
// at the top of every page under /admin, not only in the layout. `next` is this page's path.
export async function requireAdminPage(next: string): Promise<AdminContext> {
  const check = await checkAdminOnce();
  if (check.status === "signed-out") redirect(`/login?next=${encodeURIComponent(next)}`);
  if (check.status === "failed") throw new Error("Couldn't check admin access.");
  if (check.status !== "admin") notFound();
  return check.context;
}

// For the admin layout: like requireAdminPage, but when the check itself fails it returns null
// instead of throwing. An error.tsx doesn't cover the layout of its own segment, so a throw here
// would skip src/app/admin/error.tsx; the page's own requireAdminPage throws the same answer
// (cached) inside it instead.
export async function requireAdminLayout(next: string): Promise<AdminContext | null> {
  const check = await checkAdminOnce();
  if (check.status === "failed") return null;
  return requireAdminPage(next);
}

// For generateMetadata: the signed-in admin, or null for anyone else (never redirects or throws;
// the page does that), so a page's title can't show a non-admin anything.
export async function adminForMetadata(): Promise<AdminContext | null> {
  const check = await checkAdminOnce();
  return check.status === "admin" ? check.context : null;
}

// For server actions, before validating input or writing anything:
//   const admin = await requireAdmin();
//   if (!admin.ok) return admin;
//   const { supabase, memberId } = admin.value;
// Refuses anyone who isn't a signed-in admin with "You don't have permission to do that."
export async function requireAdmin(): Promise<ActionResult<AdminContext>> {
  const check = await checkAdmin();
  if (check.status === "admin") return { ok: true, value: check.context };
  return { ok: false, error: check.status === "failed" ? GENERIC_ERROR : NO_PERMISSION };
}
