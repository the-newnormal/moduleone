// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pacing } from "@/lib/coach/types";
import { render, text } from "@/test/dom";
import type { LiveReady } from "./api";
import type { CoachResponse, ShownOffer } from "./contract";
import { CONNECT_TIMEOUT_MS, MAX_READS, NO_TEXT_WHILE_SPEAKING_MS, TEXT_WAIT_MS } from "./pacing";
import type { TranscriptEvent } from "./transcript";
import type { LiveConnection } from "./transport";
import {
  COACH_TIMEOUT_MS,
  createLiveCoach,
  METER_WAIT_MS,
  useLiveCoach,
  type LiveCoachController,
  type LiveCoachDeps,
  type LiveView,
} from "./use-live-coach";

// The live coach with every browser part faked: the routes, the transcription connection, the level
// meter (driven by how loud the test says the room is) and the clock (Date, under fake timers).

const SESSION = "5e550000-0000-4000-8000-000000000001";
const OPENING =
  "Talk me through your week: what you worked on and what came of it, a moment you or your team were at your best, and how you're feeling about the team.";
const PACING: Pacing = {
  showAfterSilenceMs: 1500,
  stoppedSilenceMs: 3000,
  minQuestionMs: 8000,
  minWordsPerQuestion: 15,
  firstFollowUpAfterMs: 20_000,
};
const READY: LiveReady = {
  status: "ready",
  sessionId: SESSION,
  sttModel: "gpt-live-transcribe",
  opening: OPENING,
  pacing: PACING,
};
const STREAM = {} as MediaStream;
const QUIET = 0.002;
const LOUD = 0.2;

// 26 words, enough for a first read.
const FIRST_ANSWER =
  "This week I settled the vendor onboarding for the Jurong site lah, then helped Wei Ling's team close three audit findings before Friday's review.";
const MORE =
  "The migration also went through on Wednesday night, no downtime, and the ops team could finally switch off the old server.";

const QUESTION_1: ShownOffer = { id: 1, kind: "question", text: "What came of the vendor onboarding?" };
const QUESTION_2: ShownOffer = { id: 2, kind: "question", text: "How is the team finding the new review process?" };
const COVERED: ShownOffer = { id: 3, kind: "covered", text: "That covers it, thank you. Add anything else you'd like, then press Finish." };
const TEAM_QUESTION: ShownOffer = { id: 4, kind: "question", text: "How's the team been for you this week?" };
// What they say after the read that offered TEAM_QUESTION was asked for, which answers it.
const TEAM_OK = "Team ok lah, quite happy.";
// 17 words.
const TEAM_STRETCHED = "Actually the team has been quite stretched lah, two people out sick and everyone covering for them.";

