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
  EMAIL_FORMAT,
  EMAIL_HOLDS_GRANTS,
  EMAIL_IN_USE,
  EMAIL_MASTER_ADMIN,
  EMAIL_NEEDS_SERVICE_KEY,
  EMAIL_NEEDS_SITE_URL,
  EMAIL_NOT_RESTORED,
  EMAIL_NOT_YOURSELF,
  EMAIL_ORGANISATION,
  EMAIL_RACE,
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
  ORGANISATION_OWNER_ONLY,
  PERSON_CHANGED,
  PERSON_GONE,
  PERSON_REMOVED,
  PICK_ROLE,
  REMOVE_NEEDS_SERVICE_KEY,
  TOO_MANY_EMAILS,
} from "./messages";

// The team page's writes about people: who is in the team, their role, who else leads it, their
// login, and removing them from Module One. (Its Edit uses updateNode from the Structure page's
// actions.) Each one checks the admin grant first (requireAdmin), then its input, and writes with
// the signed-in admin's own client, so RLS decides (0002/0003/0009: admins edit members other than
// hq rows, themselves and removed people, and team_leads for anyone but themselves); removePerson
// calls admin_remove_member (0009), which checks everything itself. giveLogin, resendInvite,
// changeEmail and removePerson's last step are the only code here that uses the service-role
// client (see below), each after checking as the admin first. Messages: the database's own
// sentences as they are, everything else through toUserMessage. Every change revalidates the pages
// that show people and leads (revalidateTeamTree).

const OK: ActionResult = { ok: true, value: null };

type Supabase = Extract<Awaited<ReturnType<typeof requireAdmin>>, { ok: true }>["value"]["supabase"];

// The organisation node (migration 0006): its id, or null before there is one, and whether a team id
// a client sent is it (in any letter case, as Postgres reads uuids). Whoever sits in it or leads it
// sees every division's check-ins, so only the project owner decides either: the pages offer none
// of it, and these actions refuse it too, whatever a client sends.
type Organisation = { id: string | null; is: (teamId: string | null) => boolean };

async function organisation(supabase: Supabase, context: string): Promise<ActionResult<Organisation>> {
  const { data, error } = await supabase.from("teams").select("id").eq("kind", "organisation").limit(1);
  if (error) return fail(toUserMessage(error, context));
  const id = (data as { id: string }[] | null)?.[0]?.id.toLowerCase() ?? null;
  return { ok: true, value: { id, is: (teamId) => id !== null && teamId?.toLowerCase() === id } };
}

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
  const org = await organisation(admin.value.supabase, "addMember");
  if (!org.ok) return org;
  if (org.value.is(teamId) || org.value.is(fromTeamId)) return fail(ORGANISATION_OWNER_ONLY);

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
  const org = await organisation(admin.value.supabase, "createMember");
  if (!org.ok) return org;
  if (org.value.is(teamId)) return fail(ORGANISATION_OWNER_ONLY);

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

// Take someone out of this team (team_id = null). They stay in Module One (removePerson takes them
// out of it); their check-ins stay with the team they were made in.
export async function removeFromTeam(teamId: string, memberId: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.ok) return admin;

  if (!isUuid(teamId) || !isUuid(memberId)) return fail(BAD_REQUEST);
  const org = await organisation(admin.value.supabase, "removeFromTeam");
  if (!org.ok) return org;
  if (org.value.is(teamId)) return fail(ORGANISATION_OWNER_ONLY);

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
  const org = await organisation(admin.value.supabase, "setRole");
  if (!org.ok) return org;
  if (org.value.id !== null) {
    const sits = await admin.value.supabase.from("members").select("team_id").eq("id", memberId).maybeSingle();
    if (sits.error) return fail(toUserMessage(sits.error, "setRole"));
    if (org.value.is((sits.data as { team_id: string | null } | null)?.team_id ?? null)) return fail(ORGANISATION_OWNER_ONLY);
  }

  // The same rule in the write itself: someone moved into the organisation since the read above
  // matches no row, so nothing changes.
  let update = admin.value.supabase.from("members").update({ role }).eq("id", memberId);
  if (org.value.id !== null) update = update.or(`team_id.is.null,team_id.neq.${org.value.id}`);
  const { data, error } = await update.select("id");
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

  const org = await organisation(admin.value.supabase, "addLead");
  if (!org.ok) return org;
  if (org.value.is(teamId)) return fail(ORGANISATION_OWNER_ONLY);

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
  const org = await organisation(admin.value.supabase, "removeLead");
  if (!org.ok) return org;
  if (org.value.is(teamId)) return fail(ORGANISATION_OWNER_ONLY);

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

