// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { button, click, render, settle, text } from "@/test/dom";
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

// The camera is only a mirror: the member's choice, shown before and while they record, never
// recorded, and never asked about mid-take.
describe("the camera mirror", () => {
  // A track that remembers its listeners, so a test can end it as an unplugged camera would.
  function fakeTrack() {
    const listeners: Record<string, (() => void)[]> = {};
    return {
      stop: vi.fn(),
      addEventListener: vi.fn((type: string, listener: () => void) => (listeners[type] ??= []).push(listener)),
      removeEventListener: vi.fn(),
      fire: (type: string) => act(async () => listeners[type]?.forEach((listener) => listener())),
    };
  }
  // permission: what navigator.permissions says about the camera ("granted": allowed here before).
  function devices(camera: () => Promise<unknown>, permission: PermissionState = "prompt") {
    const mic = fakeTrack();
    const microphone = { getTracks: () => [mic], getAudioTracks: () => [mic] };
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) =>
      constraints.video ? camera() : microphone,
    );
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
    Object.defineProperty(navigator, "permissions", {
      value: { query: vi.fn(async () => ({ state: permission })) },
      configurable: true,
    });
    const cameraAsks = () => getUserMedia.mock.calls.filter(([constraints]) => constraints.video).length;
    return { microphone, getUserMedia, cameraAsks };
  }
  // A real (happy-dom) MediaStream, as a <video> takes only those, with the given camera track.
  function cameraStream(lens: ReturnType<typeof fakeTrack>) {
    return Object.assign(new MediaStream(), { getTracks: () => [lens] });
  }
  const video = () => document.querySelector("video");
  async function record() {
    await click(button("Start recording"));
    await settle();
  }
  async function finish() {
    await click(button("Next question"));
    await click(button("Next question"));
    await click(button("Finish"));
  }

  it("stays off unless the member shows it, so no camera question comes mid-take", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const { cameraAsks } = devices(async () => cameraStream(fakeTrack()));
    const { Recorder } = await load();
    await render(<Recorder />);
    await record();
    expect(button("Next question")).toBeTruthy();
    expect(cameraAsks()).toBe(0);
    expect(video()).toBeNull();
    vi.unstubAllGlobals();
  });

  it("shows the member to themselves before and while they record, records only the microphone, and turns off with the take", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const lens = fakeTrack();
    const camera = cameraStream(lens);
    const { microphone, getUserMedia } = devices(async () => camera);
    const { Recorder } = await load();
    await render(<Recorder />);

    await click(button("Show my camera"));
    await settle();
    const mirror = video();
    expect(mirror?.srcObject).toBe(camera);
    // Muted, inline and playing by itself, as iPhone Safari needs; mirrored; hidden from screen readers.
    expect(mirror?.muted).toBe(true);
    expect(mirror?.hasAttribute("playsinline")).toBe(true);
    expect(mirror?.autoplay).toBe(true);
    expect(mirror?.classList.contains("-scale-x-100")).toBe(true);
    expect(mirror?.getAttribute("aria-hidden")).toBe("true");
    expect(button("Hide my camera")).toBeTruthy();

    await record();
    expect(getUserMedia).toHaveBeenLastCalledWith(expect.objectContaining({ audio: expect.anything() }));
    expect(getUserMedia.mock.lastCall?.[0]).not.toHaveProperty("video");
    expect(FakeRecorder.last?.stream).toBe(microphone); // the camera never reaches the recorder
    expect(video()).toBe(mirror); // the same mirror, carried on into the recording

    await finish();
    expect(video()).toBeNull(); // gone at Finish
    expect(lens.stop).toHaveBeenCalled(); // and off, before the recorder's stop event comes
    await act(async () => FakeRecorder.last?.onstop?.()); // nothing recorded here
    expect(button("Show my camera")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("comes on by itself at Start where the browser allows it without asking", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const camera = cameraStream(fakeTrack());
    const { microphone } = devices(async () => camera, "granted");
    const { Recorder } = await load();
    await render(<Recorder />);
    await record();
    expect(video()?.srcObject).toBe(camera);
    expect(FakeRecorder.last?.stream).toBe(microphone);
    vi.unstubAllGlobals();
  });

  it("stays off at Start once the member has hidden it", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const { cameraAsks } = devices(async () => cameraStream(fakeTrack()), "granted");
    const { Recorder } = await load();
    await render(<Recorder />);
    await click(button("Show my camera"));
    await settle();
    await click(button("Hide my camera"));
    await record();
    expect(cameraAsks()).toBe(1);
    expect(video()).toBeNull();
    vi.unstubAllGlobals();
  });

  it("holds Start while the browser asks about the camera, as Chrome asks nothing else meanwhile", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    let allow: (stream: unknown) => void = () => {};
    devices(() => new Promise((resolve) => (allow = resolve)));
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await click(button("Show my camera"));
    expect(button("Start recording").disabled).toBe(true);
    expect(text(page.container)).toContain("Answer your browser's question about the camera");
    await click(button("Waiting for your camera…")); // asking again does nothing
    await act(async () => allow(cameraStream(fakeTrack())));
    expect(button("Start recording").disabled).toBe(false);
    expect(video()).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it("says so when the camera is blocked, and the member records as before", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    devices(async () => {
      throw new DOMException("blocked", "NotAllowedError");
    });
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await click(button("Show my camera"));
    await settle();
    expect(text(page.container)).toContain("Your camera isn't available");
    await record();
    expect(FakeRecorder.last?.state).toBe("recording");
    expect(video()).toBeNull();
    vi.unstubAllGlobals();
  });

  it("lets go of a camera allowed only after the member left the page", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const lens = fakeTrack();
    let allow: (stream: unknown) => void = () => {};
    devices(() => new Promise((resolve) => (allow = resolve)));
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await click(button("Show my camera"));
    await page.rerender(<></>);
    await act(async () => allow(cameraStream(lens)));
    expect(lens.stop).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("lets go of a camera that came on by itself only after the recording finished", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const lens = fakeTrack();
    let allow: (stream: unknown) => void = () => {};
    devices(() => new Promise((resolve) => (allow = resolve)), "granted");
    const { Recorder } = await load();
    await render(<Recorder />);
    await record();
    await finish();
    await act(async () => FakeRecorder.last?.onstop?.());
    await act(async () => allow(cameraStream(lens)));
    expect(lens.stop).toHaveBeenCalled();
    expect(video()).toBeNull();
    vi.unstubAllGlobals();
  });

  it("can be hidden mid-take, and the recording carries on", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const lens = fakeTrack();
    devices(async () => cameraStream(lens), "granted");
    const { Recorder } = await load();
    await render(<Recorder />);
    await record();
    await click(button("Hide my camera"));
    expect(lens.stop).toHaveBeenCalled();
    expect(video()).toBeNull();
    expect(FakeRecorder.last?.state).toBe("recording");
    expect(button("Next question")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("turns off when Sign out finishes the recording, before the recorder's stop event", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const lens = fakeTrack();
    devices(async () => cameraStream(lens), "granted");
    const { Recorder, finishRecording, currentSave } = await load();
    await render(<Recorder />);
    await record();
    await act(async () => finishRecording()); // what Sign out does first
    expect(lens.stop).toHaveBeenCalled();
    expect(video()).toBeNull();
    expect(currentSave()).not.toBeNull(); // and Sign out waits for the take
    vi.unstubAllGlobals();
  });

  it("turns off when the member leaves the page", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const lens = fakeTrack();
    devices(async () => cameraStream(lens));
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await click(button("Show my camera"));
    await settle();
    await page.rerender(<></>);
    expect(lens.stop).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("takes the mirror away when the camera goes away by itself", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const lens = fakeTrack();
    devices(async () => cameraStream(lens));
    const { Recorder } = await load();
    await render(<Recorder />);
    await click(button("Show my camera"));
    await settle();
    await lens.fire("ended"); // unplugged, or taken by another app
    expect(video()).toBeNull();
    expect(button("Show my camera")).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