function ok(offer: ShownOffer | null, degraded = false): CoachResponse {
  return { status: "ok", offer, touched: { activity: true, excellence: false, morale: false }, degraded };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Moves the fake clock on, running timers and settling promises on the way.
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

// Each fake can be given another implementation; the end call and the clock are always these.
function setup(overrides: Partial<Pick<LiveCoachDeps, "start" | "connect" | "exchange" | "ask" | "meter">> = {}) {
  const views: LiveView[] = [];
  let level = QUIET;
  let item = 0;
  let onEvent: ((event: TranscriptEvent) => void) | null = null;
  let onFailure: (() => void) | null = null;
  let signal: AbortSignal | undefined;
  const meterStopped = vi.fn();
  const connection = { commit: vi.fn(), close: vi.fn() } satisfies LiveConnection;
  const deps = {
    start: vi.fn<LiveCoachDeps["start"]>(overrides.start ?? (async () => READY)),
    connect: vi.fn<LiveCoachDeps["connect"]>(
      overrides.connect ??
        (async (options) => {
          onEvent = options.onEvent;
          onFailure = options.onFailure;
          signal = options.signal;
          return connection;
        }),
    ),
    exchange: vi.fn<LiveCoachDeps["exchange"]>(overrides.exchange ?? (async () => ({ status: "connected", answer: "v=0 answer" }))),
    ask: vi.fn<LiveCoachDeps["ask"]>(overrides.ask ?? (async () => ok(null))),
    end: vi.fn<LiveCoachDeps["end"]>(),
    meter: vi.fn<LiveCoachDeps["meter"]>(
      overrides.meter ??
        ((_stream, onLevel) => {
          const timer = setInterval(() => onLevel(level, Date.now()), 50);
          return () => {
            clearInterval(timer);
            meterStopped();
          };
        }),
    ),
    now: () => Date.now(),
  };
  const coach = createLiveCoach({ opening: OPENING, deps, onView: (view) => views.push(view) });

  return {
    coach,
    deps,
    connection,
    meterStopped,
    view: () => views.at(-1),
    // Every offer that has been on screen, in order.
    offersShown: () => views.map((v) => v.offer.id),
    signal: () => signal,
    // Start pressed, the microphone granted, the recording under way.
    async record() {
      coach.begin();
      coach.attach(STREAM);
      await advance(0);
    },
    async speak(ms: number) {
      level = LOUD;
      await advance(ms);
    },
    async pause(ms: number) {
      level = QUIET;
      await advance(ms);
    },
    // A turn transcribed, as transport.ts hands it over.
    say(words: string) {
      const itemId = `item_${++item}`;
      act(() => {
        onEvent?.({ type: "committed", itemId, previousItemId: item > 1 ? `item_${item - 1}` : null });
        onEvent?.({ type: "completed", itemId, transcript: words });
      });
    },
    // A turn whose transcription failed.
    fail() {
      const itemId = `item_${++item}`;
      act(() => {
        onEvent?.({ type: "committed", itemId, previousItemId: item > 1 ? `item_${item - 1}` : null });
        onEvent?.({ type: "failed", itemId });
      });
    },
    lose: () => act(() => onFailure?.()),
  };
}

// They answer the opening question, pause, and the coach is asked.
async function firstRead(live: ReturnType<typeof setup>) {
  await live.record();
  await live.pause(500);
  await live.speak(3000);
  live.say(FIRST_ANSWER);
  await live.pause(1600);
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-08T02:00:00Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("starting", () => {
  it("shows the opening question with nothing touched yet", async () => {
    const live = setup();
    await live.record();
    expect(live.view()).toEqual({
      mode: "live",
      offer: { id: 0, kind: "question", text: OPENING },
      touched: { activity: false, excellence: false, morale: false },
    });
    expect(live.deps.connect).toHaveBeenCalledOnce();
    expect(live.deps.connect.mock.calls[0][0]).toMatchObject({ stream: STREAM });
  });

  it("sends the transcription's offer to the server for this session, and passes its answer back", async () => {
    const live = setup();
    await live.record();
    const { exchange } = live.deps.connect.mock.calls[0][0];
    const signal = new AbortController().signal;
    expect(await exchange("v=0 offer", signal)).toBe("v=0 answer");
    expect(live.deps.exchange).toHaveBeenCalledExactlyOnceWith({ sessionId: SESSION, offer: "v=0 offer" }, signal);
  });

  it.each([
    ["refuses it", { status: "error", code: "no_session" } as const],
    ["can't be reached", null],
  ])("fails the connection when the server %s", async (_label, reply) => {
    const live = setup({ exchange: vi.fn(async () => reply) });
    await live.record();
    const { exchange } = live.deps.connect.mock.calls[0][0];
    await expect(exchange("v=0 offer", new AbortController().signal)).rejects.toThrow("didn't connect");
  });

  it.each([
    ["live check-ins are off", { status: "off" } as const],
    ["the route can't be reached", null],
    ["the member has no live session left today", { status: "error", code: "too_many_sessions" } as const],
  ])("carries on without follow-ups when %s", async (_label, response) => {
    const live = setup({ start: vi.fn(async () => response) });
    await live.record();
    expect(live.view()).toMatchObject({ mode: "fallback", offer: { id: 0 } });
    expect(live.deps.connect).not.toHaveBeenCalled();
    expect(live.coach.stop()).toBeNull();
    // No session started, so there is none to end, and nowhere to send its reason (start_not_ready).
    expect(live.deps.end).not.toHaveBeenCalled();
  });

  it("waits for the microphone before connecting, even when the key comes first", async () => {
    const live = setup();
    live.coach.begin();
    await advance(5000); // the browser still asking for the microphone
    expect(live.deps.connect).not.toHaveBeenCalled();
    live.coach.attach(STREAM);
    await advance(0);
    expect(live.deps.connect).toHaveBeenCalledOnce();
    expect(live.view()?.mode).toBe("live");
  });

  it("falls back when live transcription doesn't connect in time, and ends the session", async () => {
    const live = setup({ connect: vi.fn(() => new Promise<never>(() => {})) });
    await live.record();
    await advance(CONNECT_TIMEOUT_MS - 250);
    expect(live.view()?.mode).toBe("live");
    await advance(250);
    expect(live.view()).toMatchObject({ mode: "fallback", offer: { id: 0 } });
    expect(live.deps.end).toHaveBeenCalledExactlyOnceWith({ sessionId: SESSION, recordedMs: 0, shown: 0, fallback: "connect_timeout" });
    expect(live.meterStopped).toHaveBeenCalled();
  });

  it("falls back when live transcription fails to connect, and says so as it ends the session", async () => {
    const live = setup({
      connect: vi.fn(async () => {
        throw new Error("live transcription: the server didn't connect it");
      }),
    });
    await live.record();
    expect(live.view()).toMatchObject({ mode: "fallback", offer: { id: 0 } });
    expect(live.deps.end).toHaveBeenCalledExactlyOnceWith({ sessionId: SESSION, recordedMs: 0, shown: 0, fallback: "connect_failed" });
  });

  it("falls back when the browser can't measure the microphone's level", async () => {
    const live = setup({ meter: vi.fn(() => () => {}) });
    await live.record();
    await advance(METER_WAIT_MS);
    expect(live.view()).toMatchObject({ mode: "fallback", offer: { id: 0 } });
    expect(live.deps.end).toHaveBeenCalledExactlyOnceWith({
      sessionId: SESSION,
      recordedMs: METER_WAIT_MS,
      shown: 0,
      fallback: "meter",
    });
  });

  it("says why when a session that starts after live coaching was given up is ended", async () => {
    const start = deferred<LiveReady>();
    const live = setup({ start: vi.fn(() => start.promise), meter: vi.fn(() => () => {}) });
    await live.record();
    await advance(METER_WAIT_MS);
    expect(live.view()).toMatchObject({ mode: "fallback", offer: { id: 0 } });
    expect(live.deps.end).not.toHaveBeenCalled();
    start.resolve(READY);
    await advance(0);
    expect(live.deps.end).toHaveBeenCalledExactlyOnceWith({ sessionId: SESSION, recordedMs: 0, shown: null, fallback: "meter" });
    expect(live.deps.connect).not.toHaveBeenCalled();
  });

  it("ends a session that starts only after the take has ended", async () => {
    const start = deferred<LiveReady>();
    const live = setup({ start: vi.fn(() => start.promise) });
    live.coach.begin();
    expect(live.coach.stop()).toBeNull();
    start.resolve(READY);
    await advance(0);
    // Nothing of this session's was ever on screen.
    expect(live.deps.end).toHaveBeenCalledExactlyOnceWith({ sessionId: SESSION, recordedMs: 0, shown: null });
    expect(live.deps.connect).not.toHaveBeenCalled();
  });
});

describe("while they talk", () => {
  it("ends a turn when they pause after saying something", async () => {
    const live = setup();
    await live.record();
    await live.pause(500);
    await live.speak(2000);
    expect(live.connection.commit).not.toHaveBeenCalled();
    await live.pause(1000);
    expect(live.connection.commit).toHaveBeenCalledOnce();
  });

  it("asks the coach once they pause after enough words, never while they speak", async () => {
    const live = setup();
    await live.record();
    await live.pause(500);
    await live.speak(3000);
    live.say(FIRST_ANSWER);
    await live.speak(2000);
    expect(live.deps.ask).not.toHaveBeenCalled();
    await live.pause(1600);
    expect(live.deps.ask).toHaveBeenCalledOnce();
    const [request] = live.deps.ask.mock.calls[0];
    expect(request).toMatchObject({ sessionId: SESSION, transcript: FIRST_ANSWER, shown: 0, skip: null });
    expect(request.elapsedMs).toBeGreaterThan(6000);
  });

  it("doesn't ask with only a few words until they have stopped for a while", async () => {
    const live = setup();
    await live.record();
    await live.pause(500);
    await live.speak(1500);
    live.say("Busy week lah.");
    await live.pause(2000);
    expect(live.deps.ask).not.toHaveBeenCalled();
    await live.pause(2500);
    expect(live.deps.ask).toHaveBeenCalledOnce();
  });

  it("asks one at a time", async () => {
    const answer = deferred<CoachResponse>();
    const live = setup({ ask: vi.fn(() => answer.promise) });
    await firstRead(live);
    await live.speak(3000);
    live.say(MORE);
    await live.pause(6000);
    expect(live.deps.ask).toHaveBeenCalledOnce();
    answer.resolve(ok(null));
    await advance(1000);
    expect(live.deps.ask).toHaveBeenCalledTimes(2);
  });

  it("ignores an answer that comes back after a newer request", async () => {
    const late = deferred<CoachResponse>();
    const live = setup();
    live.deps.ask.mockReturnValueOnce(late.promise).mockResolvedValueOnce(ok(QUESTION_2));
    await firstRead(live);
    await advance(COACH_TIMEOUT_MS); // the first call never answers in time
    await live.speak(3000);
    live.say(MORE);
    await live.pause(1600);
    expect(live.deps.ask).toHaveBeenCalledTimes(2);
    late.resolve(ok(QUESTION_1));
    await live.pause(4000);
    expect(live.view()).toMatchObject({ mode: "live", offer: QUESTION_2 });
  });

  it("shows the coach's question only once they have stopped talking", async () => {
    const answer = deferred<CoachResponse>();
    const live = setup();
    live.deps.ask.mockReturnValueOnce(answer.promise).mockResolvedValueOnce(ok(QUESTION_2));
    await firstRead(live);
    await live.speak(500);
    answer.resolve(ok(QUESTION_1));
    await live.speak(10_000);
    live.say(MORE);
    expect(live.view()).toMatchObject({ offer: { id: 0 } });
    expect(live.view()).toMatchObject({ touched: { activity: true } });
    await live.pause(1600); // a short pause isn't enough this early in the recording
    expect(live.view()).toMatchObject({ offer: { id: 0 } });
    await live.pause(1600);
    // QUESTION_1's read never heard what they went on to say; the read that did decided.
    expect(live.view()).toMatchObject({ mode: "live", offer: QUESTION_2 });
    expect(live.offersShown()).not.toContain(QUESTION_1.id);
  });

  it.each([
    ["shows its question instead", QUESTION_2, QUESTION_2],
    ["shows nothing new when it finds nothing worth asking", null, { id: 0 }],
  ] as const)("holds an offer back while a newer read, which has heard more, is out, then %s", async (_label, newerOffer, shown) => {
    const newer = deferred<CoachResponse>();
    const ask = vi.fn<LiveCoachDeps["ask"]>().mockResolvedValueOnce(ok(QUESTION_1)).mockImplementationOnce(() => newer.promise);
    const live = setup({ ask });
    await firstRead(live); // QUESTION_1 waits: too early for a follow-up
    expect(live.view()).toMatchObject({ offer: { id: 0 } });
    await live.speak(16_000);
    live.say(MORE);
    await live.pause(5000); // the second read is asked for and doesn't answer yet
    expect(ask).toHaveBeenCalledTimes(2);
    expect(live.view()).toMatchObject({ offer: { id: 0 } }); // not QUESTION_1, though its time has come
    newer.resolve(ok(newerOffer));
    await live.pause(500);
    expect(live.view()).toMatchObject({ mode: "live", offer: shown });
  });

  it.each([
    ["fails", async (_live: ReturnType<typeof setup>, newer: ReturnType<typeof deferred<CoachResponse>>) => newer.resolve({ status: "error", code: "unavailable" })],
    ["never answers", async (live: ReturnType<typeof setup>) => live.pause(15_000)],
    // Claude couldn't read the newest speech: its question comes from what was known before.
    ["is degraded", async (_live: ReturnType<typeof setup>, newer: ReturnType<typeof deferred<CoachResponse>>) => newer.resolve(ok(QUESTION_2, true))],
  ] as const)("drops an offer held back for a newer read that %s, rather than show it late", async (_label, end) => {
    const newer = deferred<CoachResponse>();
    const ask = vi.fn<LiveCoachDeps["ask"]>().mockResolvedValueOnce(ok(QUESTION_1)).mockImplementationOnce(() => newer.promise);
    const live = setup({ ask });
    await firstRead(live);
    await live.speak(16_000);
    live.say(MORE);
    await live.pause(5000); // the second read is out
    expect(ask).toHaveBeenCalledTimes(2);
    await end(live, newer);
    await live.pause(5000);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 } }); // QUESTION_1 never shown
  });

  it("keeps the follow-up on screen when live coaching stops", async () => {
    const live = setup();
    live.deps.ask.mockResolvedValueOnce(ok(QUESTION_1));
    await firstRead(live);
    await live.pause(2000);
    expect(live.view()).toMatchObject({ mode: "live", offer: QUESTION_1 });
    live.lose();
    expect(live.view()).toEqual({ mode: "fallback", offer: QUESTION_1 });
  });

  it("tells the coach which question is on screen", async () => {
    const live = setup();
    live.deps.ask.mockResolvedValueOnce(ok(QUESTION_1));
    await firstRead(live);
    await live.pause(2000);
    expect(live.view()).toMatchObject({ offer: QUESTION_1 });
    await live.speak(3000);
    live.say(MORE);
    await live.pause(1600);
    expect(live.deps.ask.mock.calls[1][0]).toMatchObject({ shown: 1, skip: null });
  });

  // Text often lands more than 0.5 s after a turn ends, so after a read at the 1.2 s pause: that
  // read would miss the turn, and its question would then be held for it (below).
  it("waits for the text of the turn they have just ended, so the read hears it and its question shows", async () => {
    const live = setup();
    live.deps.ask.mockResolvedValueOnce(ok(null)).mockResolvedValueOnce(ok(QUESTION_2));
    await firstRead(live);
    await live.speak(8000);
    await live.pause(900); // a breath: the turn ends
    await live.speak(500);
    live.say(MORE); // its text, landing as they go on
    await live.speak(11_500);
    await live.pause(1500); // the last turn ends at 0.7 s; its text isn't back
    expect(live.deps.ask).toHaveBeenCalledOnce();
    live.say(TEAM_STRETCHED);
    await live.pause(500);
    expect(live.deps.ask).toHaveBeenCalledTimes(2);
    expect(live.deps.ask.mock.calls[1][0].transcript).toContain(TEAM_STRETCHED);
    expect(live.deps.ask.mock.calls[1][0]).not.toHaveProperty("reread");
    expect(live.view()).toMatchObject({ mode: "live", offer: QUESTION_2 });
  });

  it("reads without a turn's text once it is 1.5 s late", async () => {
    const live = setup();
    await live.record();
    await live.pause(500);
    await live.speak(3000);
    live.say(FIRST_ANSWER);
    await live.pause(900);
    await live.speak(2000); // a turn whose text never comes back
    await live.pause(1600);
    expect(live.deps.ask).not.toHaveBeenCalled();
    // It ended at 0.7 s of this pause, or a tick after.
    await live.pause(TEXT_WAIT_MS - 600 + 250);
    expect(live.deps.ask).toHaveBeenCalledOnce();
    expect(live.deps.ask.mock.calls[0][0]).toMatchObject({ transcript: FIRST_ANSWER });
  });
});

