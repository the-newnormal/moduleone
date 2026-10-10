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
  await click(button("Next question"));
  await click(button("Next question"));
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
    expect(stage?.textContent).toContain("Question 1 of 3");
    expect(stage?.querySelector("h3")?.textContent).toBe("What have you done this week?");
    expect(stage?.contains(button("Next question"))).toBe(true);

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

  it("says why when it's blocked, and there's still no Start", async () => {
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
    expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Start recording")).toBe(false);
    expect(getUserMedia.mock.calls.some(([constraints]) => constraints.audio)).toBe(false); // no microphone either
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
    expect(text(page.container)).toContain("Question 1 of 3");
    expect(document.activeElement).toBe(button("Next question"));
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
