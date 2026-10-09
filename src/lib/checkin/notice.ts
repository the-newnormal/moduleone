// The one-time privacy notice shown before a member's first recording (Singapore PDPA: tell people
// what is collected, why, who it goes to and how long it is kept, before collecting it).
// Changing what the notice says, or where recordings may be sent for transcription, changes the
// version, and members are asked to read it again.

import { sttConfig } from "@/lib/stt/config";
import type { SttProvider } from "@/lib/stt/types";

const NOTICE_REVISION = "2026-10-09";

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

export function noticeVersion(env: Env = process.env): string {
  return `${NOTICE_REVISION}.${sttDestinations(env).join("+")}`;
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

export function noticeSections(env: Env = process.env): NoticeSection[] {
  return [
    {
      heading: "What we record",
      body: "Your spoken answers to three questions about your week. The recording starts when you press Start and stops when you press Finish.",
    },
    {
      heading: "Why",
      body: "To give your team leader and HQ a weekly picture of how each team is doing: what got done, where people used their strengths, and how they feel about the team.",
    },
    {
      heading: "Who processes it",
      body: processors(sttDestinations(env)),
    },
    {
      heading: "Who sees what",
      body: "Your team leader and HQ see your transcript, the scores and the summary. You won't see the scores. Your recording can be played back only by you and by the few people the project owner has given permission to listen to recordings. Until you submit, your recording is visible to you alone, and you can delete it and record again.",
    },
    {
      heading: "How long we keep it",
      body: "Recordings are deleted after 90 days. Transcripts and scores are kept as part of your team's check-in history.",
    },
    {
      heading: "Questions",
      body: "Ask HQ if you want to know more, or to see or correct what is held about you.",
    },
  ];
}