// The read behind the waiting offer was asked for, then they said more before it was shown: the
// offer may be about what they have just covered, so it waits for a read that has heard them.
describe("an offer they have said more since", () => {
  // Read 1 finds nothing to ask yet; read 2, at the pause after more about their work, answers when
  // the test says.
  async function secondRead(live: ReturnType<typeof setup>, second: Promise<CoachResponse>) {
    live.deps.ask.mockResolvedValueOnce(ok(null)).mockReturnValueOnce(second);
    await firstRead(live);
    await live.speak(16_000);
    live.say(MORE);
    await live.pause(1600);
    expect(live.deps.ask).toHaveBeenCalledTimes(2);
  }

  it.each([
    ["its question", QUESTION_2, QUESTION_2],
    ["nothing new when it finds nothing worth asking", null, { id: 0 }],
  ] as const)("isn't shown after a short remark its read never heard; a read that heard it shows %s", async (_label, confirmed, shown) => {
    const second = deferred<CoachResponse>();
    const live = setup();
    await secondRead(live, second.promise);
    live.deps.ask.mockResolvedValueOnce(ok(confirmed));
    await live.speak(1500);
    live.say(TEAM_OK);
    second.resolve(ok(TEAM_QUESTION));
    await live.pause(1000); // the remark's turn ends; too soon for a read
    expect(live.view()).toMatchObject({ offer: { id: 0 } });
    expect(live.deps.ask).toHaveBeenCalledTimes(2);
    // TEAM_QUESTION used to show after 1.5 s of this. The read to confirm it goes at the 1.2 s
    // pause, without waiting the usual 5 s after the last, and its answer is what shows.
    await live.pause(1500);
    expect(live.deps.ask).toHaveBeenCalledTimes(3);
    expect(live.deps.ask.mock.calls[2][0]).toMatchObject({ reread: true, transcript: expect.stringContaining(TEAM_OK) });
    expect(live.view()).toMatchObject({ mode: "live", offer: shown });
    expect(live.offersShown()).not.toContain(TEAM_QUESTION.id);
    // Ordinary reads don't say reread at all.
    expect(live.deps.ask.mock.calls[1][0]).not.toHaveProperty("reread");
  });

  it("is held while the text of what they went on to say is late, then a read of it decides", async () => {
    const second = deferred<CoachResponse>();
    const live = setup();
    await secondRead(live, second.promise);
    live.deps.ask.mockResolvedValueOnce(ok(QUESTION_2));
    await live.speak(4000);
    second.resolve(ok(TEAM_QUESTION));
    await live.pause(2000); // no text back yet
    expect(live.view()).toMatchObject({ offer: { id: 0 } });
    expect(live.deps.ask).toHaveBeenCalledTimes(2);
    live.say(TEAM_STRETCHED);
    await live.pause(500);
    expect(live.deps.ask.mock.calls[2][0]).toMatchObject({ reread: true, transcript: expect.stringContaining(TEAM_STRETCHED) });
    expect(live.view()).toMatchObject({ mode: "live", offer: QUESTION_2 });
    expect(live.offersShown()).not.toContain(TEAM_QUESTION.id);
  });

  it("is dropped, not shown, when what they went on to say never comes back as text", async () => {
    const second = deferred<CoachResponse>();
    const live = setup();
    await secondRead(live, second.promise);
    await live.speak(1500);
    second.resolve(ok(TEAM_QUESTION));
    await live.pause(10_000);
    expect(live.view()).toMatchObject({ offer: { id: 0 } });
    expect(live.deps.ask).toHaveBeenCalledTimes(2);
    // Text that comes back after that is read as usual, with nothing held to confirm.
    live.say(TEAM_OK);
    await live.pause(500);
    expect(live.deps.ask).toHaveBeenCalledTimes(3);
    expect(live.deps.ask.mock.calls[2][0]).not.toHaveProperty("reread");
    expect(live.offersShown()).not.toContain(TEAM_QUESTION.id);
  });

  it("has a sub-second remark transcribed at the pause, and a read of it decides", async () => {
    const second = deferred<CoachResponse>();
    const live = setup();
    await secondRead(live, second.promise);
    live.deps.ask.mockResolvedValueOnce(ok(QUESTION_2));
    const commits = live.connection.commit.mock.calls.length;
    await live.speak(600);
    second.resolve(ok(TEAM_QUESTION));
    await live.pause(1000);
    // Shorter than a turn has to be otherwise.
    expect(live.connection.commit).toHaveBeenCalledTimes(commits + 1);
    live.say("Team ok lah.");
    await live.pause(3500);
    expect(live.deps.ask.mock.calls[2][0]).toMatchObject({ reread: true, transcript: expect.stringContaining("Team ok lah.") });
    expect(live.view()).toMatchObject({ mode: "live", offer: QUESTION_2 });
    expect(live.offersShown()).not.toContain(TEAM_QUESTION.id);
  });

  // A cough, a laugh or an "mm" after the read: long enough to count as speech, but no words.
  it.each([
    ["no text", ""],
    ["only punctuation", "..."],
  ])("is shown once what they went on to say comes back as %s: the read missed nothing", async (_label, transcript) => {
    const second = deferred<CoachResponse>();
    const live = setup();
    await secondRead(live, second.promise);
    await live.speak(400);
    second.resolve(ok(TEAM_QUESTION));
    await live.pause(1000);
    expect(live.view()).toMatchObject({ offer: { id: 0 } });
    live.say(transcript);
    await live.pause(1000);
    expect(live.view()).toMatchObject({ mode: "live", offer: TEAM_QUESTION });
    // Nothing new to read.
    expect(live.deps.ask).toHaveBeenCalledTimes(2);
  });

  it("is dropped when what they went on to say failed to transcribe", async () => {
    const second = deferred<CoachResponse>();
    const live = setup();
    await secondRead(live, second.promise);
    await live.speak(400);
    second.resolve(ok(TEAM_QUESTION));
    await live.pause(1000);
    live.fail();
    await live.pause(10_000);
    expect(live.view()).toMatchObject({ offer: { id: 0 } });
    expect(live.offersShown()).not.toContain(TEAM_QUESTION.id);
  });

  it("is shown at the pause when no read is left to confirm it", async () => {
    const last = deferred<CoachResponse>();
    const live = setup();
    await firstRead(live);
    for (let reads = 1; reads < MAX_READS - 1; reads++) {
      await live.speak(3000);
      live.say(MORE);
      await live.pause(2500);
    }
    expect(live.deps.ask).toHaveBeenCalledTimes(MAX_READS - 1);
    live.deps.ask.mockReturnValueOnce(last.promise);
    await live.speak(3000);
    live.say(MORE);
    await live.pause(1600);
    expect(live.deps.ask).toHaveBeenCalledTimes(MAX_READS);
    await live.speak(1500);
    live.say(TEAM_OK);
    last.resolve(ok(COVERED));
    await live.pause(2000);
    expect(live.view()).toMatchObject({ mode: "live", offer: COVERED });
    expect(live.deps.ask).toHaveBeenCalledTimes(MAX_READS);
  });
});

