import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LIVE_STT_MODEL, liveCheckinEnabled, liveSttModel } from "./live-config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("liveCheckinEnabled", () => {
  it.each([["on"], ["ON"], [" on "], ["On\n"]])("is on with LIVE_CHECKIN=%j", (value) => {
    expect(liveCheckinEnabled({ LIVE_CHECKIN: value })).toBe(true);
  });

  it.each([["off"], ["yes"], ["true"], ["1"], [""], ["o n"]])("is off with LIVE_CHECKIN=%j", (value) => {
    expect(liveCheckinEnabled({ LIVE_CHECKIN: value })).toBe(false);
  });

  it("is off when LIVE_CHECKIN isn't set", () => {
    expect(liveCheckinEnabled({})).toBe(false);
  });

  // Read when called, never at import time, so a change to the environment takes effect.
  it("reads the environment each time it is called", () => {
    vi.stubEnv("LIVE_CHECKIN", "on");
    expect(liveCheckinEnabled()).toBe(true);
    vi.stubEnv("LIVE_CHECKIN", "off");
    expect(liveCheckinEnabled()).toBe(false);
  });
});

describe("liveSttModel", () => {
  it("defaults to gpt-live-transcribe", () => {
    expect(DEFAULT_LIVE_STT_MODEL).toBe("gpt-live-transcribe");
    expect(liveSttModel({})).toBe("gpt-live-transcribe");
  });

  it.each([[""], ["   "]])("uses the default for STT_LIVE_MODEL=%j", (value) => {
    expect(liveSttModel({ STT_LIVE_MODEL: value })).toBe("gpt-live-transcribe");
  });

  it("takes STT_LIVE_MODEL, trimmed", () => {
    expect(liveSttModel({ STT_LIVE_MODEL: " gpt-4o-transcribe " })).toBe("gpt-4o-transcribe");
  });

  it("reads the environment each time it is called", () => {
    vi.stubEnv("STT_LIVE_MODEL", "gpt-4o-mini-transcribe");
    expect(liveSttModel()).toBe("gpt-4o-mini-transcribe");
    vi.stubEnv("STT_LIVE_MODEL", "");
    expect(liveSttModel()).toBe("gpt-live-transcribe");
  });
});
