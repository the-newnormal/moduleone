"use server";

import { type ActionResult, fail, GENERIC_ERROR, logError, toUserMessage } from "@/lib/admin/errors";
import { revalidateTeamTree } from "@/lib/admin/revalidate";
import { requireAdmin } from "@/lib/admin/session";
import { asRecord, isAssignableRole, isParentId, isUuid, parseEmail, parseName } from "@/lib/admin/validate";
import { createServiceRoleClient, MissingServiceKeyError } from "@/lib/supabase/admin";
import {
  ALREADY_HAS_LOGIN,
  ALREADY_IN_TEAM,
  BAD_REQUEST,
  EARLIER_LOGIN,
  EMAIL_TAKEN,
  HOLDS_GRANTS,
  INVITE_RACE,
  INVITE_USED,
  MASTER_ADMIN_LOGIN,
  MISSING_SITE_URL,
  NO_EMAIL_SENDER,
  NO_LOGIN_YET,
  NOT_GIVEN_HERE,
  NOT_IN_TEAM,
  NOT_YOURSELF,
  PERSON_CHANGED,
  PERSON_GONE,
  PICK_ROLE,
  TOO_MANY_EMAILS,
} from "./messages";

// The team page's writes about people: who is in the team, their role, who else leads it, and
// giving logins. (Its Edit uses updateNode from the Structure page's actions.) Each one checks the
// admin grant first (requireAdmin), then its input, and writes with the signed-in admin's own
// client, so RLS decides (0002/0003: admins edit members other than hq rows and themselves, and
// team_leads for anyone but themselves). The exceptions are giveLogin and resendInvite, the only
// code that uses the service-role client (see below). Messages: the database's own sentences as
// they are, everything else through toUserMessage. Every change revalidates the pages that show
// people and leads (revalidateTeamTree).

const OK: ActionResult = { ok: true, value: null };

// Put an existing member in this team. fromTeamId is the team the page showed them in (null: no
// team); if they've moved since, nothing changes, so nobody is moved without the admin seeing
// where from.
export async function addMember(
  teamId: string,
  memberId: string,
  fromTeamId: string | null,
): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.ok) return admin;

  if (!isUuid(teamId) || !isUuid(memberId) || !isParentId(fromTeamId)) return fail(BAD_REQUEST);
  if (fromTeamId === teamId) return fail(ALREADY_IN_TEAM);

  const move = admin.value.supabase.from("members").update({ team_id: teamId }).eq("id", memberId);
  const { data, error } = await (fromTeamId === null
    ? move.is("team_id", null)
    : move.eq("team_id", fromTeamId)
  ).select("id");
  if (error) return fail(toUserMessage(error, "addMember"));
  if (!data || data.length === 0) return fail(PERSON_CHANGED);

  revalidateTeamTree();
  return OK;
}

export type NewPerson = { name: string; role: string };

// Add someone new to Module One, in this team. They have no login until an admin gives them one.
export async function createMember(teamId: string, person: NewPerson): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.ok) return admin;

  if (!isUuid(teamId)) return fail(BAD_REQUEST);
  const input = asRecord(person);
  const name = parseName(input.name);
  if (!name.ok) return name;
  if (!isAssignableRole(input.role)) return fail(PICK_ROLE);

  const { data, error } = await admin.value.supabase
    .from("members")
    .insert({ name: name.value, team_id: teamId, role: input.role })
    .select("id");
  if (error) return fail(toUserMessage(error, "createMember"));
  if (!data || data.length === 0) {
    logError("createMember", { code: "no_row" });
    return fail(GENERIC_ERROR);
  }

  revalidateTeamTree();
  return OK;
}

// Take someone out of this team (team_id = null). Members are never deleted; their check-ins stay
// with the team they were made in.
export async function removeFromTeam(teamId: string, memberId: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.ok) return admin;

  if (!isUuid(teamId) || !isUuid(memberId)) return fail(BAD_REQUEST);

  const { data, error } = await admin.value.supabase
    .from("members")
    .update({ team_id: null })
    .eq("id", memberId)
    .eq("team_id", teamId)
    .select("id");
  if (error) return fail(toUserMessage(error, "removeFromTeam"));
  if (!data || data.length === 0) return fail(NOT_IN_TEAM);

  revalidateTeamTree();
  return OK;
}

// Make someone a member or a leader (never a Master Admin: RLS refuses that). Demoting a leader
// also removes their team_leads rows; the database does that (0003's members_drop_team_leads).
export async function setRole(memberId: string, role: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.ok) return admin;

  if (!isUuid(memberId)) return fail(BAD_REQUEST);
  if (!isAssignableRole(role)) return fail(PICK_ROLE);

  const { data, error } = await admin.value.supabase
    .from("members")
    .update({ role })
    .eq("id", memberId)
    .select("id");
  if (error) return fail(toUserMessage(error, "setRole"));
  if (!data || data.length === 0) return fail(PERSON_CHANGED);

  revalidateTeamTree();
  return OK;
}