describe("Different question", () => {
  it("asks at once and shows the new question straight away, even mid-sentence", async () => {
    const live = setup();
    live.deps.ask.mockResolvedValueOnce(ok(QUESTION_1)).mockResolvedValueOnce(ok(QUESTION_2));
    await firstRead(live);
    await live.pause(2000);
    expect(live.view()).toMatchObject({ offer: QUESTION_1 });
    await live.speak(500);
    act(() => live.coach.skip());
    await advance(0);
    expect(live.deps.ask).toHaveBeenCalledTimes(2);
    expect(live.deps.ask.mock.calls[1][0]).toMatchObject({ shown: 1, skip: 1 });
    expect(live.view()).toMatchObject({ offer: QUESTION_2 });
  });

  it("isn't offered for the opening question", async () => {
    const live = setup();
    await firstRead(live);
    live.coach.skip();
    await advance(0);
    expect(live.deps.ask.mock.calls.every(([request]) => request.skip === null)).toBe(true);
  });

  it("waits for a call already on its way, then replaces the question", async () => {
    const read = deferred<CoachResponse>();
    const live = setup();
    live.deps.ask
      .mockResolvedValueOnce(ok(QUESTION_1))
      .mockReturnValueOnce(read.promise)
      .mockResolvedValueOnce(ok(COVERED));
    await firstRead(live);
    await live.pause(2000);
    await live.speak(3000);
    live.say(MORE);
    await live.pause(1600); // the second read is now on its way
    act(() => live.coach.skip());
    await advance(0);
    expect(live.deps.ask).toHaveBeenCalledTimes(2);
    read.resolve(ok(QUESTION_2)); // superseded by the skip: never shown
    await advance(1500);
    expect(live.deps.ask).toHaveBeenCalledTimes(3);
    expect(live.deps.ask.mock.calls[2][0]).toMatchObject({ shown: 1, skip: 1 });
    expect(live.view()).toMatchObject({ offer: COVERED });
  });
});

