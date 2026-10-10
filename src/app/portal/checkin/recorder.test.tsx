// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { button, click, queryButton, render, settle, text } from "@/test/dom";
import type { LiveReady } from "./live/api";
import type { SaveOutcome, Take } from "./take";

// The recorder beside the app bar's Sign out: a take whose save failed is safe only in this page,
// so the recorder tells pending-save while it shows one, and Sign out asks before losing it.

// One router for the page, as Next.js gives (the recorder's effects depend on it).
const router = { push: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
// The same fakes for every fresh copy of the modules (see load).
const fakes = vi.hoisted(() => ({
  prepareRecording: vi.fn(),
  saveDraft: vi.fn(),
  createClient: vi.fn(),
  startLive: vi.fn(),
  askCoach: vi.fn(),
  endLive: vi.fn(),
  connectLiveTranscription: vi.fn(),
  startLevelMeter: vi.fn(),
}));
vi.mock("./actions", () => ({ prepareRecording: fakes.prepareRecording, saveDraft: fakes.saveDraft }));
vi.mock("@/lib/supabase/client", () => ({ createClient: fakes.createClient }));
// The live check-in's browser side: its routes, its WebRTC connection and its level meter.
vi.mock("./live/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./live/api")>()),
  startLive: fakes.startLive,
  askCoach: fakes.askCoach,
  endLive: fakes.endLive,
}));
vi.mock("./live/transport", () => ({ connectLiveTranscription: fakes.connectLiveTranscription }));
vi.mock("./live/voice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./live/voice")>()),
  startLevelMeter: fakes.startLevelMeter,
}));

const take: Take = {
  blob: new Blob([new Uint8Array([1])], { type: "audio/webm" }),
  mimeType: "audio/webm",
  durationMs: 1000,
  recordedAt: 1,
  recordedAtMono: 0,
  serverRecordedAt: null,
  uploadedPath: null,
  liveSessionId: null,
};
const failed: SaveOutcome = { step: "failed", take, message: "Couldn't save your recording. Try again.", updated: false };

// The modules keep their state for the life of the page, so each test loads fresh copies.
async function load() {
  vi.resetModules();
  const saves = await import("./pending-save");
  const { Recorder } = await import("./recorder");
  return { ...saves, Recorder };
}

// A MediaRecorder whose stop event comes only when the test fires it, as a real one's comes later.
class FakeRecorder {
  static isTypeSupported = () => true;
  static last: FakeRecorder | null = null;
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeRecorder.last = this;
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
  }
}

describe("a recording stopped by Finish", () => {
  it("has its save registered at once, before the stop event, so Sign out waits for it", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const track = { stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) },
      configurable: true,
    });
    const { Recorder, currentSave } = await load();
    await render(<Recorder />);
    await click(button("Start recording"));
    await settle();
    await click(button("Next question"));
    await click(button("Next question"));
    await click(button("Finish"));
    expect(FakeRecorder.last?.state).toBe("inactive"); // stopped; its stop event hasn't come yet
    expect(currentSave()).not.toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("a failed take the recorder shows", () => {
  it("is held for Sign out once the recorder has taken the save over, until it's discarded", async () => {
    const { Recorder, trackSave, currentSave, failedTakeShown } = await load();
    // The member left while the take saved; the save failed; they came back.
    void trackSave(Promise.resolve(failed));
    await render(<Recorder />);
    await settle();
    expect(button("Try again")).toBeTruthy();
    expect(currentSave()).toBeNull(); // the recorder took it over
    expect(failedTakeShown()).toBe(true);

    await click(button("Discard"));
    expect(failedTakeShown()).toBe(false);
  });
});

const SESSION = "5e550000-0000-4000-8000-000000000001";
const OPENING = "Talk me through your week: what you worked on, what came of it, and how you're feeling about the team.";
const READY: LiveReady = {
  status: "ready",
  sessionId: SESSION,
  clientSecret: "ek_test_only",
  sttModel: "gpt-live-transcribe",
  opening: OPENING,
  pacing: { showAfterSilenceMs: 1500, stoppedSilenceMs: 3000, minQuestionMs: 8000, minWordsPerQuestion: 15, firstFollowUpAfterMs: 20_000 },
};

