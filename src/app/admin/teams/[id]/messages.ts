// What the team page's server actions say when they refuse before (or instead of) the database.
// They live here because a "use server" file may only export async functions.

import { ROLE_LABELS } from "@/lib/admin/roles";

export const BAD_REQUEST = "That request wasn't valid. Reload the page and try again.";
export const PICK_ROLE = `Pick ${ROLE_LABELS.member} or ${ROLE_LABELS.leader}.`;
export const ALREADY_IN_TEAM = "This person is already in this team.";
// An update that reached no row: someone else changed the person meanwhile (or the request was
// forged for a row RLS hides, such as a Master Admin's).
export const PERSON_CHANGED = "This person changed while you were working. Reload the page and try again.";
export const NOT_IN_TEAM = "This person isn't in this team any more. Reload the page.";

// giveLogin
export const PERSON_GONE = "This person doesn't exist any more. Reload the page.";
export const MASTER_ADMIN_LOGIN = "Master Admins get their login from the project owner.";
export const ALREADY_HAS_LOGIN = "This person already has a login.";
export const NOT_YOURSELF = "You can't give yourself a login.";
// A new login on a row inherits what the row holds, so these stay with the project owner.
export const HOLDS_GRANTS =
  "This person holds grants (such as admin), so only the project owner can give them a login.";
export const EARLIER_LOGIN =
  "This person has check-ins or other records from an earlier login, so only the project owner can give them a new one.";
export const EMAIL_TAKEN = "That email already has a login.";
// Supabase's built-in sender only mails the project's own team; the owner sets up SMTP first.
export const NO_EMAIL_SENDER =
  "Supabase can't email that address yet: the project needs its own email sender (custom SMTP; see \"Before inviting\" in the README).";
export const TOO_MANY_EMAILS = "Too many emails were sent just now. Try again in an hour.";
export const INVITE_RACE = "This person changed while you were inviting them. Reload and try again.";
export const MISSING_SITE_URL =
  "Logins can't be given from this server yet (NEXT_PUBLIC_SITE_URL is not set).";

// resendInvite
export const NO_LOGIN_YET = "This person has no login yet. Use Give login instead.";
export const NOT_GIVEN_HERE = "This login wasn't given in Module One, so its invite can't be re-sent from here.";
export const INVITE_USED =
  "This person has already used their invite, so there's nothing to resend. They sign in at the login page.";

// Every action on a person removed from Module One (migration 0009): the page no longer lists them.
export const PERSON_REMOVED = "This person was removed from Module One. Reload the page.";

// removePerson. (The database words its own refusals: Master Admins, yourself, grants, the
// organisation.)
export const REMOVE_NEEDS_SERVICE_KEY =
  "People with a login can't be removed from this server yet (SUPABASE_SERVICE_ROLE_KEY is not set).";

// changeEmail
export const EMAIL_NEEDS_SERVICE_KEY =
  "Sign-in emails can't be changed from this server yet (SUPABASE_SERVICE_ROLE_KEY is not set).";
export const EMAIL_NEEDS_SITE_URL =
  "This person hasn't used their invite yet, and invites can't be sent from this server yet (NEXT_PUBLIC_SITE_URL is not set).";
export const EMAIL_NOT_YOURSELF = "You can't change your own sign-in email here.";
export const EMAIL_MASTER_ADMIN = "Master Admins' sign-in emails are changed by the project owner.";
export const EMAIL_HOLDS_GRANTS =
  "This person holds grants (such as admin), so only the project owner can change their sign-in email.";
export const EMAIL_ORGANISATION =
  "This person sits in or leads the organisation, so only the project owner can change their sign-in email.";
// The new address already has a login (theirs, or anyone's: the page never says which).
export const EMAIL_IN_USE = "That email already has a login.";
export const EMAIL_RACE = "This person changed while you were changing their email. Reload the page and try again.";
// parseEmail's own sentence, for an address it lets through and Supabase Auth refuses.
export const EMAIL_FORMAT = "Enter an email address like name@example.com.";
// The address was changed, then found not allowed (see the other sentences), and putting the old one
// back failed.
export const EMAIL_NOT_RESTORED =
  "This person can't have their sign-in email changed here any more, and their old address couldn't be put back. Ask the project owner to fix it in Supabase.";

// Every change to who sits in or leads the organisation node (migration 0006)
export const ORGANISATION_OWNER_ONLY = "Only the project owner decides who sits in the organisation and who leads it.";
