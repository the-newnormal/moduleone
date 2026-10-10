// The live check-in's switches, read when used (never at import time), like the rest of the env.
//   LIVE_CHECKIN    on | off (default off). Changing it changes the privacy notice (notice.ts), so
//                   members are asked to accept it again before their next recording.
//   STT_LIVE_MODEL  OpenAI's realtime transcription model (default gpt-live-transcribe). Live text
//                   always comes from OpenAI, whatever STT_PROVIDER says, since a local server has no
//                   realtime API; the notice says so.
//   COACH_MODEL     the Claude model that picks the questions (src/lib/coach, default Haiku).

type Env = Record<string, string | undefined>;

export function liveCheckinEnabled(env: Env = process.env): boolean {
  return env.LIVE_CHECKIN?.trim().toLowerCase() === "on";
}

export const DEFAULT_LIVE_STT_MODEL = "gpt-live-transcribe";

export function liveSttModel(env: Env = process.env): string {
  return env.STT_LIVE_MODEL?.trim() || DEFAULT_LIVE_STT_MODEL;
}