// Let a leader lead this team as well as their own. The database refuses non-leaders and archived
// teams with a sentence, and RLS refuses the admin themselves.
export async function addLead(teamId: string, memberId: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.ok) return admin;

  if (!isUuid(teamId) || !isUuid(memberId)) return fail(BAD_REQUEST);

  const { error } = await admin.value.supabase
    .from("team_leads")
    .insert({ team_id: teamId, member_id: memberId });
  // Already a lead (another admin added them meanwhile): what was asked for is true.
  const duplicate = error?.code === "23505" && (error.message ?? "").includes('"team_leads_pkey"');
  if (error && !duplicate) return fail(toUserMessage(error, "addLead"));

  revalidateTeamTree();
  return OK;
}

// Stop a leader leading this team through team_leads. (Leaders whose own team this is lead it by
// sitting in it; that's changed with their role or team.) A row that's already gone is fine.
export async function removeLead(teamId: string, memberId: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.ok) return admin;

  if (!isUuid(teamId) || !isUuid(memberId)) return fail(BAD_REQUEST);

  const { error } = await admin.value.supabase
    .from("team_leads")
    .delete()
    .eq("team_id", teamId)
    .eq("member_id", memberId);
  if (error) return fail(toUserMessage(error, "removeLead"));

  revalidateTeamTree();
  return OK;
}

