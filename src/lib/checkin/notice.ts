// The one-time privacy notice shown before a member's first recording (Singapore PDPA: tell people
// what is collected, why, who it goes to and how long it is kept, before collecting it).
// Changing what the notice says, or which transcription provider is used, changes the version, and
// members are asked to read it again.

import type { SttProvider } from "@/lib/stt/types";

const NOTICE_REVISION = "2026-10-09";

/** Which transcription provider the server is configured to use (STT_PROVIDER), as the notice names it. */
export function configuredSttProvider(): SttProvider {
  const value = (process.env.STT_PROVIDER ?? "openai").trim().toLowerCase();
  return value === "local" ? value : "openai";
}

export function noticeVersion(provider: SttProvider = configuredSttProvider()): string {
  return `${NOTICE_REVISION}.${provider}`;
}

const TRANSCRIBER: Record<SttProvider, string> = {
  openai: "OpenAI, in the United States",
  local: "a speech-to-text server that Normal runs itself",
};

export type NoticeSection = { heading: string; body: string };

export function noticeSections(provider: SttProvider = configuredSttProvider()): NoticeSection[] {
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
      body: `When you submit, your recording is sent to ${TRANSCRIBER[provider]}, to turn it into text. The text is then sent to Anthropic, in the United States, which scores it for activity, excellence and morale and writes a short summary.`,
    },
    {
      heading: "Who sees what",
      body: "Your team leader and HQ see your transcript, the scores and the summary. You won't see the scores. Your recording can be played back only by you and by the few people HQ has given permission to listen to recordings. Until you submit, your recording is visible to you alone, and you can delete it and record again.",
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
