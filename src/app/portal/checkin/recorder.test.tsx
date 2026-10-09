// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { button, click, render, settle } from "@/test/dom";
import type { SaveOutcome, Take } from "./take";

// The recorder beside the app bar's Sign out: a take whose save failed is safe only in this page,
// so the recorder tells pending-save while it shows one, and Sign out asks before losing it.

// One router for the page, as Next.js gives (the recorder's effects depend on it).
const router = { push: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ prepareRecording: vi.fn(), saveDraft: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }));

const take: Take = {
  blob: new Blob([new Uint8Array([1])], { type: "audio/webm" }),
  mimeType: "audio/webm",
  durationMs: 1000,
  recordedAt: 1,
  recordedAtMono: 0,
  serverRecordedAt: null,
  uploadedPath: null,
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
  stream: unknown;
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(stream: unknown) {
    this.stream = stream;
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
      value: {
        getUserMedia: async ({ video }: MediaStreamConstraints) => {
          if (video) throw new DOMException("no camera", "NotFoundError"); // no mirror in this test
          return { getTracks: () => [track], getAudioTracks: () => [track] };
        },
      },
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

// The camera is only a mirror: shown while recording, never recorded, and never in the way.
describe("the camera mirror", () => {
  const fakeTrack = () => ({ stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
  function devices(camera: () => Promise<unknown>) {
    const mic = fakeTrack();
    const microphone = { getTracks: () => [mic], getAudioTracks: () => [mic] };
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) =>
      constraints.video ? camera() : microphone,
    );
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
    return { microphone, getUserMedia };
  }
  // A real (happy-dom) MediaStream, as a <video> takes only those, with the given camera track.
  function cameraStream(lens: ReturnType<typeof fakeTrack>) {
    return Object.assign(new MediaStream(), { getTracks: () => [lens] });
  }

  it("shows the member's camera while recording, records only the microphone, and lets the camera go", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const lens = fakeTrack();
    const camera = cameraStream(lens);
    const { microphone, getUserMedia } = devices(async () => camera);
    const { Recorder } = await load();
    await render(<Recorder />);
    await click(button("Start recording"));
    await settle();

    expect(getUserMedia).toHaveBeenNthCalledWith(1, expect.objectContaining({ audio: expect.anything() }));
    expect(getUserMedia.mock.calls[0][0]).not.toHaveProperty("video"); // the microphone alone, first
    expect(FakeRecorder.last?.stream).toBe(microphone); // the camera never reaches the recorder
    const video = document.querySelector("video");
    expect(video?.srcObject).toBe(camera);
    expect(video?.muted).toBe(true);

    // The recorder's stop event (nothing recorded here) ends the recording and the preview.
    await click(button("Next question"));
    await click(button("Next question"));
    await click(button("Finish"));
    await act(async () => FakeRecorder.last?.onstop?.());
    expect(lens.stop).toHaveBeenCalled();
    expect(document.querySelector("video")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("records as before, without the mirror, when the camera is blocked", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    devices(async () => {
      throw new DOMException("blocked", "NotAllowedError");
    });
    const { Recorder } = await load();
    await render(<Recorder />);
    await click(button("Start recording"));
    await settle();
    expect(button("Next question")).toBeTruthy();
    expect(FakeRecorder.last?.state).toBe("recording");
    expect(document.querySelector("video")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("lets go of a camera allowed only after the recording has finished", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const lens = fakeTrack();
    let allow: (stream: unknown) => void = () => {};
    devices(() => new Promise((resolve) => (allow = resolve)));
    const { Recorder } = await load();
    await render(<Recorder />);
    await click(button("Start recording"));
    await settle();
    await click(button("Next question"));
    await click(button("Next question"));
    await click(button("Finish"));
    await act(async () => allow(cameraStream(lens)));
    expect(lens.stop).toHaveBeenCalled();
    expect(document.querySelector("video")).toBeNull();
    vi.unstubAllGlobals();
  });
});
