import { describe, expect, it } from "vitest";
import { noticeSections, noticeVersion, sttDestinations } from "./notice";

const processing = (env: Record<string, string | undefined>) =>
  noticeSections(env).find((section) => section.heading === "Who processes it")?.body ?? "";

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
});
