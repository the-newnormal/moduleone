// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OPENING_QUESTION, QUESTIONS } from "@/lib/checkin/week";
import { button, click, queryButton, render, settle, text } from "@/test/dom";
import type { LiveReady } from "./live/api";
import type { ShownOffer } from "./live/contract";
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
// A real (happy-dom) MediaStream, as a <video> takes only those, with the given camera track.
function cameraStream(lens: ReturnType<typeof fakeTrack> = fakeTrack()) {
  return Object.assign(new MediaStream(), { getTracks: () => [lens] });
}
// The browser's devices. permission: what navigator.permissions says about the camera ("granted":
// allowed here before, so it comes on without asking).
function devices(camera: () => Promise<unknown> = async () => cameraStream(), permission: PermissionState = "prompt") {
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
const video = () => document.querySelector("video");
async function turnOnCamera() {
  await click(button("Turn on my camera"));
  await settle();
}
async function record() {
  await click(button("Start recording"));
  await settle();
}
async function finish() {
  await click(button("Finish"));
}

describe("a recording stopped by Finish", () => {
  it("has its save registered at once, before the stop event, so Sign out waits for it", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    devices();
    const { Recorder, currentSave } = await load();
    await render(<Recorder />);
    await turnOnCamera();
    await record();
    await finish();
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

// The member records looking at themselves: the camera has to be on to start, it can't be hidden,
// and it's only a mirror, never recorded.
describe("the camera", () => {
  it("is asked for only when the member turns it on, and there's no Start without it", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const { cameraAsks } = devices();
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await settle();
    expect(cameraAsks()).toBe(0); // no question just for opening the page
    expect(text(page.container)).toContain("You record with your camera on");
    expect(document.querySelector("button")?.textContent).toBe("Turn on my camera");
    expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Start recording")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("offers no way to record without it while it can still come on", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    let allow: (stream: unknown) => void = () => {};
    devices(() => new Promise((resolve) => (allow = resolve)));
    const { Recorder } = await load();
    await render(<Recorder />);
    await settle();
    const wayRound = () => [...document.querySelectorAll("button")].some((b) => b.textContent === "Record without camera");
    expect(wayRound()).toBe(false); // before it's asked for
    await click(button("Turn on my camera"));
    expect(wayRound()).toBe(false); // while the browser asks
    await act(async () => allow(cameraStream()));
    expect(video()).not.toBeNull();
    expect(wayRound()).toBe(false); // on the stage
    vi.unstubAllGlobals();
  });

  it("records without it, only the microphone and in the card, when it can't come on", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const { microphone, getUserMedia } = devices(async () => {
      throw new DOMException("none", "NotFoundError");
    });
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await turnOnCamera();
    await click(button("Record without camera"));
    await settle();
    expect(getUserMedia.mock.lastCall?.[0]).toEqual(expect.objectContaining({ audio: expect.anything() }));
    expect(getUserMedia.mock.lastCall?.[0]).not.toHaveProperty("video");
    expect(FakeRecorder.last?.stream).toBe(microphone);
    expect(FakeRecorder.last?.state).toBe("recording");
    expect(video()).toBeNull();
    expect(page.container.querySelector("h3")?.textContent).toBe(DEFAULT_OPENING_QUESTION);
    expect(document.activeElement).toBe(button("Finish"));
    await finish();
    expect(text(page.container)).toContain("Saving your recording");
    vi.unstubAllGlobals();
  });

  it("keeps the reason and the way round after a take without it comes to nothing", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    devices(async () => {
      throw new DOMException("blocked", "NotAllowedError");
    }, "denied");
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await turnOnCamera();
    await click(button("Record without camera"));
    await settle();
    await finish();
    await act(async () => FakeRecorder.last?.onstop?.()); // no chunks: nothing was recorded
    await settle();
    expect(text(page.container)).toContain("Nothing was recorded.");
    expect(text(page.container)).toContain("Camera access is blocked.");
    expect(button("Record without camera")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("says when the computer blocks the microphone, or its question was closed", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    let micError = new DOMException("Permission denied by system", "NotAllowedError");
    const { getUserMedia } = devices(async () => {
      throw new DOMException("none", "NotFoundError");
    });
    getUserMedia.mockImplementation(async (constraints: MediaStreamConstraints) => {
      throw constraints.video ? new DOMException("none", "NotFoundError") : micError;
    });
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await turnOnCamera();
    await click(button("Record without camera"));
    await settle();
    expect(text(page.container)).toContain("Your computer doesn't let this browser use the microphone.");
    expect(text(page.container)).not.toContain("Allow it for this site");
    micError = new DOMException("Permission dismissed", "NotAllowedError");
    await click(button("Record without camera"));
    await settle();
    expect(text(page.container)).toContain("The microphone question was closed. Try again, and choose Allow when asked.");
    vi.unstubAllGlobals();
  });

  it("goes back to the card when it goes away while the browser asks about the microphone", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const lens = fakeTrack();
    const camera = cameraStream(lens);
    let allowMic: (stream: unknown) => void = () => {};
    const { microphone, getUserMedia } = devices(async () => camera);
    getUserMedia.mockImplementation((constraints: MediaStreamConstraints) =>
      constraints.video ? Promise.resolve(camera) : new Promise((resolve) => (allowMic = resolve)),
    );
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await turnOnCamera();
    const before = FakeRecorder.last;
    await click(button("Start recording")); // the browser asks about the microphone
    await lens.fire("ended"); // unplugged meanwhile
    await act(async () => allowMic(microphone));
    await settle();
    expect(FakeRecorder.last).toBe(before); // no take began
    expect(microphone.getTracks()[0].stop).toHaveBeenCalled(); // and the microphone was let go
    expect(text(page.container)).toContain("Your camera stopped before the recording began.");
    expect(button("Turn on my camera")).toBeTruthy();
    expect(button("Record without camera")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("comes on by itself where the browser allows it without asking", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const camera = cameraStream();
    devices(async () => camera, "granted");
    const { Recorder } = await load();
    await render(<Recorder />);
    await settle();
    expect(video()?.srcObject).toBe(camera);
    expect(button("Start recording")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("shows the member to themselves on a stage, records only the microphone, and turns off with the take", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const lens = fakeTrack();
    const camera = cameraStream(lens);
    const { microphone, getUserMedia } = devices(async () => camera);
    const { Recorder } = await load();
    await render(<Recorder />);

    await turnOnCamera();
    const mirror = video();
    expect(mirror?.srcObject).toBe(camera);
    // Muted, inline and playing by itself, as iPhone Safari needs; mirrored; hidden from screen readers.
    expect(mirror?.muted).toBe(true);
    expect(mirror?.hasAttribute("playsinline")).toBe(true);
    expect(mirror?.autoplay).toBe(true);
    expect(mirror?.classList.contains("-scale-x-100")).toBe(true);
    expect(mirror?.getAttribute("aria-hidden")).toBe("true");
    const stage = mirror?.parentElement;
    expect(stage?.contains(button("Start recording"))).toBe(true); // the controls are on the stage
    expect(document.activeElement).toBe(button("Start recording")); // and focus went with them
    expect(document.documentElement.style.overflow).toBe("hidden"); // the page behind stays put

    await record();
    expect(getUserMedia).toHaveBeenLastCalledWith(expect.objectContaining({ audio: expect.anything() }));
    expect(getUserMedia.mock.lastCall?.[0]).not.toHaveProperty("video");
    expect(FakeRecorder.last?.stream).toBe(microphone); // the camera never reaches the recorder
    expect(video()).toBe(mirror); // the same mirror, carried on into the recording
    expect(stage?.textContent).toContain("Recording");
    expect(stage?.querySelector("h3")?.textContent).toBe(DEFAULT_OPENING_QUESTION);
    expect(stage?.contains(button("Finish"))).toBe(true);

    await finish();
    expect(video()).toBeNull(); // gone at Finish
    expect(lens.stop).toHaveBeenCalled(); // and off, before the recorder's stop event comes
    expect(document.documentElement.style.overflow).toBe("");
    await act(async () => FakeRecorder.last?.onstop?.()); // nothing recorded here
    expect(button("Turn on my camera")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("doesn't come on a second time when the member turned it on before the browser said it was allowed", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    let allow: (stream: unknown) => void = () => {};
    const { cameraAsks } = devices(() => new Promise((resolve) => (allow = resolve)), "granted");
    let answer: (status: { state: PermissionState }) => void = () => {};
    Object.defineProperty(navigator, "permissions", {
      value: { query: () => new Promise((resolve) => (answer = resolve)) },
      configurable: true,
    });
    const { Recorder } = await load();
    await render(<Recorder />);
    await click(button("Turn on my camera"));
    await act(async () => answer({ state: "granted" })); // while the camera is still starting
    expect(cameraAsks()).toBe(1);
    await act(async () => allow(cameraStream()));
    expect(video()).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it("can't be hidden, before or during the take", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    devices(undefined, "granted");
    const { Recorder } = await load();
    await render(<Recorder />);
    await settle();
    const hideable = () => [...document.querySelectorAll("button")].some((b) => /hide|off/i.test(b.textContent ?? ""));
    expect(hideable()).toBe(false);
    await record();
    expect(hideable()).toBe(false);
    vi.unstubAllGlobals();
  });

  it("holds the way on while the browser asks about it, as Chrome asks nothing else meanwhile", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    let allow: (stream: unknown) => void = () => {};
    const { cameraAsks } = devices(() => new Promise((resolve) => (allow = resolve)));
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await click(button("Turn on my camera"));
    expect(button("Waiting for your camera…")).toBeTruthy();
    expect(text(page.container)).toContain("If your browser asks about the camera, answer it to go on");
    await click(button("Waiting for your camera…")); // asking again does nothing
    expect(cameraAsks()).toBe(1);
    await act(async () => allow(cameraStream()));
    expect(button("Start recording")).toBeTruthy();
    expect(video()).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it("says why when it's blocked, and offers only to try again or to record without it", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const { getUserMedia } = devices(async () => {
      throw new DOMException("blocked", "NotAllowedError");
    });
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await turnOnCamera();
    const blocked = "Camera access is blocked. Allow it for this site in your browser's settings, then try again.";
    expect(text(page.container)).toContain(blocked);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(blocked); // screen readers hear it,
    expect(text(document.querySelector("[aria-live]") ?? undefined)).not.toContain(blocked); // once
    expect(button("Turn on my camera")).toBeTruthy(); // to try again once allowed
    expect(button("Record without camera")).toBeTruthy();
    expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Start recording")).toBe(false);
    expect(getUserMedia.mock.calls.some(([constraints]) => constraints.audio)).toBe(false); // no microphone yet
    vi.unstubAllGlobals();
  });

  it("says when there's no camera, or it's busy", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    let error = new DOMException("none", "NotFoundError");
    devices(async () => {
      throw error;
    });
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await turnOnCamera();
    expect(text(page.container)).toContain("No camera found. Connect one, then try again.");
    error = new DOMException("busy", "NotReadableError");
    await turnOnCamera();
    expect(text(page.container)).toContain("Your camera is busy in another app. Close that app, then try again.");
    vi.unstubAllGlobals();
  });

  it("says why when it can't come on by itself", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    devices(async () => {
      throw new DOMException("busy", "NotReadableError");
    }, "granted");
    const { Recorder } = await load();
    await render(<Recorder />);
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Your camera is busy in another app. Close that app, then try again.",
    );
    expect(button("Turn on my camera")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("says when the computer blocks the camera for the browser, or the browser's question was closed", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    // Chrome's words for each: the site setting can't fix either.
    let error = new DOMException("Permission denied by system", "NotAllowedError");
    devices(async () => {
      throw error;
    });
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await turnOnCamera();
    expect(text(page.container)).toContain("Your computer doesn't let this browser use the camera.");
    expect(text(page.container)).not.toContain("Allow it for this site");
    error = new DOMException("Permission dismissed", "NotAllowedError");
    await turnOnCamera();
    expect(text(page.container)).toContain("The camera question was closed. Turn on your camera again, and choose Allow when asked.");
    vi.unstubAllGlobals();
  });

  it("doesn't come on by itself while the page refreshes to show a newer draft", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const { cameraAsks } = devices(undefined, "granted");
    const { Recorder, trackSave } = await load();
    void trackSave(Promise.resolve<SaveOutcome>({ step: "superseded" })); // a newer draft was saved elsewhere
    await render(<Recorder />);
    await settle();
    router.refresh.mockReturnValueOnce(new Promise(() => {})); // the newer draft is still on its way
    await click(button("Show my draft"));
    await settle();
    expect(cameraAsks()).toBe(0);
    expect(video()).toBeNull();
    vi.unstubAllGlobals();
  });

  it("keeps the way on held in a new recorder while an earlier camera question is still open", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    let allow: (stream: unknown) => void = () => {};
    devices(() => new Promise((resolve) => (allow = resolve)));
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await click(button("Turn on my camera"));
    await page.rerender(<></>); // left by a link; the browser's question stays open
    await page.rerender(<Recorder />);
    expect(button("Waiting for your camera…")).toBeTruthy();
    expect(text(page.container)).toContain("If your browser asks about the camera");
    await act(async () => allow(cameraStream()));
    expect(button("Turn on my camera")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("comes on by itself once a question left open by an earlier visit is answered Allow", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    let allow: (stream: unknown) => void = () => {};
    let asks = 0;
    const { cameraAsks } = devices(() =>
      ++asks === 1 ? new Promise((resolve) => (allow = resolve)) : Promise.resolve(cameraStream()),
    );
    let permission: PermissionState = "prompt";
    Object.defineProperty(navigator, "permissions", {
      value: { query: async () => ({ state: permission }) },
      configurable: true,
    });
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await click(button("Turn on my camera"));
    await page.rerender(<></>); // left by a link; the browser's question stays open
    await page.rerender(<Recorder />);
    await settle();
    permission = "granted";
    await act(async () => allow(cameraStream())); // answered Allow
    await settle();
    expect(cameraAsks()).toBe(2); // the first recorder's camera was let go; this one's came on
    expect(video()).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it("says the browser can't record instead of turning on the camera", async () => {
    vi.stubGlobal("MediaRecorder", undefined);
    const { cameraAsks } = devices();
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await turnOnCamera();
    expect(text(page.container)).toContain("This browser can't record audio here.");
    expect(cameraAsks()).toBe(0);
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
    await click(button("Turn on my camera"));
    await page.rerender(<></>);
    await act(async () => allow(cameraStream(lens)));
    expect(lens.stop).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("lets go of a camera coming on by itself that arrives after the member left", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const lens = fakeTrack();
    let allow: (stream: unknown) => void = () => {};
    devices(() => new Promise((resolve) => (allow = resolve)), "granted");
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await settle(); // asked for by itself
    await page.rerender(<></>);
    await act(async () => allow(cameraStream(lens)));
    expect(lens.stop).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("turns off when Sign out finishes the recording, before the recorder's stop event", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const lens = fakeTrack();
    devices(async () => cameraStream(lens), "granted");
    const { Recorder, finishRecording, currentSave } = await load();
    await render(<Recorder />);
    await settle();
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
    await turnOnCamera();
    await page.rerender(<></>);
    expect(lens.stop).toHaveBeenCalled();
    expect(document.documentElement.style.overflow).toBe("");
    vi.unstubAllGlobals();
  });

  it("keeps the take going in the card when the camera goes away mid-take", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const lens = fakeTrack();
    devices(async () => cameraStream(lens));
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await turnOnCamera();
    await record();
    await lens.fire("ended"); // unplugged, or taken by another app
    expect(video()).toBeNull();
    expect(FakeRecorder.last?.state).toBe("recording");
    expect(page.container.querySelector("h3")?.textContent).toBe(DEFAULT_OPENING_QUESTION);
    expect(document.activeElement).toBe(button("Finish"));
    await finish();
    expect(text(page.container)).toContain("Saving your recording");
    vi.unstubAllGlobals();
  });

  it("stays on, with the same picture, when the microphone can't start", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const lens = fakeTrack();
    const camera = cameraStream(lens);
    const { getUserMedia, cameraAsks } = devices(async () => camera, "granted");
    getUserMedia.mockImplementation(async (constraints: MediaStreamConstraints) => {
      if (constraints.video) return camera;
      throw new DOMException("blocked", "NotAllowedError");
    });
    const { Recorder } = await load();
    await render(<Recorder />);
    await settle();
    const mirror = video();
    await record();
    expect(video()).toBe(mirror);
    expect(lens.stop).not.toHaveBeenCalled();
    expect(mirror?.parentElement?.textContent).toContain("Microphone access is blocked");
    expect(cameraAsks()).toBe(1); // not a second camera over the first
    vi.unstubAllGlobals();
  });

  it("comes back on by itself, where the browser allows it, after a take with nothing in it", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const { cameraAsks } = devices(undefined, "granted");
    const { Recorder } = await load();
    await render(<Recorder />);
    await settle();
    await record();
    await finish();
    await act(async () => FakeRecorder.last?.onstop?.()); // no chunks: nothing was recorded
    await settle();
    expect(cameraAsks()).toBe(2);
    expect(video()).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it("turns off at the ten-minute limit, with the take", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const lens = fakeTrack();
    devices(async () => cameraStream(lens), "granted");
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await settle();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      await record();
      await act(async () => {
        vi.advanceTimersByTime(10 * 60 * 1000 + 500);
      });
      expect(FakeRecorder.last?.state).toBe("inactive");
      expect(lens.stop).toHaveBeenCalled();
      expect(video()).toBeNull();
      expect(text(page.container)).toContain("Saving your recording");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("takes the stage away when the camera goes away by itself, and asks to turn it on again", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const lens = fakeTrack();
    devices(async () => cameraStream(lens));
    const { Recorder } = await load();
    await render(<Recorder />);
    await turnOnCamera();
    await lens.fire("ended"); // unplugged, or taken by another app
    expect(video()).toBeNull();
    expect(button("Turn on my camera")).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

// Every check-in asks one open question (page.tsx); without live check-ins, nothing follows it up.
describe("the one question", () => {
  const QUESTION = "How did your week go, and how's the team?";

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is the only question, before and during the take, with Finish and nothing else to press", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    devices();
    fakes.startLive.mockClear();
    const { Recorder } = await load();
    const page = await render(<Recorder opening={QUESTION} />);
    expect(text(page.container)).toContain("There's one question.");
    expect(text(page.container)).toContain(QUESTION);
    for (const { text: question } of QUESTIONS) expect(text()).not.toContain(question);

    await turnOnCamera();
    const stage = video()?.parentElement;
    expect(stage?.textContent).toContain(QUESTION);
    expect(stage?.textContent).toContain("Answer it out loud, then press Finish.");

    await record();
    expect(stage?.querySelector("h3")?.textContent).toBe(QUESTION);
    expect(document.activeElement).toBe(button("Finish"));
    expect(queryButton("Next question")).toBeNull();
    expect(queryButton("Different question")).toBeNull();
    expect(stage?.querySelector("ul")).toBeNull(); // no areas to tick off: nothing follows it up
    expect(stage?.textContent).not.toContain("a follow-up may appear");
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(`Recording. ${QUESTION}`);
    expect(fakes.startLive).not.toHaveBeenCalled();
    for (const { text: question } of QUESTIONS) expect(text()).not.toContain(question);
  });

  it("asks the built-in opening question when the page gives none", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    devices();
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    expect(text(page.container)).toContain(DEFAULT_OPENING_QUESTION);
  });

  it("keeps the question in the live region beside the one-minute warning, so a later question is still read", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    devices(undefined, "granted");
    const { Recorder } = await load();
    await render(<Recorder opening={QUESTION} />);
    await settle();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    await record();
    await act(async () => {
      vi.advanceTimersByTime(9 * 60 * 1000 + 500);
    });
    const spans = [...document.querySelectorAll('[aria-live="polite"] > span')].map((span) => span.textContent?.trim());
    expect(spans).toEqual([`Recording. ${QUESTION}`, "One minute left. The recording stops at 10 minutes."]);
    expect(video()?.parentElement?.textContent).toContain("One minute left.");
  });
});

const SESSION = "5e550000-0000-4000-8000-000000000001";
const OPENING = "Talk me through your week: what you worked on, what came of it, and how you're feeling about the team.";
const READY: LiveReady = {
  status: "ready",
  sessionId: SESSION,
  sttModel: "gpt-live-transcribe",
  opening: OPENING,
  pacing: { showAfterSilenceMs: 1500, stoppedSilenceMs: 3000, minQuestionMs: 8000, minWordsPerQuestion: 15, firstFollowUpAfterMs: 20_000 },
};

// With live check-ins on, the member still records looking at themselves: the coach's question is
// laid over the camera, as the fixed ones are.
describe("a live check-in", () => {
  const connection = { commit: vi.fn(), close: vi.fn() };

  // The devices, and the live check-in's browser side. permission: as for devices.
  function liveDevices(camera?: () => Promise<unknown>, permission?: PermissionState) {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const found = devices(camera, permission);
    connection.close.mockReset();
    fakes.connectLiveTranscription.mockReset().mockResolvedValue(connection);
    // Level samples, so live coaching carries on for the length of a test.
    fakes.startLevelMeter.mockReset().mockImplementation((_stream: MediaStream, onLevel: (level: number, now: number) => void) => {
      const timer = setInterval(() => onLevel(0.002, performance.now()), 50);
      return () => clearInterval(timer);
    });
    fakes.endLive.mockReset();
    fakes.askCoach.mockReset().mockResolvedValue(null);
    fakes.startLive.mockReset().mockResolvedValue(READY);
    return found;
  }

  async function startRecording(start: unknown = READY) {
    const found = liveDevices();
    fakes.startLive.mockResolvedValue(start);
    const { Recorder, ...saves } = await load();
    const page = await render(<Recorder opening={OPENING} live />);
    await turnOnCamera();
    await record();
    return { ...found, ...saves, page };
  }

  // What the take is saved through, so a test can see the take reach the draft.
  function saving() {
    fakes.prepareRecording.mockResolvedValue({
      status: "ready",
      path: "3e3b0000-0000-4000-8000-000000000003/2026-10-05-take.webm",
      token: "token-1",
      contentType: "audio/webm",
    });
    fakes.createClient.mockReturnValue({
      storage: { from: () => ({ uploadToSignedUrl: async () => ({ error: null }) }) },
    });
    fakes.saveDraft.mockReset().mockResolvedValue({ status: "saved" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ now: Date.now() }), { headers: { "content-type": "application/json" } })),
    );
  }

  const stage = () => video()?.parentElement ?? null;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts with the one open question, not the three fixed ones, and the camera first", async () => {
    liveDevices();
    const { Recorder } = await load();
    await render(<Recorder opening={OPENING} live />);
    expect(text()).toContain("We'll start with one question.");
    expect(text()).toContain("You record with your camera on");
    expect(text()).toContain(OPENING);
    expect(text()).not.toContain("What have you done this week?");
    expect(button("Turn on my camera")).toBeTruthy();
    expect(queryButton("Start recording")).toBeNull();
  });

  it("shows the open question on the stage before the take, and asks for no live session yet", async () => {
    liveDevices(undefined, "granted");
    const { Recorder } = await load();
    await render(<Recorder opening={OPENING} live />);
    await settle();
    expect(stage()?.textContent).toContain("Ready when you are.");
    expect(stage()?.textContent).toContain(OPENING);
    expect(text().split(OPENING)).toHaveLength(2); // once: not again in the card under the stage
    expect(stage()?.textContent).not.toContain("What have you done this week?");
    expect(document.activeElement).toBe(button("Start recording"));
    expect(fakes.startLive).not.toHaveBeenCalled();
  });

  it("lays the open question over the camera while recording, with Finish and no Next question", async () => {
    const { microphone } = await startRecording();
    expect(FakeRecorder.last?.stream).toBe(microphone); // the camera never reaches the recorder
    expect(stage()?.querySelector("h3")?.textContent).toBe(OPENING);
    expect(stage()?.contains(button("Finish"))).toBe(true);
    expect(button("Finish")).toBe(document.activeElement);
    expect(button("Finish").className).toContain("bg-white"); // light on the dark stage
    expect(queryButton("Next question")).toBeNull();
    expect(queryButton("Different question")).toBeNull(); // not for the opening question
    expect(stage()?.textContent).toContain("Not yet: What you did");
    expect(stage()?.textContent).toContain("Recording");
    expect(text()).not.toContain("Question 1 of 3");
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain(`Recording. ${OPENING}`);
    // Live transcription hears the microphone, never the camera.
    expect(fakes.connectLiveTranscription).toHaveBeenCalledOnce();
    expect(fakes.startLevelMeter).toHaveBeenCalledWith(microphone, expect.any(Function));
  });

  it("asks for the live session only once the microphone is allowed, however long that takes", async () => {
    const { microphone, getUserMedia } = liveDevices();
    // The browser's prompt stays open until the test answers it.
    let allow: () => void = () => {};
    getUserMedia.mockImplementation((constraints: MediaStreamConstraints) =>
      constraints.video ? Promise.resolve(cameraStream()) : new Promise((resolve) => (allow = () => resolve(microphone))),
    );
    const { Recorder } = await load();
    await render(<Recorder opening={OPENING} live />);
    await turnOnCamera();
    await record();
    expect(text()).toContain("Waiting for your microphone…");
    expect(fakes.startLive).not.toHaveBeenCalled();

    await act(async () => allow());
    await settle();
    expect(fakes.startLive).toHaveBeenCalledOnce();
    expect(fakes.connectLiveTranscription).toHaveBeenCalledOnce();
    expect(stage()?.querySelector("h3")?.textContent).toBe(OPENING);
  });

  it("asks for no live session when the microphone is refused, and keeps the camera on", async () => {
    const { getUserMedia } = liveDevices();
    getUserMedia.mockImplementation(async (constraints: MediaStreamConstraints) => {
      if (constraints.video) return cameraStream();
      throw new DOMException("denied", "NotAllowedError");
    });
    const { Recorder } = await load();
    await render(<Recorder opening={OPENING} live />);
    await turnOnCamera();
    await record();
    expect(button("Start recording")).toBeTruthy();
    expect(stage()?.textContent).toContain("Microphone access is blocked");
    expect(fakes.startLive).not.toHaveBeenCalled();
    expect(fakes.endLive).not.toHaveBeenCalled();
  });

  it("asks for no live session when the camera goes away while the browser asks about the microphone", async () => {
    const lens = fakeTrack();
    const camera = cameraStream(lens);
    const { microphone, getUserMedia } = liveDevices();
    let allowMic: (stream: unknown) => void = () => {};
    getUserMedia.mockImplementation((constraints: MediaStreamConstraints) =>
      constraints.video ? Promise.resolve(camera) : new Promise((resolve) => (allowMic = resolve)),
    );
    const { Recorder } = await load();
    await render(<Recorder opening={OPENING} live />);
    await turnOnCamera();
    await click(button("Start recording"));
    await lens.fire("ended");
    await act(async () => allowMic(microphone));
    await settle();
    expect(text()).toContain("Your camera stopped before the recording began.");
    expect(fakes.startLive).not.toHaveBeenCalled();
  });

  it("keeps the question on the stage, and says follow-ups have stopped, when live questions aren't available", async () => {
    await startRecording({ status: "off" });
    expect(stage()?.querySelector("h3")?.textContent).toBe(OPENING);
    expect(stage()?.textContent).toContain("Follow-up questions have stopped. Keep going, and press Finish when you're done.");
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain("Follow-up questions have stopped.");
    expect(stage()?.textContent).not.toContain("Not yet: What you did"); // no chips once nothing is following up
    expect(stage()?.textContent).not.toContain("a follow-up may appear");
    expect(stage()?.contains(button("Finish"))).toBe(true);
    expect(queryButton("Next question")).toBeNull();
    for (const { text: question } of QUESTIONS) expect(text()).not.toContain(question);
    expect(fakes.connectLiveTranscription).not.toHaveBeenCalled();
  });

  it("saves the take with its live session, ends the session once, and turns the camera off", async () => {
    const lens = fakeTrack();
    liveDevices(async () => cameraStream(lens));
    const { Recorder } = await load();
    await render(<Recorder opening={OPENING} live />);
    await turnOnCamera();
    await record();
    saving();

    await click(button("Finish"));
    // The opening question was still on screen.
    expect(fakes.endLive).toHaveBeenCalledExactlyOnceWith({ sessionId: SESSION, recordedMs: expect.any(Number), shown: 0 });
    expect(connection.close).toHaveBeenCalled();
    expect(lens.stop).toHaveBeenCalled();
    expect(video()).toBeNull();
    await act(async () => {
      FakeRecorder.last?.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }) });
      FakeRecorder.last?.onstop?.();
    });
    for (let i = 0; i < 5; i++) await settle();

    expect(fakes.saveDraft).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ liveSessionId: SESSION }));
    expect(text()).toContain("Saved.");
    expect(fakes.endLive).toHaveBeenCalledOnce();
  });

  it("keeps the live question, and its session, in the card when the camera goes away mid-take", async () => {
    const lens = fakeTrack();
    liveDevices(async () => cameraStream(lens));
    const { Recorder } = await load();
    const page = await render(<Recorder opening={OPENING} live />);
    await turnOnCamera();
    await record();
    await lens.fire("ended"); // unplugged, or taken by another app
    expect(video()).toBeNull();
    expect(FakeRecorder.last?.state).toBe("recording");
    expect(page.container.querySelector("h3")?.textContent).toBe(OPENING);
    expect(document.activeElement).toBe(button("Finish"));
    expect(button("Finish").className).not.toContain("bg-white"); // the card's own button now
    expect(fakes.endLive).not.toHaveBeenCalled();
    expect(connection.close).not.toHaveBeenCalled();
    saving();
    await click(button("Finish"));
    expect(fakes.endLive).toHaveBeenCalledOnce();
    expect(text(page.container)).toContain("Saving your recording");
  });

  it("records with live questions in the card when the camera can't come on", async () => {
    const { microphone } = liveDevices(async () => {
      throw new DOMException("none", "NotFoundError");
    });
    const { Recorder } = await load();
    const page = await render(<Recorder opening={OPENING} live />);
    await turnOnCamera();
    await click(button("Record without camera"));
    await settle();
    expect(FakeRecorder.last?.stream).toBe(microphone);
    expect(video()).toBeNull();
    expect(page.container.querySelector("h3")?.textContent).toBe(OPENING);
    expect(document.activeElement).toBe(button("Finish"));
    expect(fakes.startLive).toHaveBeenCalledOnce();
    expect(fakes.connectLiveTranscription).toHaveBeenCalledOnce();
  });

  it("ends the session and turns the camera off when Sign out finishes the recording", async () => {
    const lens = fakeTrack();
    liveDevices(async () => cameraStream(lens), "granted");
    const { Recorder, finishRecording, currentSave } = await load();
    await render(<Recorder opening={OPENING} live />);
    await settle();
    await record();
    await settle();
    await act(async () => finishRecording()); // what Sign out does first
    expect(fakes.endLive).toHaveBeenCalledOnce();
    expect(lens.stop).toHaveBeenCalled();
    expect(video()).toBeNull();
    expect(currentSave()).not.toBeNull();
  });

  it("ends the session and turns the camera off when the member leaves the page mid-take", async () => {
    const lens = fakeTrack();
    liveDevices(async () => cameraStream(lens));
    const { Recorder } = await load();
    const page = await render(<Recorder opening={OPENING} live />);
    await turnOnCamera();
    await record();
    await settle();
    await page.rerender(<></>);
    expect(fakes.endLive).toHaveBeenCalledOnce();
    expect(lens.stop).toHaveBeenCalled();
    expect(FakeRecorder.last?.state).toBe("inactive"); // the take is finished and saved, as Finish would
  });

  // The real coach, on fake timers, taken as far as showing `offer`: the microphone's level, a
  // transcribed answer, a pause, and the coach's answer. Then live coaching can be made to stop.
  async function coachedTake(offer: ShownOffer) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
    liveDevices(undefined, "granted");
    let level = 0.002;
    fakes.startLevelMeter.mockImplementation((_stream: MediaStream, onLevel: (level: number, now: number) => void) => {
      const timer = setInterval(() => onLevel(level, performance.now()), 50);
      return () => clearInterval(timer);
    });
    let onEvent: ((event: unknown) => void) | null = null;
    let onFailure: (() => void) | null = null;
    fakes.connectLiveTranscription.mockImplementation(async (options: { onEvent: (event: unknown) => void; onFailure: () => void }) => {
      onEvent = options.onEvent;
      onFailure = options.onFailure;
      return connection;
    });
    // No waiting on the opening question, so the test needn't run for long.
    fakes.startLive.mockResolvedValue({
      ...READY,
      pacing: { showAfterSilenceMs: 500, stoppedSilenceMs: 1000, minQuestionMs: 0, minWordsPerQuestion: 0, firstFollowUpAfterMs: 0 },
    });
    fakes.askCoach.mockResolvedValue({ status: "ok", degraded: false, offer, touched: { activity: true, excellence: false, morale: false } });
    const { Recorder } = await load();
    await render(<Recorder opening={OPENING} live />);
    await advance(0); // the camera, allowed before, comes on by itself
    await click(button("Start recording"));
    await advance(500); // quiet: the meter learns the room
    level = 0.2;
    await advance(3000); // talking
    act(() => {
      onEvent?.({ type: "committed", itemId: "item_1", previousItemId: null });
      onEvent?.({
        type: "completed",
        itemId: "item_1",
        transcript: "This week I mostly worked on the vendor onboarding for the Jurong site and we got the first three suppliers through the checks.",
      });
    });
    level = 0.002;
    await advance(3000); // a pause: the coach is asked, and its answer shown
    return { stop: () => act(() => onFailure?.()) };
  }

  it("keeps a follow-up on screen, without Different question or the areas, when live coaching stops after it", async () => {
    try {
      const take = await coachedTake({ id: 2, kind: "question", text: "What came of the vendor onboarding?" });
      expect(stage()?.querySelector("h3")?.textContent).toBe("What came of the vendor onboarding?");
      expect(button("Different question")).toBeTruthy();
      take.stop();
      expect(stage()?.querySelector("h3")?.textContent).toBe("What came of the vendor onboarding?"); // not back to the opening
      expect(queryButton("Different question")).toBeNull();
      expect(stage()?.querySelector("ul")).toBeNull();
      expect(stage()?.textContent).toContain("Follow-up questions have stopped.");
      expect(document.activeElement).toBe(button("Finish"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds no note to keep going under a closing line when live coaching stops after it", async () => {
    try {
      const closing = "Thank you for sharing that. Say as much or as little as you like, and press Finish whenever you're ready.";
      const take = await coachedTake({ id: 2, kind: "closing", text: closing }); // the line after a hard moment
      expect(stage()?.querySelector("h3")?.textContent).toBe(closing);
      take.stop();
      expect(stage()?.querySelector("h3")?.textContent).toBe(closing);
      expect(text()).not.toContain("Follow-up questions have stopped.");
    } finally {
      vi.useRealTimers();
    }
  });
});
