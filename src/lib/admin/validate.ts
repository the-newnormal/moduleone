// Input checks for the admin pages and their server actions. Every server action runs its inputs
// through these before calling Supabase (they arrive from the client and can be anything), and the
// forms use the same functions to show problems before submitting. RLS and the database's own
// constraints (migrations 0001–0003) remain the real gate; these only turn bad input into a clear
// sentence instead of a database error.
//
// parse* functions take `unknown` and return a Parsed<T>: the cleaned value, or a sentence to show.

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (error: string): Parsed<never> => ({ ok: false, error });

// A server action's object argument, to read field by field: anything that isn't an object (null,
// a string, …) reads as {}, so every field is missing and fails its own check.
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

// ---------- enums (the database's check constraints) ----------

export const TEAM_KINDS = ["organisation", "division", "domain", "team"] as const;
export type TeamKind = (typeof TEAM_KINDS)[number];

// The kinds an admin adds. The organisation node (above every division, migration 0006) is made
// once by the migration, never from the app.
export const CREATABLE_KINDS = ["division", "domain", "team"] as const;
export type CreatableKind = (typeof CREATABLE_KINDS)[number];

export const DOMAIN_TYPES = ["development", "ip", "lab"] as const;
export type DomainType = (typeof DOMAIN_TYPES)[number];

export const DIVISION_TYPES = ["strategy", "support_development"] as const;
export type DivisionType = (typeof DIVISION_TYPES)[number];

// The roles an admin can give. Never 'hq' (Master Admin): only the project owner makes one, and
// RLS refuses it anyway.
export const ASSIGNABLE_ROLES = ["member", "leader"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

const isOneOf =
  <T extends string>(values: readonly T[]) =>
  (value: unknown): value is T =>
    typeof value === "string" && (values as readonly string[]).includes(value);

export const isTeamKind = isOneOf(TEAM_KINDS);
export const isCreatableKind = isOneOf(CREATABLE_KINDS);
export const isDomainType = isOneOf(DOMAIN_TYPES);
export const isDivisionType = isOneOf(DIVISION_TYPES);
export const isAssignableRole = isOneOf(ASSIGNABLE_ROLES);

// ---------- ids and positions ----------

// Any RFC 4122-shaped uuid (Postgres accepts every version, and gen_random_uuid() makes v4).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

// A parent for admin_move_team or an insert: a uuid, or null for the top level.
export function isParentId(value: unknown): value is string | null {
  return value === null || isUuid(value);
}

// admin_move_team's p_index: a whole number from 0 to 10000 (the database refuses others, 22023).
export const MAX_INDEX = 10000;

export function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_INDEX;
}

// ---------- text ----------

// Lengths count code points, as Postgres char_length does (an emoji is one character, not two).
const length = (s: string) => [...s].length;

// Control characters (newlines, tabs, NUL, …), Unicode's line and paragraph separators (U+2028,
// U+2029) and invisible format characters (zero-width spaces, direction overrides) don't belong
// in a one-line name, title or code.
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// In a note, line breaks and tabs are fine; other control and format characters aren't.
const CONTROL_OR_FORMAT_EXCEPT_BREAKS = /[^\P{Cc}\n\t]|\p{Cf}/u;

export const NAME_MAX = 120;

// A person's or a team's name: trimmed, 1–120 characters, one line.
export function parseName(value: unknown): Parsed<string> {
  if (typeof value !== "string") return fail("Enter a name.");
  const name = value.trim();
  if (name === "") return fail("Enter a name.");
  if (CONTROL_OR_FORMAT.test(name)) return fail("Names can't contain line breaks or hidden characters.");
  if (length(name) > NAME_MAX) return fail(`Names can be at most ${NAME_MAX} characters.`);
  return ok(name);
}

// 0003's teams_code_format.
export const CODE_RE = /^[A-Z0-9]{1,8}(\.[A-Z0-9]{1,8})?$/;

// A team code like IP.X or IP.1: trimmed and upper-cased; empty means no code (null).
export function parseCode(value: unknown): Parsed<string | null> {
  if (value === null || value === undefined) return ok(null);
  if (typeof value !== "string") return fail("Enter a code like IP.X or IP.1, or leave it empty.");
  const code = value.trim().toUpperCase();
  if (code === "") return ok(null);
  if (!CODE_RE.test(code)) {
    return fail(
      "Codes are 1–8 letters or digits, optionally a dot and 1–8 more, like IP.X or IP.1.",
    );
  }
  return ok(code);
}

export const TITLE_MAX = 60;

// What the leaders who sit in a node are called, like President (0006's teams.leader_title):
// trimmed, one line, at most 60 characters; empty means no title (null).
export function parseLeaderTitle(value: unknown): Parsed<string | null> {
  if (value === null || value === undefined) return ok(null);
  if (typeof value !== "string") return fail("Titles must be text.");
  const title = value.trim();
  if (title === "") return ok(null);
  if (CONTROL_OR_FORMAT.test(title)) return fail("Titles can't contain line breaks or hidden characters.");
  if (length(title) > TITLE_MAX) return fail(`Titles can be at most ${TITLE_MAX} characters.`);
  return ok(title);
}

export const NOTE_MAX = 500;

// A note on a team: trimmed, at most 500 characters; empty means no note (null). Browsers send a
// textarea's line breaks as \r\n, which would count twice; they're stored as \n.
export function parseNote(value: unknown): Parsed<string | null> {
  if (value === null || value === undefined) return ok(null);
  if (typeof value !== "string") return fail("Notes must be text.");
  const note = value.replace(/\r\n?/g, "\n").trim();
  if (note === "") return ok(null);
  if (CONTROL_OR_FORMAT_EXCEPT_BREAKS.test(note)) return fail("Notes can't contain hidden characters.");
  if (length(note) > NOTE_MAX) return fail(`Notes can be at most ${NOTE_MAX} characters.`);
  return ok(note);
}

export const EMAIL_MAX = 254;

// An email address to give someone a login: trimmed and lower-cased, at most 254 characters,
// exactly one @ with something on both sides and a dot in the domain, and no spaces, control or
// hidden characters. (Supabase Auth checks it again.)
export function parseEmail(value: unknown): Parsed<string> {
  if (typeof value !== "string") return fail("Enter an email address.");
  const email = value.trim().toLowerCase();
  if (email === "") return fail("Enter an email address.");
  if (length(email) > EMAIL_MAX) return fail(`Email addresses can be at most ${EMAIL_MAX} characters.`);
  if (/[\s\p{Z}\p{Cc}\p{Cf}]/u.test(email)) return fail("Email addresses can't contain spaces.");
  const parts = email.split("@");
  if (parts.length !== 2) return fail("Enter an email address like name@example.com.");
  const [local, domain] = parts;
  const labels = domain.split(".");
  if (local === "" || labels.length < 2 || labels.some((label) => label === "")) {
    return fail("Enter an email address like name@example.com.");
  }
  return ok(email);
}
