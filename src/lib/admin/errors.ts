// Turning database errors into sentences for admins, and logging without leaking row data.
//
// The database words its own refusals for people (0002's scoring check, 0003's tree rules), so
// those are shown as they are. Everything else gets a fixed sentence. Messages from Postgres can
// include row values (`details`, "Failing row contains …"), so only `message` is ever shown, and
// only for the codes below; logs get the code and HTTP status, nothing else.

// What a server action returns to the page. Shape the success value to what the page renders,
// never raw rows.
export type ActionResult<T = null> = { ok: true; value: T } | { ok: false; error: string };

// A refusal with the sentence to show (fits ActionResult and validate.ts's Parsed alike).
export const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export const GENERIC_ERROR = "Something went wrong. Try again.";
export const NO_PERMISSION = "You don't have permission to do that.";
export const CODE_TAKEN = "That code is already used.";

// The fields we read from a PostgrestError (or an AuthError, which has `status` too).
export type DbError = {
  code?: string | null;
  message?: string | null;
  status?: number | null;
};

// 0003's own 42501 sentences. Any other 42501 is RLS or a missing grant, worded by Postgres.
const OWN_PERMISSION_MESSAGES = new Set([
  "Only admins can move teams.",
  "You lead where this is going, so another admin has to move it there.",
]);

// Table check constraints (as opposed to the triggers' sentences) fail with Postgres's wording,
// which names the constraint. The forms check these first, so they only show up if that check is
// bypassed; say what's wrong instead.
const CONSTRAINT_MESSAGES: Record<string, string> = {
  teams_code_format:
    "Codes are 1–8 letters or digits, optionally a dot and 1–8 more, like IP.X or IP.1.",
  teams_note_length: "Notes can be at most 500 characters.",
  teams_kind: "That kind of node doesn't exist.",
  teams_domain_type: "Only a domain can have a domain type.",
  teams_division_type: "Only a division can have a division type.",
  teams_sort_order_range: "The position must be between 0 and 10000.",
  teams_not_own_parent: "A node can't sit under itself.",
  teams_division_at_top: "A division can only sit at the top level.",
  teams_team_has_parent: "A team can only sit under a domain.",
  members_role_chk: "That role doesn't exist.",
  scoring_activity_order: "A better activity score can't count for less than a worse one.",
  scoring_excellence_order: "A better excellence score can't count for less than a worse one.",
  scoring_morale_order: "A better morale score can't count for less than a worse one.",
  scoring_thresholds_order: "The yellow threshold must be below the green one.",
  scoring_values_range:
    "Score values must be from 0.01 to 1000, the yellow threshold above 0 and the green one at most 999,999.99.",
};

const CONSTRAINT_IN_MESSAGE = /violates check constraint "([a-z0-9_]+)"/;

// Log a failure with its code and status only (never its message, details or the input, which
// can hold names and emails). `context` says where, e.g. "moveTeam".
export function logError(context: string, error: unknown): void {
  const e = (typeof error === "object" && error !== null ? error : {}) as Record<string, unknown>;
  const code = typeof e.code === "string" || typeof e.code === "number" ? e.code : undefined;
  const status = typeof e.status === "number" ? e.status : undefined;
  console.error(`${context} failed`, { code, status });
}

// The sentence to show for a failed Supabase call:
// - 23514 (check_violation) and P0002 (0003's "That team doesn't exist."): the database's own
//   message, or for a table check constraint, the sentence above;
// - 42501: 0003's own sentences as they are, anything else "You don't have permission to do that.";
// - 23505 on teams_code_key: "That code is already used.";
// - anything else (25000, network errors, …): "Something went wrong. Try again.", logged with
//   code and status under `context`.
export function toUserMessage(error: DbError | null | undefined, context = "admin action"): string {
  const code = error?.code ?? undefined;
  const message = error?.message?.trim() ?? "";

  if ((code === "23514" || code === "P0002") && message) {
    const constraint = CONSTRAINT_IN_MESSAGE.exec(message)?.[1];
    if (constraint) {
      const sentence = CONSTRAINT_MESSAGES[constraint];
      if (sentence) return sentence;
      logError(context, error);
      return GENERIC_ERROR;
    }
    return message;
  }
  if (code === "42501") {
    return OWN_PERMISSION_MESSAGES.has(message) ? message : NO_PERMISSION;
  }
  if (code === "23505" && message.includes('"teams_code_key"')) return CODE_TAKEN;

  logError(context, error);
  return GENERIC_ERROR;
}

// For the admin pages' client components: calls a server action, so that one which throws
// instead of answering (the connection dropped, the server failed) reads like any other failure
// ("Something went wrong. Try again.", logged with its code only) rather than replacing the page
// with the error page. `context` names the action for the log.
export async function settle<T>(call: () => Promise<ActionResult<T>>, context: string): Promise<ActionResult<T>> {
  try {
    return await call();
  } catch (error) {
    logError(context, error);
    return fail(GENERIC_ERROR);
  }
}