describe("falling back", () => {
  it("falls back after two coach calls fail in a row, and ends the session", async () => {
    const live = setup({ ask: vi.fn(async () => null) });
    await firstRead(live);
    expect(live.view()?.mode).toBe("live");
    await live.speak(3000);
    live.say(MORE);
    await live.pause(6000);
    expect(live.deps.ask).toHaveBeenCalledTimes(2);
    expect(live.view()).toMatchObject({ mode: "fallback", offer: { id: 0 } });
    expect(live.connection.close).toHaveBeenCalledOnce();
    expect(live.deps.end).toHaveBeenCalledExactlyOnceWith({
      sessionId: SESSION,
      recordedMs: expect.any(Number),
      shown: 0,
      fallback: "coach_failures",
    });
    expect(live.coach.stop()).toBe(SESSION); // the take still records which session it was
    expect(live.deps.end).toHaveBeenCalledOnce();
  });

  it("counts a read Claude couldn't make as a failure, but a good one in between starts the count again", async () => {
    const live = setup();
    live.deps.ask
      .mockResolvedValueOnce(ok(null, true))
      .mockResolvedValueOnce(ok(null))
      .mockResolvedValueOnce(ok(null, true));
    await firstRead(live);
    for (const words of [MORE, FIRST_ANSWER]) {
      await live.speak(3000);
      live.say(words);
      await live.pause(6000);
    }
    expect(live.deps.ask).toHaveBeenCalledTimes(3);
    expect(live.view()?.mode).toBe("live");
  });

  it.each(["submitted", "session_over"] as const)("falls back at once when the session is %s", async (code) => {
    const live = setup({ ask: vi.fn(async () => ({ status: "error", code }) as const) });
    await firstRead(live);
    expect(live.view()).toMatchObject({ mode: "fallback", offer: { id: 0 } });
    expect(live.deps.end).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: SESSION, fallback: "final_code" }));
  });

  it("falls back when the transcription connection is lost", async () => {
    const live = setup();
    await live.record();
    live.lose();
    expect(live.view()).toMatchObject({ mode: "fallback", offer: { id: 0 } });
    expect(live.deps.end).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: SESSION, fallback: "connection_lost" }));
  });

  it("falls back when they keep talking and no text comes back", async () => {
    const live = setup();
    await live.record();
    await live.pause(500);
    await live.speak(NO_TEXT_WHILE_SPEAKING_MS - 1000);
    expect(live.view()?.mode).toBe("live");
    await live.speak(1500);
    expect(live.view()).toMatchObject({ mode: "fallback", offer: { id: 0 } });
    expect(live.deps.end).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: SESSION, fallback: "no_text" }));
  });

  it("stays without follow-ups for the rest of the take", async () => {
    const live = setup({ ask: vi.fn(async () => ({ status: "error", code: "submitted" }) as const) });
    await firstRead(live);
    await live.speak(3000);
    live.say(MORE);
    await live.pause(10_000);
    expect(live.deps.ask).toHaveBeenCalledOnce();
    expect(live.view()).toMatchObject({ mode: "fallback", offer: { id: 0 } });
  });
});

