// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OPENING_QUESTION, QUESTIONS } from "@/lib/checkin/week";
import { button, click, queryButton, render, settle, text } from "@/test/dom";
import { VOICE_ONLY_LINE } from "./camera-stage";
import type { LiveReady } from "./live/api";
import { MAX_READS } from "./live/pacing";
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
// made: how many were built since devices() was last called (one per take, whatever the camera does).
class FakeRecorder {
  static isTypeSupported = () => true;
  static last: FakeRecorder | null = null;
  static made = 0;
  stream: unknown;
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(stream: unknown) {
    this.stream = stream;
    FakeRecorder.last = this;
    FakeRecorder.made += 1;
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
// Every request for the camera and the microphone together. There must never be one, in any test:
// the camera is only a preview, asked for on its own, and the take is the microphone alone.
const together: MediaStreamConstraints[] = [];
afterEach(() => {
  expect(together.splice(0)).toEqual([]);
});
// The browser's devices. camera: what each request for the camera gets (a new stream each time, by
// default). permission: what navigator.permissions says about the camera ("granted": allowed here
// before, so the browser wouldn't ask; the recorder still waits for the member).
function devices(camera: () => Promise<unknown> = async () => cameraStream(), permission: PermissionState = "prompt") {
  const mic = fakeTrack();
  const microphone = { getTracks: () => [mic], getAudioTracks: () => [mic] };
  const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) =>
    constraints.video ? camera() : microphone,
  );
  FakeRecorder.made = 0;
  // The page's getUserMedia, which refuses the camera and the microphone asked for together (a test
  // replacing getUserMedia's implementation keeps the guard).
  const guarded = async (constraints: MediaStreamConstraints) => {
    if (constraints.audio && constraints.video) {
      together.push(constraints);
      throw new Error("camera and microphone asked for together");
    }
    return getUserMedia(constraints);
  };
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: guarded }, configurable: true });
  Object.defineProperty(navigator, "permissions", {
    value: { query: vi.fn(async () => ({ state: permission })) },
    configurable: true,
  });
  const cameraAsks = () => getUserMedia.mock.calls.filter(([constraints]) => constraints.video).length;
  return { microphone, getUserMedia, cameraAsks };
}
const video = () => document.querySelector("video");
// Everything the recorder's live region has held, change by change (a screen reader reads each).
function liveRegionLog() {
  const region = document.querySelector('[aria-live="polite"]')!;
  const said = [region.textContent ?? ""];
  new MutationObserver(() => said.push(region.textContent ?? "")).observe(region, { childList: true, subtree: true, characterData: true });
  return said;
}
// The text of every node put into the recorder's live region: a screen reader reads each as it is
// put in, even with the same words as the one it replaces.
function addedToLiveRegion() {
  const region = document.querySelector('[aria-live="polite"]')!;
  const added: string[] = [];
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) added.push(node.textContent ?? "");
  }).observe(region, { childList: true, subtree: true });
  return added;
}
// The line under the live question saying what is coming (live-prompt.tsx), word for word ("No more
// follow-ups" with its ending, under the opening question or a closing line, or after a follow-up).
const FOLLOW_UP_LINES = ["Starting follow-ups…", "Listening…", "Checking for a follow-up…", "A follow-up will show when you pause.", "No more follow-ups"];
const NO_FOLLOW_UPS = "No follow-up questions this time. Answer out loud, then press Finish.";
const FELL_BACK = "Follow-up questions have stopped. Keep going, and press Finish when you're done.";
// The recorder where the Diary has it: in this week's section of the page's <main>, under the cover,
// above the member's entries and their players.
function diary(recorder: ReactNode) {
  return (
    <main>
      <header id="cover">
        <h1>Diary</h1>
      </header>
      <section id="this-week">{recorder}</section>
      <section id="entries">
        <audio controls aria-label="Your recording for the week of 28 September 2026" />
        <a href="#this-week">Play it in this week&apos;s entry, above</a>
      </section>
    </main>
  );
}
const inert = (id: string) => document.getElementById(id)?.hasAttribute("inert");
// What a screen reader reads as a control's description, as it lands on it: the text of each element
// its aria-describedby names.
const description = (element: Element | null) =>
  (element?.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? null);
