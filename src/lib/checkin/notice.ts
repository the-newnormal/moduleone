// The one-time privacy notice shown before a member's first recording (Singapore PDPA: tell people
// what is collected, why, who it goes to and how long it is kept, before collecting it).
// Changing what the notice says, where recordings may be sent for transcription, or whether the live
// check-in is on (LIVE_CHECKIN), changes the version, and members are asked to read it again.

import { sttConfig } from "@/lib/stt/config";
import type { SttProvider } from "@/lib/stt/types";
import { liveCheckinEnabled } from "./live-config";

const NOTICE_REVISION = "2026-10-09";
// The live check-in's wording has its own revision, so switching it on or off changes the version
// either way, and the wording without it stays exactly as members accepted it.
const LIVE_NOTICE_REVISION = "2026-10-10";

type Env = Record<string, string | undefined>;

// Every service a recording may be sent to, in the order transcribe() tries them: the configured
// one (STT_PROVIDER) and, when that one fails, the fallback (STT_FALLBACK). Both are named in the
// notice, since either may receive the audio.
export function sttDestinations(env: Env = process.env): SttProvider[] {
  let config;
  try {
    config = sttConfig(env);
  } catch {
    // A configuration transcribe() can't use sends nothing anywhere; name the default.
    return ["openai"];
  }
  const providers = [config.primary.provider, config.fallback?.provider];
  return [...new Set(providers.filter((provider): provider is SttProvider => provider !== undefined))];
}

// The live check-in sends its audio to OpenAI whatever STT_PROVIDER says (a local server has no
// realtime API), so ".live" stands for that as well as for the live wording.
export function noticeVersion(env: Env = process.env): string {
  const destinations = sttDestinations(env).join("+");
  return liveCheckinEnabled(env) ? `${LIVE_NOTICE_REVISION}.${destinations}.live` : `${NOTICE_REVISION}.${destinations}`;
}

const TRANSCRIBER: Record<SttProvider, string> = {
  openai: "OpenAI, in the United States",
  local: "a speech-to-text server that Normal runs itself",
};

export type NoticeSection = { heading: string; body: string };

function processors(destinations: readonly SttProvider[]): string {
  const [first, ...rest] = destinations;
  const fallback = rest.length
    ? ` If that service is unavailable, it goes instead to ${rest.map((provider) => TRANSCRIBER[provider]).join(" or ")}.`
    : "";
  return `When you submit, your recording is sent to ${TRANSCRIBER[first]}, to turn it into text.${fallback} The text is then sent to Anthropic, in the United States, which scores it for activity, excellence and morale and writes a short summary.`;
}

const START_AND_FINISH = "The recording starts when you press Start and stops when you press Finish.";
const WHY =
  "To give your team leader and HQ a weekly picture of how each team is doing: what got done, where people used their strengths, and how they feel about the team.";
const WHO_SEES =
  "Your team leader and HQ see your transcript, the scores and the summary. You won't see the scores. Your recording can be played back only by you and by the few people the project owner has given permission to listen to recordings. Until you submit, your recording is visible to you alone, and you can delete it and record again.";
const KEPT = "Recordings are deleted after 90 days. Transcripts and scores are kept as part of your team's check-in history.";

// What the live check-in adds (LIVE_CHECKIN=on). While recording, the browser streams the audio
// straight to OpenAI's realtime API, and the server sends the text so far to Anthropic for the next
// question (src/lib/coach). Neither the live text nor the questions' wording is stored: the coach
// keeps topic ids, coverage levels, its reading of the mood and counts (live_checkin_sessions, 0011),
// which only the server reads, and the daily job deletes it after 14 days if the take is never
// submitted. Nothing here claims how long OpenAI or Anthropic keep anything themselves.
const LIVE = {
  record:
    "While you record, your words are turned into text as you speak, so the app can suggest follow-up questions on screen.",
  why: "The follow-up questions help you cover what you did, where you or your team were at your best, and how you feel about the team.",
  processing:
    "While you record, your voice is streamed to OpenAI, in the United States, to turn it into text as you speak, and the text so far is sent to Anthropic, in the United States, to suggest the next question.",
  sees: "The live text and the wording of the follow-up questions are not kept. To improve the questions, the app keeps a record of which topics you were asked about, how much of each you had covered and whether it sounded like a hard week, with your check-in. That record never includes your words, and nobody sees it in the app.",
  kept: "If you don't submit, the record of which topics you were asked about is deleted after 14 days.",
};

export function noticeSections(env: Env = process.env): NoticeSection[] {
  const live = liveCheckinEnabled(env);
  const processing = processors(sttDestinations(env));
  return [
    {
      heading: "What we record",
      body: live
        ? `Your spoken answers about your week. ${START_AND_FINISH} ${LIVE.record}`
        : `Your spoken answers to three questions about your week. ${START_AND_FINISH}`,
    },
    {
      heading: "Why",
      body: live ? `${WHY} ${LIVE.why}` : WHY,
    },
    {
      heading: "Who processes it",
      body: live ? `${LIVE.processing} ${processing}` : processing,
    },
    {
      heading: "Who sees what",
      body: live ? `${WHO_SEES} ${LIVE.sees}` : WHO_SEES,
    },
    {
      heading: "How long we keep it",
      body: live ? `${KEPT} ${LIVE.kept}` : KEPT,
    },
    {
      heading: "Questions",
      body: "Ask HQ if you want to know more, or to see or correct what is held about you.",
    },
  ];
}
