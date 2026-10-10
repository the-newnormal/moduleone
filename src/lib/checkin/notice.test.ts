import { describe, expect, it } from "vitest";
import { noticeSections, noticeVersion, sttDestinations } from "./notice";

type Env = Record<string, string | undefined>;

const section = (env: Env, heading: string) => noticeSections(env).find((s) => s.heading === heading)?.body ?? "";
const processing = (env: Env) => section(env, "Who processes it");

describe("the privacy notice", () => {
  it("names OpenAI alone by default (the whisper-1 fallback is OpenAI too)", () => {
    const env = {};
    expect(sttDestinations(env)).toEqual(["openai"]);
    expect(noticeVersion(env)).toBe("2026-10-09.openai");
    expect(processing(env)).toContain("sent to OpenAI, in the United States, to turn it into text.");
    expect(processing(env)).not.toContain("Normal runs itself");
  });

  it("names the fallback too when it sends recordings somewhere else", () => {
    const env = { STT_PROVIDER: "local" }; // STT_FALLBACK defaults to openai:whisper-1
    expect(sttDestinations(env)).toEqual(["local", "openai"]);
    expect(noticeVersion(env)).toBe("2026-10-09.local+openai");
    expect(processing(env)).toBe(
      "When you submit, your recording is sent to a speech-to-text server that Normal runs itself, to turn it into text. If that service is unavailable, it goes instead to OpenAI, in the United States. The text is then sent to Anthropic, in the United States, which scores it for activity, excellence and morale and writes a short summary.",
    );
  });

  it("asks again when the fallback changes, not only the main service", () => {
    expect(noticeVersion({ STT_PROVIDER: "local", STT_FALLBACK: "none" })).toBe("2026-10-09.local");
    expect(noticeVersion({ STT_PROVIDER: "local" })).not.toBe(noticeVersion({ STT_PROVIDER: "local", STT_FALLBACK: "none" }));
    expect(processing({ STT_PROVIDER: "local", STT_FALLBACK: "none" })).not.toContain("OpenAI");
  });

  it("names both when OpenAI falls back to a local server", () => {
    const env = { STT_PROVIDER: "openai", STT_FALLBACK: "local:parakeet" };
    expect(noticeVersion(env)).toBe("2026-10-09.openai+local");
    expect(processing(env)).toContain("If that service is unavailable, it goes instead to a speech-to-text server that Normal runs itself.");
  });

  it("names the default when the configuration can't be used (nothing is sent then)", () => {
    expect(sttDestinations({ STT_PROVIDER: "assemblyai" })).toEqual(["openai"]);
  });

  it("says who grants the right to play recordings", () => {
    const body = noticeSections({}).find((section) => section.heading === "Who sees what")?.body;
    expect(body).toContain("the project owner has given permission");
    expect(body).not.toContain("HQ has given");
  });

  // The wording members accepted before the live check-in; switching it off must bring it back
  // exactly, or they would be asked to accept a notice they already have.
  it("keeps today's wording, word for word, when the live check-in is off", () => {
    const today = [
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
        body: "When you submit, your recording is sent to OpenAI, in the United States, to turn it into text. The text is then sent to Anthropic, in the United States, which scores it for activity, excellence and morale and writes a short summary.",
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
    expect(noticeSections({})).toEqual(today);
    expect(noticeSections({ LIVE_CHECKIN: "off" })).toEqual(today);
    expect(noticeVersion({ LIVE_CHECKIN: "off" })).toBe("2026-10-09.openai");
  });
});

describe("the privacy notice with the live check-in on", () => {
  const live = { LIVE_CHECKIN: "on" };

  it("has its own version, so members accept it again, and switching it off goes back", () => {
    expect(noticeVersion(live)).toBe("2026-10-10.openai.live");
    expect(noticeVersion({ ...live, STT_PROVIDER: "local" })).toBe("2026-10-10.local+openai.live");
    expect(noticeVersion({ ...live, STT_PROVIDER: "local", STT_FALLBACK: "none" })).toBe("2026-10-10.local.live");
    expect(noticeVersion({ LIVE_CHECKIN: "off" })).toBe(noticeVersion({}));
    expect(noticeVersion(live)).not.toBe(noticeVersion({}));
  });

  it("keeps the same headings, in the same order", () => {
    expect(noticeSections(live).map((s) => s.heading)).toEqual(noticeSections({}).map((s) => s.heading));
  });

  it("says the words are turned into text while they speak, for the follow-up questions", () => {
    expect(section(live, "What we record")).toBe(
      "Your spoken answers about your week. The recording starts when you press Start and stops when you press Finish. While you record, your words are turned into text as you speak, so the app can suggest follow-up questions on screen.",
    );
    expect(section(live, "Why")).toContain(
      "The follow-up questions help you cover what you did, where you or your team were at your best, and how you feel about the team.",
    );
  });

  it("names OpenAI for the live audio and Anthropic for the text so far, before submit", () => {
    expect(processing(live)).toBe(
      "While you record, your voice is streamed to OpenAI, in the United States, to turn it into text as you speak, and the text so far is sent to Anthropic, in the United States, to suggest the next question. When you submit, your recording is sent to OpenAI, in the United States, to turn it into text. The text is then sent to Anthropic, in the United States, which scores it for activity, excellence and morale and writes a short summary.",
    );
  });

  // A local server has no realtime API, so the live audio goes to OpenAI even when nothing else does.
  it("names OpenAI for the live audio even when recordings are transcribed locally", () => {
    const env = { ...live, STT_PROVIDER: "local", STT_FALLBACK: "none" };
    expect(processing(env)).toContain("While you record, your voice is streamed to OpenAI, in the United States");
    expect(processing(env)).toContain("When you submit, your recording is sent to a speech-to-text server that Normal runs itself, to turn it into text.");
    expect(processing(env)).not.toContain("If that service is unavailable");
  });

  it("names the fallback for the submitted recording, as without the live check-in", () => {
    expect(processing({ ...live, STT_PROVIDER: "local" })).toContain(
      "If that service is unavailable, it goes instead to OpenAI, in the United States.",
    );
  });

  it("says the live text and the questions' wording are not kept, and what is", () => {
    const body = section(live, "Who sees what");
    expect(body).toContain("the project owner has given permission");
    expect(body).toContain("Until you submit, your recording is visible to you alone");
    expect(body).toContain("The live text and the wording of the follow-up questions are not kept.");
    expect(body).toContain("which topics you were asked about, how much of each you had covered");
    expect(body).toContain("That record never includes your words, and nobody sees it in the app.");
  });

  // The record keeps the coach's reading of the mood, including "not coping" (distress), which also
  // stops the questions: the notice names every reading it can hold.
  it("names each reading of the mood the record keeps, the not-coping one too", () => {
    const body = section(live, "Who sees what");
    expect(body).toContain(
      "whether it sounded like a hard week or like you weren't coping (it then stops asking questions), with your check-in.",
    );
    expect(section({}, "Who sees what")).not.toContain("coping");
  });

  it("says how long the topics record is kept when the take isn't submitted", () => {
    expect(section(live, "How long we keep it")).toBe(
      "Recordings are deleted after 90 days. Transcripts and scores are kept as part of your team's check-in history. If you don't submit, the record of which topics you were asked about is deleted after 14 days.",
    );
  });

  // Their own retention isn't something we have checked, so the notice doesn't speak for them.
  it("claims nothing about how long OpenAI or Anthropic keep anything", () => {
    const text = noticeSections(live)
      .map((s) => s.body)
      .join(" ");
    expect(text).not.toMatch(/(OpenAI|Anthropic)[^.]*(keep|retain|delete|store)/i);
  });

  it("keeps the questions section as it is", () => {
    expect(section(live, "Questions")).toBe(section({}, "Questions"));
  });
});