// This site's URL, for the invite's redirectTo (<site>/auth/callback; Supabase accepts it only if
// it's in the project's redirect URLs). The link in the invite email itself is built from Supabase
// Auth's Site URL ({{ .SiteURL }} in supabase/templates/invite.html), so NEXT_PUBLIC_SITE_URL must
// match it. Never the request's headers (which a caller controls). Null if it's unset or not an
// http(s) URL.
function siteUrl(): URL | null {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

// The service-role client, or the sentence to show when there's none.
function serviceClient(context: string): ActionResult<ServiceClient> {
  try {
    return { ok: true, value: createServiceRoleClient() };
  } catch (error) {
    if (error instanceof MissingServiceKeyError) return fail(error.message);
    logError(`${context} client`, error);
    return fail(GENERIC_ERROR);
  }
}

// The sentence for a failed invite (Auth's error codes and statuses).
function inviteFailure(context: string, error: { code?: string; status?: number }, taken: string): string {
  const { code, status } = error;
  if (code === "email_address_not_authorized") return NO_EMAIL_SENDER;
  if (code === "email_exists" || status === 422) return taken;
  if (code === "over_email_send_rate_limit" || status === 429) return TOO_MANY_EMAILS;
  logError(`${context} invite`, error);
  return GENERIC_ERROR;
}

// Whether a member row still holds anything from an earlier login (members.auth_user_id is set
// to null when a login is deleted, and nothing else on the row changes): check-ins, a Big Five
// profile, recordings (checkin-audio/<member id>/…). A new login on such a row would read them.
// "found" as soon as one check finds something; otherwise "unknown" when any check fails, which
// counts as a refusal too.
async function earlierLogin(service: ServiceClient, memberId: string): Promise<"none" | "found" | "unknown"> {
  const checks = await Promise.all([
    service.from("checkins").select("id").eq("member_id", memberId).limit(1),
    service.from("member_profiles").select("member_id").eq("member_id", memberId).limit(1),
    service.storage.from("checkin-audio").list(memberId, { limit: 1 }),
  ]);
  if (checks.some((check) => !check.error && (check.data ?? []).length > 0)) return "found";
  const failed = checks.find((check) => check.error);
  if (failed) {
    logError("giveLogin history check", failed.error);
    return "unknown";
  }
  return "none";
}

// Whether a grant or a Big Five profile reached the member row after giveLogin first checked:
// the project owner gives grants in the dashboard and big_five holders write profiles, outside
// this action. (Check-ins and recordings need a login on the row, so they can't appear meanwhile.)
async function lateAccess(service: ServiceClient, memberId: string): Promise<"none" | "grants" | "profile" | "unknown"> {
  const [grants, profile] = await Promise.all([
    service.from("member_grants").select("grant_name").eq("member_id", memberId).limit(1),
    service.from("member_profiles").select("member_id").eq("member_id", memberId).limit(1),
  ]);
  if (!grants.error && (grants.data ?? []).length > 0) return "grants";
  if (!profile.error && (profile.data ?? []).length > 0) return "profile";
  if (grants.error || profile.error) {
    logError("giveLogin late check", grants.error ?? profile.error);
    return "unknown";
  }
  return "none";
}

// After an invite that couldn't be linked to the member: delete the login it made, so the email
// can be used again. Supabase re-sends an invite for an address that was invited but hasn't signed
// in yet, and returns that existing login (another member's, or one the project owner invited in
// the dashboard), so only delete a login this invite created (createdHere), never one some member
// row uses, and not when unsure. A login left behind links to no member row, so it reads nothing.
async function discardLogin(service: ServiceClient, authUserId: string, createdHere: boolean) {
  if (!createdHere) return;
  const linked = await service.from("members").select("id").eq("auth_user_id", authUserId).limit(1);
  if (linked.error || !linked.data || linked.data.length > 0) {
    if (linked.error) logError("giveLogin cleanup check", linked.error);
    return;
  }
  const { error } = await service.auth.admin.deleteUser(authUserId);
  if (error) logError("giveLogin cleanup", error);
}

// Give a member a login: invite the email (Supabase sends the invite mail) and link the new login
// to the member row, recording which admin did it and when. Uses the service-role client, which
// bypasses RLS, so everything it does is first checked as the signed-in admin:
//   1. the caller is a signed-in admin (nothing below runs otherwise);
//   2. the input is a uuid and an email address;
//   3. as the admin (RLS): the member exists, isn't a Master Admin, has no login, isn't the caller,
//      and holds no grants (a new login would get them; grants are the project owner's);
//   4. service role: nothing is left on the row from an earlier login (check-ins, a Big Five
//      profile, recordings), then invite the email (its link goes to Supabase Auth's Site URL +
//      /auth/callback, which NEXT_PUBLIC_SITE_URL must match; see siteUrl);
//   5. service role: link the new login, only if the member still has none and still isn't a
//      Master Admin; if that reaches no row, delete the new login again; then check again that
//      no grant or Big Five profile arrived meanwhile, and undo the link if one did;
//   6. refresh the team pages.
// Logs carry codes and statuses only, never the email.
export async function giveLogin(memberId: string, email: string): Promise<ActionResult> {
  // 1.
  const admin = await requireAdmin();
  if (!admin.ok) return admin;
  const { supabase, memberId: adminMemberId } = admin.value;

  // 2.
  if (!isUuid(memberId)) return fail(BAD_REQUEST);
  const address = parseEmail(email);
  if (!address.ok) return address;

  // 3.
  const { data: member, error: loadError } = await supabase
    .from("members")
    .select("id, role, auth_user_id")
    .eq("id", memberId)
    .maybeSingle();
  if (loadError) return fail(toUserMessage(loadError, "giveLogin load"));
  const row = member as { id: string; role: string; auth_user_id: string | null } | null;
  if (!row) return fail(PERSON_GONE);
  if (row.id === adminMemberId) return fail(NOT_YOURSELF);
  if (row.role === "hq") return fail(MASTER_ADMIN_LOGIN);
  if (row.auth_user_id !== null) return fail(ALREADY_HAS_LOGIN);
  // Admins read every grant (0002's member_grants_select).
  const grants = await supabase.from("member_grants").select("grant_name").eq("member_id", memberId).limit(1);
  if (grants.error) return fail(toUserMessage(grants.error, "giveLogin grants"));
  if ((grants.data ?? []).length > 0) return fail(HOLDS_GRANTS);

  // 4.
  const site = siteUrl();
  if (!site) return fail(MISSING_SITE_URL);
  const client = serviceClient("giveLogin");
  if (!client.ok) return client;
  const service = client.value;

  // The id as the database has it (lower case), not as the request spelled it: recordings live
  // under checkin-audio/<member id>/ and storage listings needn't ignore case.
  const history = await earlierLogin(service, row.id);
  if (history !== "none") return fail(history === "found" ? EARLIER_LOGIN : GENERIC_ERROR);

  const redirectTo = new URL("/auth/callback?next=/portal", site).toString();
  const invitedAt = Date.now();
  const invite = await service.auth.admin.inviteUserByEmail(address.value, { redirectTo });
  if (invite.error) return fail(inviteFailure("giveLogin", invite.error, EMAIL_TAKEN));
  const authUserId = invite.data.user?.id;
  if (!authUserId) {
    logError("giveLogin invite", { code: "no_user" });
    return fail(GENERIC_ERROR);
  }
  // A login made before this invite was re-sent, not created, by it (see discardLogin). With an
  // unknown or skewed clock this errs towards leaving a login in place.
  const createdAt = Date.parse(invite.data.user?.created_at ?? "");
  const createdHere = Number.isFinite(createdAt) && createdAt >= invitedAt;

  // 5.
  const { data: linked, error: linkError } = await service
    .from("members")
    .update({
      auth_user_id: authUserId,
      login_given_by: adminMemberId,
      login_given_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .is("auth_user_id", null)
    .neq("role", "hq")
    .select("id");
  if (linkError) {
    // The address belongs to another member's login that hasn't been used yet.
    if (linkError.code === "23505" && (linkError.message ?? "").includes("auth_user_id")) {
      return fail(EMAIL_TAKEN);
    }
    logError("giveLogin link", linkError);
    await discardLogin(service, authUserId, createdHere);
    return fail(GENERIC_ERROR);
  }
  if (!linked || linked.length === 0) {
    await discardLogin(service, authUserId, createdHere);
    return fail(INVITE_RACE);
  }

  // 5b. Step 3's grant check and step 4's history check ran before the invite. If a grant or a
  // Big Five profile arrived since, undo the link and the new login (when this invite made it).
  // Nobody can sign in with it before opening the invite, so it never reads either.
  const late = await lateAccess(service, row.id);
  if (late !== "none") {
    const { error: unlinkError } = await service
      .from("members")
      .update({ auth_user_id: null, login_given_by: null, login_given_at: null })
      .eq("id", row.id)
      .eq("auth_user_id", authUserId);
    if (unlinkError) {
      logError("giveLogin unlink", unlinkError);
      return fail(GENERIC_ERROR);
    }
    await discardLogin(service, authUserId, createdHere);
    return fail(late === "grants" ? HOLDS_GRANTS : late === "profile" ? EARLIER_LOGIN : GENERIC_ERROR);
  }

  // 6.
  revalidateTeamTree();
  return OK;
}

// Send a new invite to someone whose login was given here but who hasn't used it yet: until they
// do, they can't sign in at /login, and the link lasts an hour. Supabase re-sends the invite for
// an address that hasn't signed in and returns the same login, so nothing is relinked (the old
// link stops working). Checked as the signed-in admin first, like giveLogin:
//   1. the caller is a signed-in admin; 2. the id is a uuid;
//   3. as the admin (RLS): the member exists, isn't a Master Admin or the caller, and has a login
//      that was given in Module One (login_given_at);
//   4. service role: that login hasn't been used (no confirmed email, never signed in);
//   5. service role: invite its address again (the link goes to Supabase Auth's Site URL +
//      /auth/callback, as for giveLogin).
// The address never leaves the server; logs carry codes and statuses only. Nothing on the page
// changes, so nothing is revalidated.
export async function resendInvite(memberId: string): Promise<ActionResult> {
  // 1.
  const admin = await requireAdmin();
  if (!admin.ok) return admin;
  const { supabase, memberId: adminMemberId } = admin.value;

  // 2.
  if (!isUuid(memberId)) return fail(BAD_REQUEST);

  // 3.
  const { data: member, error: loadError } = await supabase
    .from("members")
    .select("id, role, auth_user_id, login_given_at")
    .eq("id", memberId)
    .maybeSingle();
  if (loadError) return fail(toUserMessage(loadError, "resendInvite load"));
  const row = member as { id: string; role: string; auth_user_id: string | null; login_given_at: string | null } | null;
  if (!row) return fail(PERSON_GONE);
  if (row.role === "hq") return fail(MASTER_ADMIN_LOGIN);
  // The admin is signed in, so their own login has been used.
  if (row.id === adminMemberId) return fail(INVITE_USED);
  if (row.auth_user_id === null) return fail(NO_LOGIN_YET);
  if (row.login_given_at === null) return fail(NOT_GIVEN_HERE);

  // 4.
  const site = siteUrl();
  if (!site) return fail(MISSING_SITE_URL);
  const client = serviceClient("resendInvite");
  if (!client.ok) return client;
  const service = client.value;

  const found = await service.auth.admin.getUserById(row.auth_user_id);
  if (found.error) {
    if (found.error.status === 404) return fail(PERSON_CHANGED);
    logError("resendInvite lookup", found.error);
    return fail(GENERIC_ERROR);
  }
  const user = found.data.user;
  if (user.email_confirmed_at || user.last_sign_in_at) return fail(INVITE_USED);
  if (!user.email) {
    logError("resendInvite lookup", { code: "no_email" });
    return fail(GENERIC_ERROR);
  }

  // 5.
  const redirectTo = new URL("/auth/callback?next=/portal", site).toString();
  const invite = await service.auth.admin.inviteUserByEmail(user.email, { redirectTo });
  // A 422 here means the address signed in meanwhile.
  if (invite.error) return fail(inviteFailure("resendInvite", invite.error, INVITE_USED));
  if (invite.data.user?.id !== row.auth_user_id) {
    logError("resendInvite invite", { code: "other_user" });
    return fail(GENERIC_ERROR);
  }
  return OK;
}
