import "server-only";
import { noticeAccepted, sessionMember, type Session } from "@/lib/checkin/session";
import type { LiveError, LiveErrorCode } from "./contract";

// What the live check-in's routes share. They are plain POST route handlers (see contract.ts), so
// they don't get the checks Next.js gives server actions: each one takes only same-origin JSON, and
// takes the member from the session, never from the request.

// A coach call carries at most MAX_TRANSCRIPT_CHARS of transcript; anything far bigger is refused
// before it is read.
const MAX_BODY_BYTES = 128 * 1024;

const STATUS: Record<LiveErrorCode, number> = {
  bad_request: 400,
  signed_out: 401,
  no_member: 403,
  notice_required: 403,
  no_session: 404,
  submitted: 409,
  session_over: 410,
  too_many_sessions: 429,
  too_many_calls: 429,
  too_soon: 429,
  unavailable: 503,
};

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function refuse(code: LiveErrorCode): Response {
  const body: LiveError = { status: "error", code };
  return json(body, STATUS[code]);
}

// The request's JSON body, or undefined unless it came from this site (its Origin is this host) as
// JSON and isn't oversized. The session cookie is SameSite=Lax, so another site's POST arrives
// signed out anyway; this is the second lock.
export async function readJson(request: Request): Promise<unknown> {
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "").split(",")[0].trim();
  let origin: string | null = null;
  try {
    origin = new URL(request.headers.get("origin") ?? "").host;
  } catch {
    return undefined;
  }
  if (!host || origin !== host) return undefined;
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return undefined;
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return undefined;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// The signed-in member, or why not. With `notice`, they must also have accepted the current privacy
// notice, which says where live audio and text go.
export async function liveMember({ notice }: { notice: boolean }): Promise<Session | LiveErrorCode> {
  const session = await sessionMember();
  if (session === "failed") return "unavailable";
  if (typeof session === "string") return session;
  if (!notice) return session;
  const accepted = await noticeAccepted(session);
  if (accepted === "failed") return "unavailable";
  return accepted ? session : "notice_required";
}
