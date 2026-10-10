// What the recorder and the live check-in routes say to each other (all POST, JSON, no-store):
//   /portal/checkin/live          start a live session: its id, the opening question and the pacing
//   /portal/checkin/live/connect  the browser's WebRTC offer in, OpenAI's answer out: the server
//                                 opens the session's one live transcription (no key reaches the
//                                 browser), and the audio then goes straight to OpenAI
//   /portal/checkin/live/coach    the transcript so far in, the next thing to show out
//   /portal/checkin/live/end    the recording finished; how long it ran (for the cost log)
// Route handlers rather than server actions: Next.js runs a page's server actions one at a time, so
// a coach call every few seconds would hold up saving the take (see take.ts).

import type { Area, OfferKind, Pacing } from "@/lib/coach/types";

export const LIVE_START_PATH = "/portal/checkin/live";
export const LIVE_CONNECT_PATH = "/portal/checkin/live/connect";
export const LIVE_COACH_PATH = "/portal/checkin/live/coach";
export const LIVE_END_PATH = "/portal/checkin/live/end";

// The most transcript a coach call may send: well over ten minutes of speech.
export const MAX_TRANSCRIPT_CHARS = 30_000;
// A WebRTC offer for one audio track is a few kilobytes.
export const MAX_OFFER_CHARS = 20_000;

export type LiveErrorCode =
  | "signed_out"
  | "no_member"
  | "notice_required"
  | "submitted"
  | "too_many_sessions"
  | "no_session"
  | "session_over"
  | "too_many_calls"
  | "too_soon"
  | "bad_request"
  | "unavailable";

export type LiveError = { status: "error"; code: LiveErrorCode };

export type LiveStartResponse =
  | {
      status: "ready";
      sessionId: string;
      sttModel: string;
      opening: string;
      pacing: Pacing;
    }
  // Live check-ins are switched off (LIVE_CHECKIN), or rubrics/coach.md can't be used.
  | { status: "off" }
  | LiveError;

// The browser's WebRTC offer (SDP) for the session's live transcription, and OpenAI's answer. A
// session connects once: a second offer is refused (no_session).
export type ConnectRequest = { sessionId: string; offer: string };
export type ConnectResponse = { status: "connected"; answer: string } | LiveError;

export type CoachRequest = {
  sessionId: string;
  transcript: string;
  // How far into the recording, by the recorder's clock.
  elapsedMs: number;
  // The offer on screen now (0, the opening question, at first), and the one the member asked to
  // replace with "Different question", if they did.
  shown: number | null;
  skip: number | null;
};

export type ShownOffer = { id: number; kind: OfferKind; text: string };

export type CoachResponse =
  | {
      status: "ok";
      // What to show next, or null to keep what is on screen.
      offer: ShownOffer | null;
      // Which areas they have touched on so far: the only coverage the browser sees.
      touched: Record<Area, boolean>;
      // Claude's read failed this time (the offer, if any, comes from what was known before).
      degraded: boolean;
    }
  | LiveError;

// shown: the offer on screen when the take ended, so the last question or closing line is counted
// even when no coach call came after it.
export type EndRequest = { sessionId: string; recordedMs: number; shown: number | null };
export type EndResponse = { status: "ended" } | LiveError;
