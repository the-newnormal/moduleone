// The recorder's calls to the live check-in routes (contract.ts). Each answers null when the route
// couldn't be reached or didn't answer as the contract says (signed out, the proxy redirecting to
// /login, a new deployment, no network); the recorder then carries on with the fixed questions.
// Error answers from the routes ({ status: "error", code }) come back as they are.

import { AREAS, OFFER_KINDS } from "@/lib/coach/types";
import {
  LIVE_COACH_PATH,
  LIVE_END_PATH,
  LIVE_START_PATH,
  type CoachRequest,
  type CoachResponse,
  type EndRequest,
  type LiveError,
  type LiveStartResponse,
} from "./contract";

export type LiveReady = Extract<LiveStartResponse, { status: "ready" }>;

export function isLiveStartReady(response: LiveStartResponse | null): response is LiveReady {
  return response?.status === "ready";
}

const PACING_FIELDS = ["showAfterSilenceMs", "stoppedSilenceMs", "minQuestionMs", "minWordsPerQuestion", "firstFollowUpAfterMs"] as const;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isLiveError = (body: Json): body is LiveError => body.status === "error" && isText(body.code);

function isStart(body: Json): body is LiveStartResponse {
  if (body.status === "off" || isLiveError(body)) return true;
  if (body.status !== "ready") return false;
  const pacing = body.pacing;
  return (
    isText(body.sessionId) &&
    isText(body.clientSecret) &&
    isText(body.sttModel) &&
    isText(body.opening) &&
    isObject(pacing) &&
    PACING_FIELDS.every((field) => typeof pacing[field] === "number" && Number.isFinite(pacing[field]))
  );
}

function isCoach(body: Json): body is CoachResponse {
  if (isLiveError(body)) return true;
  if (body.status !== "ok" || typeof body.degraded !== "boolean") return false;
  const { offer, touched } = body;
  const offerOk =
    offer === null ||
    (isObject(offer) &&
      typeof offer.id === "number" &&
      (OFFER_KINDS as readonly unknown[]).includes(offer.kind) &&
      isText(offer.text));
  return offerOk && isObject(touched) && AREAS.every((area) => typeof touched[area] === "boolean");
}

// The JSON body of a same-origin POST, or null. Redirects aren't followed: the proxy sends a
// signed-out request to /login with a 307, which would post the body there again.
async function post(path: string, body: unknown, init: { signal?: AbortSignal; keepalive?: boolean } = {}): Promise<Json | null> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin",
      redirect: "manual",
      ...init,
    });
  } catch {
    return null;
  }
  if (response.redirected || response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) return null;
  if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return null;
  try {
    const parsed: unknown = await response.json();
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Starts a live session: the key for live transcription, the opening question and the pacing.
export async function startLive(signal?: AbortSignal): Promise<LiveStartResponse | null> {
  const body = await post(LIVE_START_PATH, {}, { signal });
  return body && isStart(body) ? body : null;
}

// The transcript so far in, what to show next out.
export async function askCoach(request: CoachRequest, signal?: AbortSignal): Promise<CoachResponse | null> {
  const body = await post(LIVE_COACH_PATH, request, { signal });
  return body && isCoach(body) ? body : null;
}

// Ends the session. Sent with keepalive so it still goes when the page is closing; nothing waits on
// it (post never rejects), and the daily job closes any session it misses.
export function endLive(request: EndRequest): void {
  void post(LIVE_END_PATH, request, { keepalive: true });
}
