// The live check-in's switches, read when used (never at import time), like the rest of the env.
//   LIVE_CHECKIN    on | off (default off). Switching it on streams audio to OpenAI and the text so
//                   far to Anthropic while members talk, and keeps live_checkin_sessions: the
//                   onboarding form, outside Module One, must say so first (the app no longer asks
//                   members).
//   STT_LIVE_MODEL  OpenAI's realtime transcription model (default gpt-live-transcribe). Live text
//                   always comes from OpenAI, whatever STT_PROVIDER says, since a local server has no
//                   realtime API; the onboarding form must say so.
//   COACH_MODEL     the Claude model that picks the questions (src/lib/coach, default Haiku).

type Env = Record<string, string | undefined>;

export function liveCheckinEnabled(env: Env = process.env): boolean {
  return env.LIVE_CHECKIN?.trim().toLowerCase() === "on";
}

export const DEFAULT_LIVE_STT_MODEL = "gpt-live-transcribe";

export function liveSttModel(env: Env = process.env): string {
  return env.STT_LIVE_MODEL?.trim() || DEFAULT_LIVE_STT_MODEL;
}