describe("a live check-in", () => {
  const track = { stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const connection = { commit: vi.fn(), close: vi.fn() };

  function microphone() {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) },
      configurable: true,
    });
    fakes.connectLiveTranscription.mockReset().mockResolvedValue(connection);
    // Level samples, so live coaching carries on for the length of a test.
    fakes.startLevelMeter.mockReset().mockImplementation((_stream: MediaStream, onLevel: (level: number, now: number) => void) => {
      const timer = setInterval(() => onLevel(0.002, performance.now()), 50);
      return () => clearInterval(timer);
    });
    fakes.endLive.mockReset();
    fakes.askCoach.mockReset().mockResolvedValue(null);
  }

  async function startRecording(start: unknown = READY) {
    microphone();
    fakes.startLive.mockReset().mockResolvedValue(start);
    const { Recorder } = await load();
    await render(<Recorder live={{ opening: OPENING }} />);
    await click(button("Start recording"));
    await settle();
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts with the one open question, not the three fixed ones", async () => {
    const { Recorder } = await load();
    await render(<Recorder live={{ opening: OPENING }} />);
    expect(text()).toContain("We'll start with one question.");
    expect(text()).toContain(OPENING);
    expect(text()).not.toContain("What have you done this week?");
    expect(button("Start recording")).toBeTruthy();
  });

  it("shows the open question while recording, with Finish and no Next question", async () => {
    await startRecording();
    expect(document.querySelector("h3")?.textContent).toBe(OPENING);
    expect(button("Finish")).toBe(document.activeElement);
    expect(queryButton("Next question")).toBeNull();
    expect(queryButton("Different question")).toBeNull(); // not for the opening question
    expect(text()).toContain("Not yet: What you did");
    expect(text()).not.toContain("Question 1 of 3");
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain(`Recording. ${OPENING}`);
    expect(fakes.connectLiveTranscription).toHaveBeenCalledOnce();
  });

  it("asks for the live session only once the microphone is allowed, however long that takes", async () => {
    microphone();
    // The browser's prompt stays open until the test answers it: longer than the 30 seconds the
    // session's transcription key can be used for, as far as the recorder can tell.
    let allow: () => void = () => {};
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: () =>
          new Promise((resolve) => {
            allow = () => resolve({ getTracks: () => [track], getAudioTracks: () => [track] });
          }),
      },
      configurable: true,
    });
    fakes.startLive.mockReset().mockResolvedValue(READY);
    const { Recorder } = await load();
    await render(<Recorder live={{ opening: OPENING }} />);
    await click(button("Start recording"));
    await settle();
    expect(text()).toContain("Waiting for your microphone…");
    expect(fakes.startLive).not.toHaveBeenCalled();

    await act(async () => allow());
    await settle();
    expect(fakes.startLive).toHaveBeenCalledOnce();
    expect(fakes.connectLiveTranscription).toHaveBeenCalledOnce();
    expect(document.querySelector("h3")?.textContent).toBe(OPENING);
  });

  it("asks for no live session when the microphone is refused", async () => {
    microphone();
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async () => Promise.reject(new DOMException("denied", "NotAllowedError")) },
      configurable: true,
    });
    fakes.startLive.mockReset().mockResolvedValue(READY);
    const { Recorder } = await load();
    await render(<Recorder live={{ opening: OPENING }} />);
    await click(button("Start recording"));
    await settle();
    expect(button("Start recording")).toBeTruthy();
    expect(fakes.startLive).not.toHaveBeenCalled();
    expect(fakes.endLive).not.toHaveBeenCalled();
  });

  it("goes back to the three fixed questions when live questions aren't available", async () => {
    await startRecording({ status: "off" });
    expect(text()).toContain("Question 1 of 3");
    expect(document.querySelector("h3")?.textContent).toBe("What have you done this week?");
    expect(text()).toContain("Live questions aren't available, so here are this week's three questions.");
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain("Live questions aren't available");
    await click(button("Next question"));
    await click(button("Next question"));
    expect(button("Finish")).toBeTruthy();
    expect(fakes.connectLiveTranscription).not.toHaveBeenCalled();
  });

  it("saves the take with its live session, and ends the session once", async () => {
    await startRecording();
    fakes.prepareRecording.mockResolvedValue({
      status: "ready",
      path: "3e3b0000-0000-4000-8000-000000000003/2026-10-05-take.webm",
      token: "token-1",
      contentType: "audio/webm",
    });
    fakes.createClient.mockReturnValue({
      storage: { from: () => ({ uploadToSignedUrl: async () => ({ error: null }) }) },
    });
    fakes.saveDraft.mockResolvedValue({ status: "saved" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ now: Date.now() }), { headers: { "content-type": "application/json" } })),
    );

    await click(button("Finish"));
    // The opening question was still on screen.
    expect(fakes.endLive).toHaveBeenCalledExactlyOnceWith({ sessionId: SESSION, recordedMs: expect.any(Number), shown: 0 });
    expect(connection.close).toHaveBeenCalled();
    await act(async () => {
      FakeRecorder.last?.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }) });
      FakeRecorder.last?.onstop?.();
    });
    for (let i = 0; i < 5; i++) await settle();

    expect(fakes.saveDraft).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ liveSessionId: SESSION }));
    expect(text()).toContain("Saved.");
    expect(fakes.endLive).toHaveBeenCalledOnce();
  });
});