describe("finishing", () => {
  it("ends the session once, with how long live transcription heard, and closes everything", async () => {
    const live = setup();
    await live.record();
    await live.pause(30_000);
    expect(live.coach.stop()).toBe(SESSION);
    expect(live.deps.end).toHaveBeenCalledExactlyOnceWith({ sessionId: SESSION, recordedMs: 30_000, shown: 0 });
    // No reason: live coaching never stopped early (and a server from before it would refuse the key).
    expect(live.deps.end.mock.calls[0][0]).not.toHaveProperty("fallback");
    expect(live.connection.close).toHaveBeenCalledOnce();
    expect(live.meterStopped).toHaveBeenCalledOnce();
    expect(live.signal()?.aborted).toBe(true);

    expect(live.coach.stop()).toBe(SESSION);
    await live.speak(3000);
    live.say(FIRST_ANSWER);
    await live.pause(5000);
    expect(live.deps.end).toHaveBeenCalledOnce();
    expect(live.deps.ask).not.toHaveBeenCalled();
    expect(live.connection.commit).not.toHaveBeenCalled();
  });

  // The last question or closing line often reaches the screen with no coach call after it, so the
  // end call says what was on screen for the coach to count.
  it("ends the session with the follow-up on screen", async () => {
    const live = setup();
    live.deps.ask.mockResolvedValueOnce(ok(QUESTION_1));
    await firstRead(live);
    await live.pause(2000);
    expect(live.view()).toMatchObject({ offer: QUESTION_1 });
    live.coach.stop();
    expect(live.deps.end).toHaveBeenCalledExactlyOnceWith({ sessionId: SESSION, recordedMs: expect.any(Number), shown: 1 });
  });

  it("ends the session with what is on screen, not an offer still waiting for a pause", async () => {
    const live = setup();
    live.deps.ask.mockResolvedValueOnce(ok(QUESTION_1));
    await firstRead(live);
    // The coach has answered with a question, which waits while they keep talking.
    expect(live.deps.ask).toHaveBeenCalledOnce();
    await live.speak(5000);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 } });
    live.coach.stop();
    expect(live.deps.end).toHaveBeenCalledExactlyOnceWith({ sessionId: SESSION, recordedMs: expect.any(Number), shown: 0 });
  });

  it("ends the session with the closing line on screen", async () => {
    const live = setup();
    live.deps.ask.mockResolvedValueOnce(ok(COVERED));
    await firstRead(live);
    await live.pause(2000);
    expect(live.view()).toMatchObject({ offer: COVERED });
    live.coach.stop();
    expect(live.deps.end).toHaveBeenCalledExactlyOnceWith({ sessionId: SESSION, recordedMs: expect.any(Number), shown: COVERED.id });
  });

  it("drops a coach answer that arrives after Finish", async () => {
    const answer = deferred<CoachResponse>();
    const live = setup({ ask: vi.fn(() => answer.promise) });
    await firstRead(live);
    const before = live.view();
    live.coach.stop();
    answer.resolve(ok(QUESTION_1));
    await live.pause(5000);
    expect(live.view()).toBe(before);
  });

  it("starts afresh for the next take", async () => {
    const live = setup();
    await live.record();
    live.lose();
    expect(live.view()).toMatchObject({ mode: "fallback", offer: { id: 0 } });
    live.coach.stop();
    await live.record();
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 } });
    expect(live.deps.start).toHaveBeenCalledTimes(2);
  });
});