// The service-role client, or the sentence to show when there's none (`missing`: what the action
// can't do without the key; the default says logins can't be given).
function serviceClient(context: string, missing?: string): ActionResult<ServiceClient> {
  try {
    return { ok: true, value: createServiceRoleClient() };
  } catch (error) {
    if (error instanceof MissingServiceKeyError) return fail(missing ?? error.message);
    logError(`${context} client`, error);
    return fail(GENERIC_ERROR);
  }
}

// The sentence for a failed invite (Auth's error codes and statuses).
function inviteFailure(context: string, error: { code?: string; status?: number }, taken: string): string {
  const { code, status } = error;
  if (code === "email_address_not_authorized") return NO_EMAIL_SENDER;
  // An address parseEmail lets through but Auth's stricter check doesn't (a non-ASCII local part).
  if (code === "validation_failed") return EMAIL_FORMAT;
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
async function discardLogin(service: ServiceClient, authUserId: string, createdHere: boolean, context = "giveLogin") {
  if (!createdHere) return;
  const linked = await service.from("members").select("id").eq("auth_user_id", authUserId).limit(1);
  if (linked.error || !linked.data || linked.data.length > 0) {
    if (linked.error) logError(`${context} cleanup check`, linked.error);
    return;
  }
  const { error } = await service.auth.admin.deleteUser(authUserId);
  if (error) logError(`${context} cleanup`, error);
}

// Give a member a login: invite the email (Supabase sends the invite mail) and link the new login
// to the member row, recording which admin did it and when. Uses the service-role client, which
// bypasses RLS, so everything it does is first checked as the signed-in admin:
//   1. the caller is a signed-in admin (nothing below runs otherwise);
//   2. the input is a uuid and an email address;
//   3. as the admin (RLS): the member exists and wasn't removed, isn't a Master Admin, has no login,
//      isn't the caller, and holds no grants (a new login would get them; grants are the project
//      owner's);
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
    .select("id, role, auth_user_id, removed_at")
    .eq("id", memberId)
    .maybeSingle();
  if (loadError) return fail(toUserMessage(loadError, "giveLogin load"));
  const row = member as { id: string; role: string; auth_user_id: string | null; removed_at: string | null } | null;
  if (!row) return fail(PERSON_GONE);
  // The database refuses a login on a removed row too (members_removed_cleared).
  if (row.removed_at !== null) return fail(PERSON_REMOVED);
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
  // A re-sent login that a removal unlinked and is about to delete (removed_login_id) belongs to
  // nobody any more: don't link it here, where the deletion would leave this row a dead login.
  if (!createdHere) {
    const pending = await service.from("members").select("id").eq("removed_login_id", authUserId).limit(1);
    if (pending.error) {
      logError("giveLogin pending check", pending.error);
      return fail(GENERIC_ERROR);
    }
    if ((pending.data ?? []).length > 0) return fail(EMAIL_TAKEN);
  }

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
    .is("removed_at", null)
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
    const unlink = () =>
      service
        .from("members")
        .update({ auth_user_id: null, login_given_by: null, login_given_at: null })
        .eq("id", row.id)
        .eq("auth_user_id", authUserId);
    let { error: unlinkError } = await unlink();
    if (unlinkError) {
      logError("giveLogin unlink", unlinkError);
      ({ error: unlinkError } = await unlink());
    }
    if (unlinkError) {
      // Still linked to a row that now holds a grant or a profile: delete the login itself, even
      // one this invite only re-sent, since leaving it is worse. members.auth_user_id is
      // `on delete set null`, so that unlinks the row too.
      logError("giveLogin unlink retry", unlinkError);
      const { error } = await service.auth.admin.deleteUser(authUserId);
      if (error) logError("giveLogin cleanup", error);
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
//   3. as the admin (RLS): the member exists and wasn't removed, isn't a Master Admin or the
//      caller, and has a login that was given in Module One (login_given_at);
//   4. service role: that login hasn't been used (no confirmed email, never signed in);
//   5. service role: invite its address again (the link goes to Supabase Auth's Site URL +
//      /auth/callback, as for giveLogin).
// The address never leaves the server; logs carry codes and statuses only. Each row says when its
// invite went out (admin_login_states, 0010), which Supabase restamps, so the pages that list
// people are revalidated once the invite has gone.
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
    .select("id, role, auth_user_id, login_given_at, removed_at")
    .eq("id", memberId)
    .maybeSingle();
  if (loadError) return fail(toUserMessage(loadError, "resendInvite load"));
  const row = member as {
    id: string;
    role: string;
    auth_user_id: string | null;
    login_given_at: string | null;
    removed_at: string | null;
  } | null;
  if (!row) return fail(PERSON_GONE);
  if (row.removed_at !== null) return fail(PERSON_REMOVED);
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
  const invitedAt = Date.now();
  const invite = await service.auth.admin.inviteUserByEmail(user.email, { redirectTo });
  // A 422 here means the address signed in meanwhile.
  if (invite.error) return fail(inviteFailure("resendInvite", invite.error, INVITE_USED));
  if (invite.data.user?.id !== row.auth_user_id) {
    // The address left this login meanwhile (its email was changed, or it was removed and deleted),
    // so the invite made a new login for it: delete that one, which no member row uses.
    logError("resendInvite invite", { code: "other_user" });
    const other = invite.data.user;
    if (other?.id) {
      const createdAt = Date.parse(other.created_at ?? "");
      await discardLogin(service, other.id, Number.isFinite(createdAt) && createdAt >= invitedAt, "resendInvite");
    }
    return fail(GENERIC_ERROR);
  }
  revalidateTeamTree();
  return OK;
}

// ---------- removing someone from Module One ----------

export type Removal = {
  // removed: kept, marked removed, because something refers to them (check-ins and the like, or a
  // login now or before); deleted: they had nothing, so the row is gone.
  outcome: "removed" | "deleted";
  // Their login wasn't fully cleaned up: it couldn't be deleted, or a row given it meanwhile
  // couldn't be unlinked. It opens nothing either way (it belongs to no member, or is deleted), and
  // members.removed_login_id still names it, for the project owner to finish.
  loginKept: boolean;
};

// What admin_remove_member returns, or null if it isn't that.
function asRemoval(data: unknown): { outcome: Removal["outcome"]; loginId: string | null } | null {
  const value = asRecord(data);
  const outcome = value.outcome;
  const loginId = value.login_id ?? null;
  if (outcome !== "removed" && outcome !== "deleted") return null;
  if (loginId !== null && !isUuid(loginId)) return null;
  return { outcome, loginId };
}

// Delete the login a removal unlinked: a soft delete, which ends every session and frees the
// address but keeps the auth.users row, so the privacy-notice acceptances it gave stay with what
// was recorded. Not when a member row uses it again (giveLogin re-sends a pending invite to the
// same login, so another member may have been given it meanwhile): then it's theirs. Clears
// removed_login_id once the login is dealt with. False if it's still there.
async function closeLogin(service: ServiceClient, memberId: string, loginId: string): Promise<boolean> {
  if ((await softDeleteLogin(service, loginId, "removePerson", "login")) === "failed") return false;
  const cleared = await service
    .from("members")
    .update({ removed_login_id: null })
    .eq("id", memberId)
    .eq("removed_login_id", loginId);
  // The login is gone either way; the column only says it was still to do.
  if (cleared.error) logError("removePerson clear", cleared.error);
  return true;
}

// Remove someone from Module One: they can't sign in any more, they leave their team and anything
// they lead, and these pages stop showing them; what they left behind stays (their check-ins stay
// with the teams they were made in). Someone who never had a login and left nothing is deleted.
//   1. the caller is a signed-in admin; 2. the id is a uuid;
//   3. as the admin (RLS): if the person has a login, or one still to delete, the service-role
//      client must be available, or nothing changes;
//   4. as the admin: admin_remove_member (0009) refuses Master Admins, the caller, grant holders
//      and the organisation's people in its own words, then marks the row removed and unlinks its
//      login (or deletes the row), and returns the login it unlinked;
//   5. service role: delete that login (closeLogin);
//   6. refresh the pages.
export async function removePerson(memberId: string): Promise<ActionResult<Removal>> {
  // 1.
  const admin = await requireAdmin();
  if (!admin.ok) return admin;
  const { supabase } = admin.value;

  // 2.
  if (!isUuid(memberId)) return fail(BAD_REQUEST);
  const id = memberId.toLowerCase();

  // 3.
  const { data: member, error: loadError } = await supabase
    .from("members")
    .select("auth_user_id, removed_login_id")
    .eq("id", id)
    .maybeSingle();
  if (loadError) return fail(toUserMessage(loadError, "removePerson load"));
  const row = member as { auth_user_id: string | null; removed_login_id: string | null } | null;
  let service: ServiceClient | null = null;
  if (row && (row.auth_user_id !== null || row.removed_login_id !== null)) {
    const client = serviceClient("removePerson", REMOVE_NEEDS_SERVICE_KEY);
    if (!client.ok) return client;
    service = client.value;
  }

  // 4.
  const { data, error } = await supabase.rpc("admin_remove_member", { p_member_id: id });
  if (error) return fail(toUserMessage(error, "removePerson"));
  const removal = asRemoval(data);
  if (!removal) {
    logError("removePerson", { code: "bad_result" });
    return fail(GENERIC_ERROR);
  }

  // 5. (A login given after step 3 read the row still needs the client.)
  let loginKept = false;
  if (removal.loginId !== null) {
    if (!service) {
      const client = serviceClient("removePerson");
      if (client.ok) service = client.value;
    }
    loginKept = service === null || !(await closeLogin(service, id, removal.loginId));
  }

  // 6.
  revalidateTeamTree();
  return { ok: true, value: { outcome: removal.outcome, loginKept } };
}

// ---------- changing someone's sign-in email ----------

export type EmailChange = {
  // The login hadn't been used, so the new address got an invite (the old one no longer works).
  // Otherwise nobody was emailed: they sign in with the new address from now on.
  invited: boolean;
};

type StillChangeable = "ok" | "gone" | "hq" | "grants" | "organisation" | "unknown";

// Whether the person may still have their email changed, as the service role sees them after the
// change: the owner gives grants, makes people hq and staffs the organisation outside this action,
// and another admin may have removed them or changed their login meanwhile. "gone": not this
// login's person any more.
async function stillChangeable(service: ServiceClient, memberId: string, loginId: string): Promise<StillChangeable> {
  const [member, grants, org] = await Promise.all([
    service.from("members").select("role, team_id, auth_user_id, removed_at").eq("id", memberId).maybeSingle(),
    service.from("member_grants").select("grant_name").eq("member_id", memberId).limit(1),
    service.from("teams").select("id").eq("kind", "organisation").limit(1),
  ]);
  const failed = member.error ?? grants.error ?? org.error;
  if (failed) {
    logError("changeEmail late check", failed);
    return "unknown";
  }
  const row = member.data as { role: string; team_id: string | null; auth_user_id: string | null; removed_at: string | null } | null;
  if (!row || row.removed_at !== null || row.auth_user_id !== loginId) return "gone";
  if (row.role === "hq") return "hq";
  if ((grants.data ?? []).length > 0) return "grants";
  const orgId = (org.data as { id: string }[] | null)?.[0]?.id ?? null;
  if (orgId !== null) {
    if (row.team_id === orgId) return "organisation";
    const leads = await service.from("team_leads").select("member_id").eq("team_id", orgId).eq("member_id", memberId).limit(1);
    if (leads.error) {
      logError("changeEmail late check", leads.error);
      return "unknown";
    }
    if ((leads.data ?? []).length > 0) return "organisation";
  }
  return "ok";
}

const STILL_REFUSAL: Record<Exclude<StillChangeable, "ok">, string> = {
  gone: EMAIL_RACE,
  hq: EMAIL_MASTER_ADMIN,
  grants: EMAIL_HOLDS_GRANTS,
  organisation: EMAIL_ORGANISATION,
  unknown: GENERIC_ERROR,
};

type EmailChangeRow = {
  id: string;
  login_given_by: string | null;
  login_given_at: string | null;
  login_email_changed_by: string | null;
  login_email_changed_at: string | null;
};

// Change the address someone signs in with, by an admin's decision at any time, whether or not
// they've used their login (the project owner accepted that an admin could point someone's login
// at an address of their own). Never a Master Admin's, the caller's own, a grant holder's, or that
// of someone who sits in or leads the organisation: those logins see more than an admin does, so
// they stay the project owner's. Uses the service-role client, so everything is first checked as
// the signed-in admin:
//   1. the caller is a signed-in admin; 2. a uuid and an email address;
//   3. as the admin (RLS): the person exists and wasn't removed, isn't the caller or a Master
//      Admin, has a login, holds no grants, and doesn't sit in or lead the organisation;
//   4. service role: their login exists and isn't being deleted, and no login has the new address
//      (theirs included: the answer doesn't say whose, so it never confirms someone's address);
//   5. a login they've used (moveUsedLogin) gets the new address in place; one they haven't
//      (replaceUnusedLogin) is replaced by a new login invited at the new address;
//   6. both check again afterwards (stillChangeable) and undo the change if anything in 3 stopped
//      holding; both record who changed it and when (login_email_changed_by / _at);
//   7. refresh the pages (the row says who changed it).
// The current address never leaves the server, and logs carry codes and statuses only.
export async function changeEmail(memberId: string, email: string): Promise<ActionResult<EmailChange>> {
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
    .select(
      "id, role, team_id, auth_user_id, removed_at, login_given_by, login_given_at, login_email_changed_by, login_email_changed_at",
    )
    .eq("id", memberId)
    .maybeSingle();
  if (loadError) return fail(toUserMessage(loadError, "changeEmail load"));
  const row = member as
    | (EmailChangeRow & { role: string; team_id: string | null; auth_user_id: string | null; removed_at: string | null })
    | null;
  if (!row) return fail(PERSON_GONE);
  if (row.removed_at !== null) return fail(PERSON_REMOVED);
  if (row.id === adminMemberId) return fail(EMAIL_NOT_YOURSELF);
  if (row.role === "hq") return fail(EMAIL_MASTER_ADMIN);
  if (row.auth_user_id === null) return fail(NO_LOGIN_YET);
  const loginId = row.auth_user_id;
  const grants = await supabase.from("member_grants").select("grant_name").eq("member_id", row.id).limit(1);
  if (grants.error) return fail(toUserMessage(grants.error, "changeEmail grants"));
  if ((grants.data ?? []).length > 0) return fail(EMAIL_HOLDS_GRANTS);
  const org = await organisation(supabase, "changeEmail");
  if (!org.ok) return org;
  if (org.value.id !== null) {
    if (org.value.is(row.team_id)) return fail(EMAIL_ORGANISATION);
    const leads = await supabase
      .from("team_leads")
      .select("member_id")
      .eq("team_id", org.value.id)
      .eq("member_id", row.id)
      .limit(1);
    if (leads.error) return fail(toUserMessage(leads.error, "changeEmail leads"));
    if ((leads.data ?? []).length > 0) return fail(EMAIL_ORGANISATION);
  }

  // 4.
  const client = serviceClient("changeEmail", EMAIL_NEEDS_SERVICE_KEY);
  if (!client.ok) return client;
  const service = client.value;
  const found = await service.auth.admin.getUserById(loginId);
  if (found.error) {
    if (found.error.status === 404) return fail(EMAIL_RACE);
    logError("changeEmail lookup", found.error);
    return fail(GENERIC_ERROR);
  }
  const user = found.data.user;
  // A soft-deleted login: a removal is under way, and owns it.
  if (user.deleted_at) return fail(PERSON_REMOVED);
  const inUse = await service.rpc("login_email_in_use", { p_email: address.value });
  if (inUse.error) {
    logError("changeEmail in use", inUse.error);
    return fail(GENERIC_ERROR);
  }
  if (inUse.data !== false) return fail(EMAIL_IN_USE);

  // 5.–6. Used: they've confirmed the address or signed in (as resendInvite decides).
  const result = user.email_confirmed_at || user.last_sign_in_at
    ? await moveUsedLogin(service, row, loginId, user.email ?? null, address.value, adminMemberId)
    : await replaceUnusedLogin(service, row, loginId, address.value, adminMemberId);
  if (!result.ok) return result;

  // 7.
  revalidateTeamTree();
  return result;
}

// A login they've used: change its address in place, confirmed, so they keep their sessions and
// the privacy notice they accepted, and their next sign-in link goes to the new address. Auth
// sends nobody an email about it. Who changed it is recorded first, so the change is never made
// without that record (and the record is taken back if the change is). If they can't have it
// changed any more (6), the old address goes back, confirmed again: that also voids any link sent
// meanwhile.
async function moveUsedLogin(
  service: ServiceClient,
  row: EmailChangeRow,
  loginId: string,
  oldEmail: string | null,
  email: string,
  adminMemberId: string,
): Promise<ActionResult<EmailChange>> {
  const changedAt = new Date().toISOString();
  const recorded = await service
    .from("members")
    .update({ login_email_changed_by: adminMemberId, login_email_changed_at: changedAt })
    .eq("id", row.id)
    .eq("auth_user_id", loginId)
    .is("removed_at", null)
    .neq("role", "hq")
    .select("id");
  if (recorded.error) {
    logError("changeEmail record", recorded.error);
    return fail(GENERIC_ERROR);
  }
  if (!recorded.data || recorded.data.length === 0) return fail(EMAIL_RACE);
  const unrecord = async () => {
    const { error } = await service
      .from("members")
      .update({ login_email_changed_by: row.login_email_changed_by, login_email_changed_at: row.login_email_changed_at })
      .eq("id", row.id)
      .eq("login_email_changed_at", changedAt);
    if (error) logError("changeEmail unrecord", error);
  };
  // Put the old address back. Not when the login has another address than the one set here by
  // now (another admin changed it since, and that change stands): then there's nothing of this
  // change left to undo. `current`: the login as just read, if it was.
  const restore = async (current?: { email?: string } | null): Promise<boolean> => {
    if (!oldEmail) return false;
    if (current === undefined) {
      const now = await service.auth.admin.getUserById(loginId);
      if (now.error) logError("changeEmail recheck", now.error);
      current = now.error ? null : now.data.user;
    }
    if (current && (current.email ?? "").toLowerCase() !== email) return true;
    const { error } = await service.auth.admin.updateUserById(loginId, { email: oldEmail, email_confirm: true });
    if (error) logError("changeEmail restore", error);
    return !error;
  };

  const update = await service.auth.admin.updateUserById(loginId, { email, email_confirm: true });
  if (update.error) {
    await unrecord();
    if (update.error.code === "validation_failed") return fail(EMAIL_FORMAT);
    if (update.error.code === "email_exists" || update.error.status === 422) return fail(EMAIL_IN_USE);
    logError("changeEmail update", update.error);
    return fail(GENERIC_ERROR);
  }

  const still = await stillChangeable(service, row.id, loginId);
  if (still === "ok") return { ok: true, value: { invited: false } };

  if (still === "gone") {
    // The login left this row meanwhile. A removal that's deleting it owns it (deleting it frees
    // the address); one deleted already, under this change, gets an unusable address so the new
    // one is free again. Anyone else's (the owner relinked or unlinked it by hand) mustn't keep an
    // address an admin chose for this person: put the old one back.
    if (await removalOwns(service, loginId)) return fail(EMAIL_RACE);
    const now = await service.auth.admin.getUserById(loginId);
    if (!now.error && now.data.user.deleted_at) {
      const freed = await service.auth.admin.updateUserById(loginId, { email: `${loginId}@deleted.invalid` });
      if (freed.error) logError("changeEmail free", freed.error);
      return fail(EMAIL_RACE);
    }
    if (now.error) logError("changeEmail recheck", now.error);
    if (!(await restore(now.error ? null : now.data.user))) return fail(EMAIL_NOT_RESTORED);
    await unrecord();
    return fail(EMAIL_RACE);
  }

  if (!(await restore())) return fail(EMAIL_NOT_RESTORED);
  await unrecord();
  return fail(STILL_REFUSAL[still]);
}

// Whether a removal unlinked this login and is deleting it (removed_login_id). Unsure counts as no:
// putting an old address back on a login that's being deleted does no harm.
async function removalOwns(service: ServiceClient, loginId: string): Promise<boolean> {
  const pending = await service.from("members").select("id").eq("removed_login_id", loginId).limit(1);
  if (pending.error) {
    logError("changeEmail removal check", pending.error);
    return false;
  }
  return (pending.data ?? []).length > 0;
}

// A login they haven't used yet: invite the new address (a new login), link it to the person in
// place of the old one, then delete the old one, so its invite link stops working. Nothing changes
// if the invite fails. If they can't have it changed any more (6), link the old login again and
// delete the new one (when this invite made it).
async function replaceUnusedLogin(
  service: ServiceClient,
  row: EmailChangeRow,
  loginId: string,
  email: string,
  adminMemberId: string,
): Promise<ActionResult<EmailChange>> {
  const site = siteUrl();
  if (!site) return fail(EMAIL_NEEDS_SITE_URL);
  const redirectTo = new URL("/auth/callback?next=/portal", site).toString();
  const invitedAt = Date.now();
  const invite = await service.auth.admin.inviteUserByEmail(email, { redirectTo });
  if (invite.error) return fail(inviteFailure("changeEmail", invite.error, EMAIL_IN_USE));
  const newLogin = invite.data.user?.id;
  if (!newLogin) {
    logError("changeEmail invite", { code: "no_user" });
    return fail(GENERIC_ERROR);
  }
  const createdAt = Date.parse(invite.data.user?.created_at ?? "");
  const createdHere = Number.isFinite(createdAt) && createdAt >= invitedAt;
  if (newLogin === loginId) {
    // Their own login has the new address already (changed by someone else meanwhile).
    logError("changeEmail invite", { code: "same_user" });
    return fail(EMAIL_RACE);
  }

  // A login not given in Module One (made in the dashboard) is given here now, so it can be
  // re-sent like any other.
  const now = new Date().toISOString();
  const given = row.login_given_at === null ? { login_given_by: adminMemberId, login_given_at: now } : {};
  const { data: linked, error: linkError } = await service
    .from("members")
    .update({ auth_user_id: newLogin, login_email_changed_by: adminMemberId, login_email_changed_at: now, ...given })
    .eq("id", row.id)
    .eq("auth_user_id", loginId)
    .is("removed_at", null)
    .neq("role", "hq")
    .select("id");
  if (linkError) {
    await discardLogin(service, newLogin, createdHere, "changeEmail");
    // The address belongs to another member's login that hasn't been used yet.
    if (linkError.code === "23505" && (linkError.message ?? "").includes("auth_user_id")) return fail(EMAIL_IN_USE);
    logError("changeEmail link", linkError);
    return fail(GENERIC_ERROR);
  }
  if (!linked || linked.length === 0) {
    await discardLogin(service, newLogin, createdHere, "changeEmail");
    return fail(EMAIL_RACE);
  }

  const still = await stillChangeable(service, row.id, newLogin);
  if (still !== "ok") {
    if (still !== "gone") {
      const { error: backError } = await service
        .from("members")
        .update({
          auth_user_id: loginId,
          login_given_by: row.login_given_by,
          login_given_at: row.login_given_at,
          login_email_changed_by: row.login_email_changed_by,
          login_email_changed_at: row.login_email_changed_at,
        })
        .eq("id", row.id)
        .eq("auth_user_id", newLogin);
      if (backError) {
        // Still linked to a row that now holds a grant or sees more: delete the new login itself,
        // even one this invite only re-sent (the foreign key unlinks the row).
        logError("changeEmail unlink", backError);
        const { error } = await service.auth.admin.deleteUser(newLogin);
        if (error) logError("changeEmail cleanup", error);
        return fail(GENERIC_ERROR);
      }
    }
    await discardLogin(service, newLogin, createdHere, "changeEmail");
    // "gone": the old login was unlinked above and nothing took it back, so it goes too.
    if (still === "gone") await deleteUnusedLogin(service, loginId);
    return fail(STILL_REFUSAL[still]);
  }

  await deleteUnusedLogin(service, loginId);
  return { ok: true, value: { invited: true } };
}

// A login replaced before it was ever used: linked to nobody now (checked), so it goes, and its
// invite link stops working. If deleting it fails, it opens nothing (no member row), but its
// address stays taken.
async function deleteUnusedLogin(service: ServiceClient, loginId: string) {
  await softDeleteLogin(service, loginId, "changeEmail", "old login");
}

// Soft-delete a login that no member row uses: every session ends and the address is freed, but
// the auth.users row stays, so any privacy-notice acceptances it gave stay with what was recorded.
// "linked": a row uses it, so it stays. A row given it between the check and the delete (giveLogin
// re-sends a pending invite to the same login, and links what comes back) would be left holding a
// dead login: unlink it, so it reads "No login yet" and can be given a login again. Logs as
// "<context> <noun> check" / "<context> <noun>" / "<context> relink check".
async function softDeleteLogin(
  service: ServiceClient,
  loginId: string,
  context: string,
  noun: string,
): Promise<"deleted" | "linked" | "failed"> {
  const linked = await service.from("members").select("id").eq("auth_user_id", loginId).limit(1);
  if (linked.error) {
    logError(`${context} ${noun} check`, linked.error);
    return "failed";
  }
  if ((linked.data ?? []).length > 0) return "linked";
  const { error } = await service.auth.admin.deleteUser(loginId, true);
  // 404: deleted already (in the dashboard, or by an earlier try).
  if (error && error.status !== 404) {
    logError(`${context} ${noun}`, error);
    return "failed";
  }
  const given = await service
    .from("members")
    .update({ auth_user_id: null, login_given_by: null, login_given_at: null })
    .eq("auth_user_id", loginId);
  if (given.error) {
    // A row may still hold the deleted login: not done, so a removal keeps removed_login_id (and
    // says the login is still to sort out) rather than forgetting it.
    logError(`${context} relink check`, given.error);
    return "failed";
  }
  return "deleted";
}