// The part of the camera stage that scrolls when there isn't room for all of it (a short phone).
const scroller = (element: Element) => element.closest('[class~="overflow-y-auto"]');
const follows = (first: Element, second: Element) => (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
const entryPlayer = () => document.querySelector<HTMLAudioElement>("#entries audio")!;
// A media event as the browser fires it on the element.
const fire = (el: HTMLMediaElement, type: string) => act(async () => void el.dispatchEvent(new Event(type)));
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

// A take saved on the way out came back superseded: a newer one, from another device or tab, was
// already the draft. The page hasn't been re-rendered for that draft yet.
describe("a take that wasn't kept because a newer draft was saved", () => {
  it("says so, and Show my draft refreshes the page to show the newer draft", async () => {
    const { Recorder, trackSave } = await load();
    void trackSave(Promise.resolve<SaveOutcome>({ step: "superseded" }));
    router.refresh.mockClear();
    const page = await render(<Recorder />);
    await settle();
    expect(text(page.container)).toContain("You'd already saved a newer recording, on another device or tab");
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Your draft is the newer one.");
    await click(button("Show my draft"));
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(queryButton("Show my draft")).toBeNull();
  });

  it("under a draft, stays held (Submit waits) until the member presses OK, which lets it go", async () => {
    const { Recorder, trackSave, currentSave } = await load();
    const save = trackSave(Promise.resolve<SaveOutcome>({ step: "superseded" }));
    router.refresh.mockClear();
    const page = await render(<Recorder heldOnly />);
    await settle();
    expect(text(page.container)).toContain("You'd already saved a newer recording");
    expect(currentSave()).toBe(save);
    await click(button("OK"));
    expect(currentSave()).toBeNull();
    expect(router.refresh).toHaveBeenCalledOnce();
  });
});

// The Diary lists the member's recordings under the recorder: one still playing would be recorded
// into the new take, and graded with it.
describe("a diary recording playing on the page", () => {
  it("is paused when the member starts recording", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const entry = document.createElement("audio");
    document.body.append(entry);
    const pause = vi.spyOn(entry, "pause");
    devices(async () => {
      throw new DOMException("none", "NotFoundError");
    });
    const { Recorder } = await load();
    await render(<Recorder />);
    await turnOnCamera();
    expect(pause).not.toHaveBeenCalled(); // a camera that can't come on leaves it be
    await click(button("Record without camera"));
    await settle();
    expect(pause).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  // Its controls go out of reach under the stage (inert and covered), so it would play on there
  // with only Start (a take) or Turn off my camera to stop it.
  it("is paused when the camera's stage comes up over it", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    devices();
    const { Recorder } = await load();
    await render(diary(<Recorder />));
    const pause = vi.spyOn(entryPlayer(), "pause");
    await turnOnCamera();
    expect(video()).not.toBeNull();
    expect(inert("entries")).toBe(true);
    expect(pause).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("is paused at once if played while the browser asks about the microphone, before the take", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    let allowMic: (stream: unknown) => void = () => {};
    const { microphone, getUserMedia } = devices();
    getUserMedia.mockImplementation((constraints: MediaStreamConstraints) =>
      constraints.video
        ? Promise.reject(new DOMException("none", "NotFoundError"))
        : new Promise((resolve) => (allowMic = resolve)),
    );
    const { Recorder } = await load();
    await render(diary(<Recorder />));
    const pause = vi.spyOn(entryPlayer(), "pause");
    await turnOnCamera();
    await click(button("Record without camera")); // the browser asks about the microphone
    expect(inert("entries")).toBe(false); // the take is in the card: the Diary stays in reach
    pause.mockClear(); // Start paused everything once already
    await fire(entryPlayer(), "play"); // played while the question is open
    expect(pause).toHaveBeenCalledOnce();
    await act(async () => allowMic(microphone));
    await settle();
    expect(FakeRecorder.last?.state).toBe("recording");
    vi.unstubAllGlobals();
  });

  it("is paused at once if played while the take records in the card, without the camera", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    devices(async () => {
      throw new DOMException("none", "NotFoundError");
    });
    const { Recorder } = await load();
    await render(diary(<Recorder />));
    const pause = vi.spyOn(entryPlayer(), "pause");
    await turnOnCamera();
    await click(button("Record without camera"));
    await settle();
    expect(inert("entries")).toBe(false); // in view, and in reach: there's no stage over it
    pause.mockClear(); // Start paused everything once already
    await fire(entryPlayer(), "play");
    expect(pause).toHaveBeenCalledOnce();
    await finish();
    pause.mockClear();
    await fire(entryPlayer(), "play"); // the microphone is off again: it plays
    expect(pause).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("is paused at once if played during a take on the stage, while the mirror plays on", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    devices();
    const { Recorder } = await load();
    await render(diary(<Recorder />));
    const pause = vi.spyOn(entryPlayer(), "pause");
    await turnOnCamera();
    await record();
    const mirror = vi.spyOn(video()!, "pause");
    pause.mockClear();
    await fire(entryPlayer(), "play");
    await fire(video()!, "play");
    expect(pause).toHaveBeenCalledOnce();
    expect(mirror).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

// The member can record looking at themselves: the camera is optional, chosen by the member before
// a take or during it, and it's only a mirror, never recorded.
describe("the camera", () => {
  it("is asked for only when the member turns it on; the card offers Record without camera beside it", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const { cameraAsks } = devices();
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await settle();
    expect(cameraAsks()).toBe(0); // no question just for opening the page
    expect(text(page.container)).toContain(VOICE_ONLY_LINE);
    expect(document.querySelector("button")?.textContent).toBe("Turn on my camera"); // still first
    expect(button("Record without camera")).toBeTruthy();
    expect(queryButton("Start recording")).toBeNull();
    expect(cameraAsks()).toBe(0);
    vi.unstubAllGlobals();
  });

  it("hides Record without camera only while the browser asks about the camera", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    let allow: (stream: unknown) => void = () => {};
    devices(() => new Promise((resolve) => (allow = resolve)));
    const { Recorder } = await load();
    await render(<Recorder />);
    await settle();
    const wayRound = () => queryButton("Record without camera") !== null;
    expect(wayRound()).toBe(true); // before it's asked for
    await click(button("Turn on my camera"));
    expect(wayRound()).toBe(false); // while the browser asks: Chrome asks nothing else meanwhile
    await act(async () => allow(cameraStream()));
    expect(video()).not.toBeNull();
    expect(wayRound()).toBe(false); // on the stage, where Start recording is with the camera
    await click(button("Turn off my camera"));
    expect(wayRound()).toBe(true); // back in the card
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

  // The Diary's entries sit below the recorder: a stage that came up by itself would cover them on
  // every visit, with the camera's light on for someone who only came to listen.
  it("never comes on by itself, even where the browser would allow it without asking", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const camera = cameraStream();
    const { cameraAsks } = devices(async () => camera, "granted");
    const { Recorder } = await load();
    await render(diary(<Recorder />));
    await settle();
    expect(cameraAsks()).toBe(0);
    expect(video()).toBeNull();
    expect(document.documentElement.style.overflow).toBe(""); // the Diary scrolls
    expect(inert("entries")).toBe(false); // and its players are in reach
    expect(queryButton("Start recording")).toBeNull();
    await turnOnCamera(); // until the member turns it on
    expect(video()?.srcObject).toBe(camera);
    expect(button("Start recording")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("keeps the page under the stage out of reach while it's up, and gives it back after the take", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    devices();
    const { Recorder } = await load();
    await render(diary(<Recorder />));
    await turnOnCamera();
    // Tab and screen readers can't reach the players and links hidden under the stage.
    expect(inert("entries")).toBe(true);
    expect(inert("cover")).toBe(true);
    expect(inert("this-week")).toBe(false); // the stage's own section
    await record();
    expect(inert("entries")).toBe(true);
    await finish();
    expect(inert("entries")).toBe(false);
    expect(inert("cover")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("goes off with Turn off my camera before the take, back to the card, with the Diary in reach again", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const lens = fakeTrack();
    devices(async () => cameraStream(lens));
    const { Recorder } = await load();
    await render(diary(<Recorder />));
    await turnOnCamera();
    expect(queryButton("Not now")).toBeNull(); // the camera's own button does that now
    await click(button("Turn off my camera"));
    expect(video()).toBeNull();
    expect(lens.stop).toHaveBeenCalled();
    expect(document.documentElement.style.overflow).toBe("");
    expect(inert("entries")).toBe(false);
    expect(document.activeElement).toBe(button("Turn on my camera")); // to come back to it
    expect(queryButton("Start recording")).toBeNull(); // Start is the stage's, with the camera
    expect(queryButton("Not now")).toBeNull();
    expect(button("Record without camera")).toBeTruthy(); // or the take without it, in the card
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
    // What is recorded, under Start; Start alone in its row; the camera's button on the stage, which
    // the line describes before the take (nothing records yet).
    const voiceLine = () => [...(stage?.querySelectorAll("p") ?? [])].filter((p) => p.textContent === VOICE_ONLY_LINE);
    expect(voiceLine()).toHaveLength(1);
    expect(follows(button("Start recording"), voiceLine()[0])).toBe(true);
    expect(stage?.contains(button("Turn off my camera"))).toBe(true);
    expect(description(button("Turn off my camera"))).toEqual([VOICE_ONLY_LINE]);
    expect([...(button("Start recording").parentElement?.querySelectorAll("button") ?? [])]).toEqual([button("Start recording")]);
    expect(document.querySelector("[aria-live]")?.textContent).not.toContain(VOICE_ONLY_LINE);

    await record();
    expect(getUserMedia).toHaveBeenLastCalledWith(expect.objectContaining({ audio: expect.anything() }));
    expect(getUserMedia.mock.lastCall?.[0]).not.toHaveProperty("video");
    expect(FakeRecorder.last?.stream).toBe(microphone); // the camera never reaches the recorder
    expect(video()).toBe(mirror); // the same mirror, carried on into the recording
    expect(stage?.textContent).toContain("Recording your voice");
    expect(stage?.textContent).toContain(VOICE_ONLY_LINE);
    expect(voiceLine()).toHaveLength(1);
    expect(stage?.querySelector("h3 + p")?.textContent).not.toBe(VOICE_ONLY_LINE); // not taken for the status line
    expect(stage?.querySelector("h3")?.textContent).toBe(DEFAULT_OPENING_QUESTION);
    expect(stage?.contains(button("Finish"))).toBe(true);
    expect(follows(button("Finish"), voiceLine()[0])).toBe(true); // under Finish
    expect(stage?.contains(button("Turn off my camera"))).toBe(true);
    // While recording, no description: a screen reader reads one out as focus lands on the button.
    expect(description(button("Turn off my camera"))).toEqual([]);
    expect(document.querySelector("[aria-live]")?.textContent).not.toContain(VOICE_ONLY_LINE);

    await finish();
    expect(video()).toBeNull(); // gone at Finish
    expect(lens.stop).toHaveBeenCalled(); // and off, before the recorder's stop event comes
    expect(document.documentElement.style.overflow).toBe("");
    await act(async () => FakeRecorder.last?.onstop?.()); // nothing recorded here
    expect(button("Turn on my camera")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  // On a short phone the stage's panel (the question, Start or Finish, the voice-only line) doesn't
  // fit, and scrolls. The camera's button sits above it in the stage's top row, beside the pill and
  // the clock during the take, so it is always in view; the line stays in the panel, under the buttons.
  it("keeps its button in the stage's top row, out of the panel that scrolls, before and during the take", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    devices();
    const { Recorder } = await load();
    await render(diary(<Recorder />));
    await turnOnCamera();
    const stage = video()!.parentElement!;
    const line = () => [...stage.querySelectorAll("p")].find((p) => p.textContent === VOICE_ONLY_LINE)!;
    const panel = scroller(button("Start recording"));
    expect(panel).not.toBeNull(); // the panel scrolls on a short screen
    expect(stage.contains(button("Turn off my camera"))).toBe(true);
    expect(scroller(button("Turn off my camera"))).toBeNull(); // the button doesn't
    expect(follows(button("Turn off my camera"), panel!)).toBe(true); // above it
    expect(scroller(line())).toBe(panel); // the line in the panel, under Start
    expect(follows(button("Start recording"), line())).toBe(true);

    await record();
    const pill = [...stage.querySelectorAll("span")].find((span) => span.textContent === "Recording your voice")!;
    const row = pill.parentElement!;
    expect(row.contains(stage.querySelector('[role="timer"]'))).toBe(true);
    expect(row.contains(button("Turn off my camera"))).toBe(true); // beside the pill and the clock
    expect(row.contains(button("Finish"))).toBe(false);
    expect(scroller(row)).toBeNull();
    expect(scroller(button("Finish"))).not.toBeNull();
    expect(scroller(line())).toBe(scroller(button("Finish"))); // the line in the panel, under Finish
    expect(follows(button("Finish"), line())).toBe(true);
    expect(document.activeElement).toBe(button("Finish"));
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

  it("keeps the way on held in a new recorder while an earlier camera question is still open", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    let block: (error: unknown) => void = () => {};
    const { cameraAsks } = devices(() => new Promise((_, reject) => (block = reject)));
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await click(button("Turn on my camera"));
    await page.rerender(<></>); // left by a link; the browser's question stays open
    await page.rerender(<Recorder />);
    expect(button("Waiting for your camera…")).toBeTruthy();
    expect(text(page.container)).toContain("If your browser asks about the camera");
    await act(async () => block(new DOMException("blocked", "NotAllowedError"))); // answered Block
    await settle();
    expect(button("Turn on my camera")).toBeTruthy(); // to try again
    expect(cameraAsks()).toBe(1);
    expect(video()).toBeNull();
    vi.unstubAllGlobals();
  });

  // The member pressed Turn on my camera, and the note said to answer the browser to go on: once
  // they answer Allow, the camera comes on without a second press.
  it("comes on once the member's own question, left open by an earlier visit, is answered Allow", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    let allow: (stream: unknown) => void = () => {};
    let asks = 0;
    const { cameraAsks } = devices(() =>
      ++asks === 1 ? new Promise((resolve) => (allow = resolve)) : Promise.resolve(cameraStream()),
    );
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await click(button("Turn on my camera"));
    await page.rerender(<></>); // left by a link; the browser's question stays open
    await page.rerender(<Recorder />);
    await settle();
    await act(async () => allow(cameraStream())); // answered Allow
    await settle();
    expect(cameraAsks()).toBe(2); // the first recorder's camera was let go; this one's came on
    expect(video()).not.toBeNull();
    expect(document.activeElement).toBe(button("Start recording"));
    vi.unstubAllGlobals();
  });

  it("doesn't come on under a draft when an earlier visit's question is answered Allow", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    let allow: (stream: unknown) => void = () => {};
    const { cameraAsks } = devices(() => new Promise((resolve) => (allow = resolve)));
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await click(button("Turn on my camera"));
    await page.rerender(<></>); // left by a link; meanwhile a draft was saved
    await page.rerender(<Recorder heldOnly />); // the recorder under that draft
    await act(async () => allow(cameraStream()));
    await settle();
    expect(cameraAsks()).toBe(1);
    expect(video()).toBeNull();
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

  it("turns off when Sign out finishes the recording, before the recorder's stop event", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const lens = fakeTrack();
    devices(async () => cameraStream(lens));
    const { Recorder, finishRecording, currentSave } = await load();
    await render(<Recorder />);
    await turnOnCamera();
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
    const { getUserMedia, cameraAsks } = devices(async () => camera);
    getUserMedia.mockImplementation(async (constraints: MediaStreamConstraints) => {
      if (constraints.video) return camera;
      throw new DOMException("blocked", "NotAllowedError");
    });
    const { Recorder } = await load();
    await render(<Recorder />);
    await turnOnCamera();
    const mirror = video();
    await record();
    expect(video()).toBe(mirror);
    expect(lens.stop).not.toHaveBeenCalled();
    expect(mirror?.parentElement?.textContent).toContain("Microphone access is blocked");
    expect(cameraAsks()).toBe(1); // not a second camera over the first
    vi.unstubAllGlobals();
  });

  it("waits to be turned on again after a take with nothing in it, even where the browser allows it", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const { cameraAsks } = devices(undefined, "granted");
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await turnOnCamera();
    await record();
    await finish();
    await act(async () => FakeRecorder.last?.onstop?.()); // no chunks: nothing was recorded
    await settle();
    expect(text(page.container)).toContain("Nothing was recorded.");
    expect(cameraAsks()).toBe(1);
    expect(video()).toBeNull();
    expect(button("Turn on my camera")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("turns off at the ten-minute limit, with the take", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const lens = fakeTrack();
    devices(async () => cameraStream(lens));
    const { Recorder } = await load();
    const page = await render(<Recorder />);
    await turnOnCamera();
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

  // The member turns the camera off, or on again, while recording: only the camera changes. The
  // take is still the one recorder, on the microphone alone, and nothing new is said aloud.
  describe("turned off and on during the take", () => {
    const CAMERA_ASKING = "If your browser asks about the camera, answer it to go on.";
    const CAMERA_ASKING_DURING =
      "You're still recording. If your browser asks about the camera, answer it; on a computer, it's by the address bar.";
    const CAMERA_DIDNT_COME_ON = "Your camera didn't come on, so you're recording without it.";

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    // A camera that hands out a new stream, with a track of its own, each time it's asked for.
    function cameras() {
      const lenses: ReturnType<typeof fakeTrack>[] = [];
      const streams: MediaStream[] = [];
      const next = async () => {
        const lens = fakeTrack();
        lenses.push(lens);
        streams.push(cameraStream(lens));
        return streams.at(-1);
      };
      return { lenses, streams, next };
    }
    // The first request for the camera is allowed at once; later ones answer when the test says.
    function slowAfterFirst() {
      let answer: { allow: (stream: unknown) => void; block: (error: unknown) => void } | null = null;
      let asks = 0;
      const camera = () =>
        ++asks === 1
          ? Promise.resolve(cameraStream())
          : new Promise((allow, block) => {
              answer = { allow, block };
            });
      return {
        camera,
        allow: (stream: unknown) => act(async () => answer?.allow(stream)),
        block: (error: unknown) => act(async () => answer?.block(error)),
      };
    }
    // A take recording on the stage, in the Diary.
    async function takeOnStage(camera?: () => Promise<unknown>) {
      vi.stubGlobal("MediaRecorder", FakeRecorder);
      const found = devices(camera);
      const { Recorder, ...saves } = await load();
      const page = await render(diary(<Recorder />));
      await turnOnCamera();
      await record();
      expect(FakeRecorder.last?.state).toBe("recording");
      return { ...found, ...saves, page };
    }
    const audioAsks = (getUserMedia: ReturnType<typeof devices>["getUserMedia"]) =>
      getUserMedia.mock.calls.filter(([constraints]) => constraints.audio).length;
    const region = () => document.querySelector('[aria-live="polite"]')?.textContent ?? "";
    const paragraph = (words: string) => [...document.querySelectorAll("p")].find((p) => p.textContent === words);

    it("goes off mid-take into the card, stops the camera, and leaves the take as it was", async () => {
      const lens = cameras();
      const { microphone, page } = await takeOnStage(lens.next);
      const recorder = FakeRecorder.last;
      const question = page.container.querySelector("h3")?.textContent;
      const added = addedToLiveRegion();
      await click(button("Turn off my camera"));
      expect(lens.lenses[0].stop).toHaveBeenCalled(); // its light goes out
      expect(video()).toBeNull();
      expect(FakeRecorder.made).toBe(1);
      expect(FakeRecorder.last).toBe(recorder);
      expect(recorder?.state).toBe("recording");
      expect(recorder?.stream).toBe(microphone);
      expect(microphone.getTracks()[0].stop).not.toHaveBeenCalled();
      expect(page.container.querySelector("h3")?.textContent).toBe(question);
      expect(document.activeElement).toBe(button("Turn on my camera")); // not Finish
      expect(document.documentElement.style.overflow).toBe("");
      expect(inert("entries")).toBe(false);
      expect(inert("cover")).toBe(false);
      expect(text(page.container)).toContain("Recording your voice");
      expect(text(page.container)).toContain(VOICE_ONLY_LINE);
      expect(added).toEqual([]);
    });

    // Focus moves to the camera button's counterpart at each switch, and a screen reader reads a
    // focused control's description: the voice-only line (or any note) read out through the speakers
    // would reach the microphone, the take, the live transcript and the grade. So no description
    // while recording, either way round, waiting or refused.
    it("moves focus at each switch to a camera button with no description, so nothing more is read into the take", async () => {
      const slow = slowAfterFirst();
      await takeOnStage(slow.camera);
      const added = addedToLiveRegion();
      expect(description(button("Turn off my camera"))).toEqual([]);
      await click(button("Turn off my camera"));
      expect(document.activeElement).toBe(button("Turn on my camera"));
      expect(description(document.activeElement)).toEqual([]);
      await click(button("Turn on my camera"));
      expect(document.activeElement).toBe(button("Waiting for your camera…"));
      expect(description(document.activeElement)).toEqual([]);
      await slow.allow(cameraStream());
      await settle();
      expect(document.activeElement).toBe(button("Turn off my camera"));
      expect(description(document.activeElement)).toEqual([]);
      await click(button("Turn off my camera"));
      await click(button("Turn on my camera"));
      await slow.block(new DOMException("blocked", "NotAllowedError"));
      await settle();
      expect(text()).toContain(CAMERA_DIDNT_COME_ON);
      expect(document.activeElement).toBe(button("Turn on my camera"));
      expect(description(document.activeElement)).toEqual([]);
      expect(FakeRecorder.last?.state).toBe("recording");
      expect(added).toEqual([]);
    });

    it("comes on again mid-take, asked for on its own, and brings the stage back", async () => {
      const lens = cameras();
      const { getUserMedia, cameraAsks } = await takeOnStage(lens.next);
      const added = addedToLiveRegion();
      await click(button("Turn off my camera"));
      await click(button("Turn on my camera"));
      await settle();
      expect(cameraAsks()).toBe(2);
      const videoCalls = getUserMedia.mock.calls.filter(([constraints]) => constraints.video);
      expect(videoCalls.at(-1)?.[0]).toEqual({ video: expect.any(Object) }); // never with audio
      expect(video()?.srcObject).toBe(lens.streams[1]);
      expect(document.activeElement).toBe(button("Turn off my camera"));
      expect(inert("entries")).toBe(true);
      expect(document.documentElement.style.overflow).toBe("hidden");
      expect(FakeRecorder.made).toBe(1);
      expect(audioAsks(getUserMedia)).toBe(1);
      expect(added).toEqual([]);
    });

    // On a short phone the stage's panel scrolls. Focus goes to the camera button in the top row, which
    // doesn't scroll the panel, so the panel is brought to Finish (as focus brought it when the take
    // began there), without moving focus there.
    it("comes back on with the stage's panel at Finish, and focus on the camera button", async () => {
      const lens = cameras();
      await takeOnStage(lens.next);
      await click(button("Turn off my camera"));
      const scrolled = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
      try {
        await click(button("Turn on my camera"));
        await settle();
        expect(video()).not.toBeNull();
        expect(document.activeElement).toBe(button("Turn off my camera"));
        expect(scrolled.mock.contexts).toContain(button("Finish"));
        const call = scrolled.mock.calls[scrolled.mock.contexts.indexOf(button("Finish"))];
        expect(call[0]).toEqual({ block: "nearest" }); // only as far as it takes
        expect(scroller(button("Finish"))).not.toBeNull(); // in the panel that scrolls
      } finally {
        scrolled.mockRestore();
      }
    });

    it("keeps one take, audio only, across three times off and on, and saves it at Finish", async () => {
      const lens = cameras();
      await takeOnStage(lens.next);
      for (let i = 0; i < 3; i++) {
        await click(button("Turn off my camera"));
        await click(button("Turn on my camera"));
        await settle();
      }
      expect(lens.streams).toHaveLength(4);
      saving();
      fakes.prepareRecording.mockClear();
      await finish();
      await act(async () => {
        FakeRecorder.last?.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }) });
        FakeRecorder.last?.onstop?.();
      });
      for (let i = 0; i < 5; i++) await settle();
      expect(fakes.saveDraft).toHaveBeenCalledOnce();
      expect(fakes.prepareRecording.mock.lastCall?.[0]).toMatch(/^audio\//); // the take's type
      expect(FakeRecorder.made).toBe(1);
      for (const each of lens.lenses) expect(each.stop).toHaveBeenCalled();
      expect(text()).toContain("Saved.");
    });

    it("carries on recording in the card when it's refused mid-take, and says so quietly", async () => {
      const slow = slowAfterFirst();
      const { page } = await takeOnStage(slow.camera);
      const added = addedToLiveRegion();
      await click(button("Turn off my camera"));
      await click(button("Turn on my camera"));
      await slow.block(new DOMException("blocked", "NotAllowedError"));
      await settle();
      expect(button("Finish")).toBeTruthy();
      expect(FakeRecorder.last?.state).toBe("recording");
      expect(text(page.container)).toContain(CAMERA_DIDNT_COME_ON);
      const note = paragraph(CAMERA_DIDNT_COME_ON)!;
      expect(note.hasAttribute("role")).toBe(false);
      expect(note.closest("[aria-live]")).toBeNull();
      expect(region()).not.toContain(CAMERA_DIDNT_COME_ON);
      expect(document.querySelector('[role="alert"]')).toBeNull();
      expect(text()).not.toContain("Camera access is blocked"); // the reason waits until after the take
      expect(document.activeElement).toBe(button("Turn on my camera"));
      // Just under it, and not its description: a description that changes on the focused button is
      // read out too, into the take.
      expect(follows(button("Turn on my camera"), note)).toBe(true);
      expect(description(button("Turn on my camera"))).toEqual([]);
      expect(added).toEqual([]);
    });

    it("waits, still recording, while the browser asks mid-take, and comes on once allowed", async () => {
      const slow = slowAfterFirst();
      const { cameraAsks, page } = await takeOnStage(slow.camera);
      const added = addedToLiveRegion();
      await click(button("Turn off my camera"));
      const toggle = button("Turn on my camera");
      await click(toggle);
      const waiting = button("Waiting for your camera…");
      expect(waiting).toBe(toggle); // the same button, so focus stays on it
      expect(document.activeElement).toBe(waiting);
      expect(waiting.getAttribute("aria-disabled")).toBe("true");
      await click(waiting); // asks nothing new
      expect(cameraAsks()).toBe(2);
      expect(text(page.container)).toContain(CAMERA_ASKING_DURING);
      expect(region()).not.toContain(CAMERA_ASKING_DURING);
      expect(region()).not.toContain(CAMERA_ASKING);
      expect(paragraph(CAMERA_ASKING_DURING)?.hasAttribute("role")).toBe(false);
      expect(FakeRecorder.last?.state).toBe("recording");
      await slow.allow(cameraStream());
      await settle();
      expect(video()).not.toBeNull();
      expect(document.activeElement).toBe(button("Turn off my camera"));
      expect(FakeRecorder.made).toBe(1);
      expect(added).toEqual([]);
    });

    it("lets go of a camera allowed only after Finish, and leaves the card ready, not waiting", async () => {
      const slow = slowAfterFirst();
      await takeOnStage(slow.camera);
      await click(button("Turn off my camera"));
      await click(button("Turn on my camera")); // the browser asks
      await finish();
      await act(async () => FakeRecorder.last?.onstop?.()); // no chunks: nothing was recorded
      await settle();
      expect(text()).toContain("Nothing was recorded.");
      const lens2 = fakeTrack();
      await slow.allow(cameraStream(lens2));
      await settle();
      expect(lens2.stop).toHaveBeenCalled();
      expect(video()).toBeNull();
      expect(button("Turn on my camera").getAttribute("aria-disabled")).not.toBe("true");
      expect(button("Record without camera")).toBeTruthy();
      expect(region()).not.toContain(CAMERA_ASKING);
    });

    it("shows no camera alert for a refusal that comes only after Finish", async () => {
      const slow = slowAfterFirst();
      await takeOnStage(slow.camera);
      await click(button("Turn off my camera"));
      await click(button("Turn on my camera"));
      await finish();
      await act(async () => FakeRecorder.last?.onstop?.());
      await settle();
      await slow.block(new DOMException("blocked", "NotAllowedError"));
      await settle();
      const alerts = [...document.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent);
      expect(alerts).toEqual(["Nothing was recorded. Check your microphone, then try again."]);
      expect(text()).not.toContain("Camera access is blocked");
      expect(button("Turn on my camera").getAttribute("aria-disabled")).not.toBe("true");
      expect(region()).not.toContain(CAMERA_ASKING);
    });

    it("lets go of a camera allowed only after Sign out finished the take", async () => {
      const slow = slowAfterFirst();
      const { finishRecording } = await takeOnStage(slow.camera);
      await click(button("Turn off my camera"));
      await click(button("Turn on my camera"));
      await act(async () => finishRecording()); // what Sign out does first
      const lens2 = fakeTrack();
      await slow.allow(cameraStream(lens2));
      expect(lens2.stop).toHaveBeenCalled();
      expect(video()).toBeNull();
    });

    it("lets go of a camera allowed only after the member left the page mid-take", async () => {
      const slow = slowAfterFirst();
      const { page } = await takeOnStage(slow.camera);
      await click(button("Turn off my camera"));
      await click(button("Turn on my camera"));
      await page.rerender(<></>);
      const lens2 = fakeTrack();
      await slow.allow(cameraStream(lens2));
      expect(lens2.stop).toHaveBeenCalled();
      expect(video()).toBeNull();
    });

    it("has no camera button while the browser asks about the microphone, on the stage or in the card", async () => {
      vi.stubGlobal("MediaRecorder", FakeRecorder);
      let allowMic: (stream: unknown) => void = () => {};
      const { microphone, getUserMedia } = devices();
      getUserMedia.mockImplementation((constraints: MediaStreamConstraints) =>
        constraints.video ? Promise.resolve(cameraStream()) : new Promise((resolve) => (allowMic = resolve)),
      );
      const { Recorder } = await load();
      await render(<Recorder />);
      await turnOnCamera();
      await click(button("Start recording")); // the browser asks about the microphone
      expect(text()).toContain("Waiting for your microphone…");
      expect(video()).not.toBeNull();
      expect(queryButton(/my camera/)).toBeNull(); // on the stage
      await act(async () => allowMic(microphone));
      await settle();
      expect(button("Turn off my camera")).toBeTruthy();
      await finish();
      await act(async () => FakeRecorder.last?.onstop?.()); // nothing recorded: ready again
      await settle();
      await click(button("Record without camera"));
      expect(text()).toContain("Waiting for your microphone…");
      expect(queryButton(/my camera/)).toBeNull(); // in the card
      await act(async () => allowMic(microphone));
      await settle();
      expect(button("Turn on my camera")).toBeTruthy();
    });

    it("turns off and on again from the keyboard without ending the take", async () => {
      const lens = cameras();
      await takeOnStage(lens.next);
      fakes.saveDraft.mockClear();
      button("Turn off my camera").focus();
      await click(document.activeElement!); // Enter on the focused button
      expect(document.activeElement).toBe(button("Turn on my camera"));
      await click(document.activeElement!); // and again
      await settle();
      expect(video()?.srcObject).toBe(lens.streams[1]);
      expect(document.activeElement).toBe(button("Turn off my camera"));
      expect(FakeRecorder.last?.state).toBe("recording");
      expect(fakes.saveDraft).not.toHaveBeenCalled();
      expect(text()).not.toContain("Saving your recording");
    });

    it("doesn't carry a mid-take failure over into the next take", async () => {
      let asks = 0;
      await takeOnStage(async () => {
        if (++asks === 1) return cameraStream();
        throw new DOMException("blocked", "NotAllowedError");
      });
      await click(button("Turn off my camera"));
      await click(button("Turn on my camera"));
      await settle();
      expect(text()).toContain(CAMERA_DIDNT_COME_ON);
      await finish();
      await act(async () => FakeRecorder.last?.onstop?.()); // nothing recorded: back to the start
      await settle();
      expect(text()).toContain("Camera access is blocked."); // the reason, now the take is over
      expect(text()).not.toContain(CAMERA_DIDNT_COME_ON);
      await click(button("Record without camera"));
      await settle();
      expect(FakeRecorder.made).toBe(2);
      expect(FakeRecorder.last?.state).toBe("recording");
      expect(text()).not.toContain(CAMERA_DIDNT_COME_ON);
      await click(button("Turn on my camera"));
      await settle();
      expect(text()).toContain(CAMERA_DIDNT_COME_ON); // until it fails again
      expect(FakeRecorder.last?.state).toBe("recording");
    });
  });
});

// Every check-in asks one open question (page.tsx); without live check-ins, nothing follows it up.
describe("the one question", () => {
  const QUESTION = "How did your week go, and how's the team?";

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is the only question, before and during the take, with Finish (and the camera button) to press", async () => {
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
    expect(stage?.textContent).toContain(VOICE_ONLY_LINE);
    expect(document.activeElement).toBe(button("Finish"));
    expect(queryButton("Next question")).toBeNull();
    expect(queryButton("Different question")).toBeNull();
    expect(stage?.querySelector("ul")).toBeNull(); // no areas to tick off: nothing follows it up
    for (const line of FOLLOW_UP_LINES) expect(text()).not.toContain(line); // nothing to say is coming
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
    devices();
    const { Recorder } = await load();
    await render(<Recorder opening={QUESTION} />);
    await turnOnCamera();
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
const OPENING =
  "Talk me through your week, Monday to Saturday: what you worked on and what came of it, a moment you or your team were at your best, and how you're feeling about the team.";
const READY: LiveReady = {
  status: "ready",
  sessionId: SESSION,
  sttModel: "gpt-live-transcribe",
  opening: OPENING,
  pacing: { showAfterSilenceMs: 1500, stoppedSilenceMs: 3000, minQuestionMs: 8000, minWordsPerQuestion: 15, firstFollowUpAfterMs: 20_000 },
};

// With live check-ins on, the member can still record looking at themselves: the coach's question is
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

  const stage = () => video()?.parentElement ?? null;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts with the one open question, not the three fixed ones, and the camera first", async () => {
    liveDevices();
    const { Recorder } = await load();
    await render(<Recorder opening={OPENING} live />);
    expect(text()).toContain("We'll start with one question.");
    expect(text()).toContain(VOICE_ONLY_LINE);
    expect(text()).toContain(OPENING);
    expect(text()).not.toContain("What have you done this week?");
    expect(button("Turn on my camera")).toBeTruthy();
    expect(queryButton("Start recording")).toBeNull();
  });

  it("shows the open question on the stage before the take, and asks for no live session yet", async () => {
    liveDevices();
    const { Recorder } = await load();
    await render(<Recorder opening={OPENING} live />);
    await turnOnCamera();
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

  it("keeps the question on the stage, and says there are no follow-ups this time, when live questions aren't available", async () => {
    await startRecording({ status: "off" });
    expect(stage()?.querySelector("h3")?.textContent).toBe(OPENING);
    expect(stage()?.textContent).toContain("No follow-up questions this time. Answer out loud, then press Finish.");
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain("No follow-up questions this time.");
    // They never started, so they haven't stopped, and there's nothing to keep going with.
    expect(text()).not.toContain("Follow-up questions have stopped.");
    expect(stage()?.textContent).not.toContain("Not yet: What you did"); // no chips once nothing is following up
    for (const line of FOLLOW_UP_LINES) expect(stage()?.textContent).not.toContain(line);
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
    // What is coming carries over to the card, under the question.
    expect(page.container.querySelector("h3 + p")?.textContent).toMatch(/^(Starting follow-ups…|Listening…)$/);
    expect(document.activeElement).toBe(button("Finish"));
    expect(button("Finish").className).not.toContain("bg-white"); // the card's own button now
    expect(fakes.endLive).not.toHaveBeenCalled();
    expect(connection.close).not.toHaveBeenCalled();
    saving();
    await click(button("Finish"));
    expect(fakes.endLive).toHaveBeenCalledOnce();
    expect(text(page.container)).toContain("Saving your recording");
  });

  it("carries the question, its line and the live session across the camera going off and on", async () => {
    const { microphone } = await startRecording();
    const shown = () => [document.querySelector("h3")?.textContent, document.querySelector("h3 + p")?.textContent];
    // Connected, and listening (the line changes on the coach's next tick).
    for (let i = 0; i < 40 && shown()[1] !== "Listening…"; i++) await act(() => new Promise((resolve) => setTimeout(resolve, 25)));
    const added = addedToLiveRegion();
    const before = shown();
    expect(before).toEqual([OPENING, "Listening…"]);
    await click(button("Turn off my camera"));
    expect(video()).toBeNull();
    expect(shown()).toEqual(before);
    await click(button("Turn on my camera"));
    await settle();
    expect(video()).not.toBeNull();
    expect(shown()).toEqual(before);
    // One connection, one session and one level meter, on the microphone, for the whole take.
    expect(fakes.connectLiveTranscription).toHaveBeenCalledOnce();
    expect(fakes.startLive).toHaveBeenCalledOnce();
    expect(fakes.startLevelMeter).toHaveBeenCalledOnce();
    expect(fakes.startLevelMeter).toHaveBeenCalledWith(microphone, expect.any(Function));
    expect(fakes.endLive).not.toHaveBeenCalled();
    expect(connection.close).not.toHaveBeenCalled();
    expect(added).toEqual([]);
    saving();
    await click(button("Finish"));
    expect(fakes.endLive).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: SESSION }));
  });

  // Without a camera, the note under the question is in the card (the stage's has its own test).
  describe("in the card, once follow-ups have stopped", () => {
    async function recordInCard(start: unknown = READY) {
      let onFailure: (() => void) | null = null;
      liveDevices(async () => {
        throw new DOMException("none", "NotFoundError");
      });
      fakes.startLive.mockResolvedValue(start);
      fakes.connectLiveTranscription.mockImplementation(async (options: { onFailure: () => void }) => {
        onFailure = options.onFailure;
        return connection;
      });
      const { Recorder } = await load();
      const page = await render(<Recorder opening={OPENING} live />);
      await turnOnCamera();
      await click(button("Record without camera"));
      await settle();
      expect(video()).toBeNull();
      // The card's own words under the question, not the live region's.
      const note = () => page.container.querySelector("h3 + p")?.textContent;
      return { note, lose: () => act(() => onFailure?.()) };
    }

    it("says there are none this time when live questions aren't available", async () => {
      const card = await recordInCard({ status: "off" });
      expect(card.note()).toBe(NO_FOLLOW_UPS);
      expect(text()).not.toContain("Follow-up questions have stopped.");
    });

    it("says they have stopped when live transcription drops after it connected", async () => {
      const card = await recordInCard();
      expect(card.note()).toMatch(/^(Starting follow-ups…|Listening…)$/);
      await card.lose();
      expect(card.note()).toBe(FELL_BACK);
      expect(text()).not.toContain("No follow-up questions this time.");
    });
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
    liveDevices(async () => cameraStream(lens));
    const { Recorder, finishRecording, currentSave } = await load();
    await render(<Recorder opening={OPENING} live />);
    await turnOnCamera();
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
  // transcribed answer, a pause, and the coach's answer. Then they can say more (turn), and live
  // coaching can be made to stop. said: everything the live region has held.
  async function coachedTake(offer: ShownOffer) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
    liveDevices();
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
    const said = liveRegionLog();
    const added = addedToLiveRegion();
    await click(button("Turn on my camera"));
    await advance(0);
    await click(button("Start recording"));
    await advance(500); // quiet: the meter learns the room
    let item = 0;
    // They talk, it comes back as text, and they pause long enough for the coach to be asked.
    async function turn(transcript: string, pauseMs: number) {
      level = 0.2;
      await advance(3000);
      const itemId = `item_${++item}`;
      act(() => {
        onEvent?.({ type: "committed", itemId, previousItemId: item > 1 ? `item_${item - 1}` : null });
        onEvent?.({ type: "completed", itemId, transcript });
      });
      level = 0.002;
      await advance(pauseMs);
    }
    // A pause: the coach is asked, and its answer shown.
    await turn("This week I mostly worked on the vendor onboarding for the Jurong site and we got the first three suppliers through the checks.", 3000);
    return { said, added, turn, stop: () => act(() => onFailure?.()) };
  }

  // Nothing the line under the question says is ever announced: a screen reader's voice could reach
  // the microphone, and "Listening…" again and again would be noise.
  const neverAnnounced = (said: string[]) => {
    for (const words of ["Starting follow-ups", "Listening", "Checking for a follow-up", "will show when you pause"]) {
      expect(said.join("\n")).not.toContain(words);
    }
  };

  it("keeps a follow-up on screen, without Different question or the areas, when live coaching stops after it", async () => {
    try {
      const take = await coachedTake({ id: 2, kind: "question", text: "What came of the vendor onboarding?" });
      expect(stage()?.querySelector("h3")?.textContent).toBe("What came of the vendor onboarding?");
      expect(stage()?.querySelector("h3 + p")?.textContent).toBe("Listening…");
      expect(button("Different question")).toBeTruthy();
      take.stop();
      expect(stage()?.querySelector("h3")?.textContent).toBe("What came of the vendor onboarding?"); // not back to the opening
      expect(queryButton("Different question")).toBeNull();
      expect(stage()?.querySelector("ul")).toBeNull();
      expect(stage()?.textContent).toContain("Follow-up questions have stopped.");
      expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain("Follow-up questions have stopped.");
      for (const line of FOLLOW_UP_LINES) expect(stage()?.textContent).not.toContain(line);
      expect(document.activeElement).toBe(button("Finish"));
      neverAnnounced(take.said);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a follow-up, Different question and the areas, unannounced again, across the camera going off and on", async () => {
    try {
      const take = await coachedTake({ id: 2, kind: "question", text: "What came of the vendor onboarding?" });
      const chips = () => [...document.querySelectorAll("li")].map((li) => text(li));
      expect(document.querySelector("h3")?.textContent).toBe("What came of the vendor onboarding?");
      expect(button("Different question")).toBeTruthy();
      const areas = chips();
      expect(areas).toContain("Touched on: What you did");
      const said = take.said.length;
      const added = take.added.length;
      await click(button("Turn off my camera"));
      expect(video()).toBeNull();
      expect(document.querySelector("h3")?.textContent).toBe("What came of the vendor onboarding?");
      expect(button("Different question")).toBeTruthy();
      expect(chips()).toEqual(areas);
      await click(button("Turn on my camera"));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(video()).not.toBeNull();
      expect(stage()?.querySelector("h3")?.textContent).toBe("What came of the vendor onboarding?");
      expect(button("Different question")).toBeTruthy();
      expect(chips()).toEqual(areas);
      expect(take.said).toHaveLength(said); // nothing said again
      expect(take.added).toHaveLength(added); // nor put in the live region again
      neverAnnounced(take.said);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds no note to keep going under a closing line when live coaching stops after it", async () => {
    try {
      const closing = "Thank you for sharing that. Say as much or as little as you like, and press Finish whenever you're ready.";
      const take = await coachedTake({ id: 2, kind: "closing", text: closing }); // the line after a hard moment
      expect(stage()?.querySelector("h3")?.textContent).toBe(closing);
      // Nothing more is coming, said under it; the closing line is announced itself, and that is enough.
      expect(stage()?.querySelector("h3 + p")?.textContent).toBe("No more follow-ups.");
      const region = document.querySelector('[aria-live="polite"]')?.textContent;
      expect(region).toContain(closing);
      expect(region).not.toContain("No more follow-ups.");
      take.stop();
      expect(stage()?.querySelector("h3")?.textContent).toBe(closing);
      expect(text()).not.toContain("Follow-up questions have stopped.");
      expect(text()).not.toContain("No follow-up questions this time.");
      neverAnnounced(take.said);
      expect(take.said.join("\n")).not.toContain("No more follow-ups.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says, once, that no more follow-ups are coming once every read is used, even as Different question swaps one", async () => {
    const LAST = "No more follow-ups after this one.";
    const announced = (said: string[]) => said.filter((words, i) => words.includes(LAST) && !said[i - 1]?.includes(LAST));
    try {
      const take = await coachedTake({ id: 2, kind: "question", text: "What came of the vendor onboarding?" });
      // 16 words a turn: enough for a read at every pause.
      const more = "Then on Thursday the ops team switched off the old server and nobody noticed a thing.";
      for (let reads = 1; reads < MAX_READS; reads++) await take.turn(more, 2500);
      expect(fakes.askCoach).toHaveBeenCalledTimes(MAX_READS);
      expect(stage()?.querySelector("h3")?.textContent).toBe("What came of the vendor onboarding?");
      expect(stage()?.querySelector("h3 + p")?.textContent).toBe(LAST);
      expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain(LAST);
      // Announced as it first appears.
      expect(announced(take.said)).toHaveLength(1);

      // Different question still swaps it; a slow swap leaves the line, and the announcement, be.
      const swapped = { id: 3, kind: "question", text: "How is the team finding it?" };
      fakes.askCoach.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve({ status: "ok", degraded: false, offer: swapped, touched: { activity: true, excellence: false, morale: false } }), 2500)),
      );
      await click(button("Different question"));
      await act(() => vi.advanceTimersByTimeAsync(1500));
      expect(stage()?.querySelector("h3")?.textContent).toBe("What came of the vendor onboarding?");
      expect(stage()?.querySelector("h3 + p")?.textContent).toBe(LAST);
      await act(() => vi.advanceTimersByTimeAsync(1500));
      expect(stage()?.querySelector("h3")?.textContent).toBe(swapped.text);
      expect(stage()?.querySelector("h3 + p")?.textContent).toBe(LAST);
      expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(`Follow-up question: ${swapped.text} ${LAST}`);
      // Still said only the once: its node was put in the once, and stayed.
      expect(announced(take.said)).toHaveLength(1);
      expect(take.added.filter((words) => words.includes(LAST))).toHaveLength(1);
      neverAnnounced(take.said);

      // It goes with the recording: never beside "Saving your recording…", "Saved." or the next take's controls.
      saving();
      await click(button("Finish"));
      const region = () => document.querySelector('[aria-live="polite"]')?.textContent ?? "";
      expect(region()).toContain("Saving your recording…");
      expect(region()).not.toContain("No more follow-ups");
      await act(async () => {
        FakeRecorder.last?.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }) });
        FakeRecorder.last?.onstop?.();
      });
      for (let i = 0; i < 5; i++) await act(() => vi.advanceTimersByTimeAsync(0));
      expect(region()).toContain("Saved.");
      expect(region()).not.toContain("No more follow-ups");
    } finally {
      vi.useRealTimers();
    }
  });
});