describe("useLiveCoach", () => {
  function Harness({ deps, onCoach }: { deps: Partial<LiveCoachDeps>; onCoach: (coach: LiveCoachController) => void }) {
    const { view, coach } = useLiveCoach({ opening: OPENING }, deps);
    useEffect(() => onCoach(coach), [coach, onCoach]);
    return <p>{view?.mode === "live" ? view.offer.text : view?.mode}</p>;
  }

  it("shows the opening question, and leaving the page ends the session and lets go of everything", async () => {
    const live = setup();
    let coach: LiveCoachController | null = null;
    const page = await render(
      <Harness
        deps={live.deps}
        onCoach={(c) => {
          coach = c;
        }}
      />,
    );
    expect(text()).toBe(OPENING);
    act(() => {
      coach?.begin();
      coach?.attach(STREAM);
    });
    await advance(5000);
    expect(live.deps.connect).toHaveBeenCalledOnce();

    await page.rerender(null);
    expect(live.deps.end).toHaveBeenCalledExactlyOnceWith({ sessionId: SESSION, recordedMs: 5000, shown: 0 });
    expect(live.connection.close).toHaveBeenCalledOnce();
    expect(live.meterStopped).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("ends the session when the tab is closed", async () => {
    const live = setup();
    let coach: LiveCoachController | null = null;
    await render(
      <Harness
        deps={live.deps}
        onCoach={(c) => {
          coach = c;
        }}
      />,
    );
    act(() => {
      coach?.begin();
      coach?.attach(STREAM);
    });
    await advance(2000);
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(live.deps.end).toHaveBeenCalledExactlyOnceWith({ sessionId: SESSION, recordedMs: 2000, shown: 0 });
    expect(live.connection.close).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("does nothing without live check-ins", async () => {
    let coach: LiveCoachController | null = null;
    function Off() {
      const { view, coach: c } = useLiveCoach(undefined);
      useEffect(() => {
        coach = c;
      }, [c]);
      return <p>{view === null ? "no follow-ups" : "live"}</p>;
    }
    await render(<Off />);
    expect(text()).toBe("no follow-ups");
    expect(coach!.stop()).toBeNull();
    vi.useRealTimers();
  });
});
