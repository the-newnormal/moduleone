// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pacing } from "@/lib/coach/types";
import { render, text } from "@/test/dom";
import type { LiveReady } from "./api";
import type { CoachResponse, ShownOffer } from "./contract";
import {
  CHECKING_AFTER_MS,
  CONNECT_TIMEOUT_MS,
  LIMIT_SLACK_MS,
  MAX_READS,
  MIN_BUSY_MS,
  NO_TEXT_WHILE_SPEAKING_MS,
  RENEW_AFTER_MS,
  TEXT_WAIT_MS,
} from "./pacing";
import type { TranscriptEvent } from "./transcript";
import type { LiveConnection } from "./transport";
import {
  COACH_TIMEOUT_MS,
  createLiveCoach,
  METER_WAIT_MS,
  MIN_ASK_GAP_MS,
  openingOffer,
  TICK_MS,
  useLiveCoach,
  type LiveCoachController,
  type LiveCoachDeps,
  type LiveView,
} from "./use-live-coach";

// The live coach with every browser part faked: the routes, the transcription connection, the level
// meter (driven by how loud the test says the room is) and the clock (Date, under fake timers).

const SESSION = "5e550000-0000-4000-8000-000000000001";
const OPENING =
  "Talk me through your week, Monday to Saturday: what you worked on and what came of it, a moment you or your team were at your best, and how you're feeling about the team.";
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
const LATE: ShownOffer = { id: 5, kind: "late", text: "Whenever you're ready, press Finish." };
// What they say after the read that offered TEAM_QUESTION was asked for, which answers it.
const TEAM_OK = "Team ok lah, quite happy.";
// 17 words.
const TEAM_STRETCHED = "Actually the team has been quite stretched lah, two people out sick and everyone covering for them.";

type CoachOk = Extract<CoachResponse, { status: "ok" }>;

function ok(offer: ShownOffer | null, degraded = false): CoachOk {
  return { status: "ok", offer, touched: { activity: true, excellence: false, morale: false }, degraded, more: true };
}

// The coach says no later read can bring a follow-up question once this offer (if any) is on screen.
function lastOne(offer: ShownOffer | null): CoachOk {
  return { status: "ok", offer, touched: { activity: true, excellence: false, morale: false }, degraded: false, more: false };
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
  // When each view came.
  const times: number[] = [];
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
  const coach = createLiveCoach({
    opening: OPENING,
    deps,
    onView: (view) => {
      views.push(view);
      times.push(Date.now());
    },
  });
  const statusOf = (v: LiveView) => (v.mode === "live" ? v.status : v.mode);

  return {
    coach,
    deps,
    connection,
    meterStopped,
    view: () => views.at(-1),
    views: () => views,
    // Every offer that has been on screen, in order.
    offersShown: () => views.map((v) => v.offer.id),
    // What the line under the question has said, view by view (a fallback view by its mode).
    statuses: () => views.map(statusOf),
    // What the line said, change by change, with how long it said it (null for what it says now).
    spans: () => {
      const spans: { status: string; at: number; ms: number | null }[] = [];
      views.forEach((v, i) => {
        const last = spans.at(-1);
        if (last?.status === statusOf(v)) return;
        if (last) last.ms = times[i] - last.at;
        spans.push({ status: statusOf(v), at: times[i], ms: null });
      });
      return spans.map(({ status, ms }) => ({ status, ms }));
    },
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
    // A turn's draft text, as it arrives while they speak; its final text replaces it (finish).
    draft(words: string) {
      const itemId = `item_${++item}`;
      act(() => {
        onEvent?.({ type: "committed", itemId, previousItemId: item > 1 ? `item_${item - 1}` : null });
        onEvent?.({ type: "delta", itemId, delta: words });
      });
      return itemId;
    },
    finish(itemId: string, transcript: string) {
      act(() => onEvent?.({ type: "completed", itemId, transcript }));
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
      status: "starting",
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
    expect(live.view()).toEqual({ mode: "fallback", offer: QUESTION_1, started: true });
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
    // Text that comes back after that is read with Claude, however short, so the server doesn't
    // offer the dropped question again from what it knew before.
    live.say(TEAM_OK);
    await live.pause(500);
    expect(live.deps.ask).toHaveBeenCalledTimes(3);
    expect(live.deps.ask.mock.calls[2][0]).toMatchObject({ reread: true, transcript: expect.stringContaining(TEAM_OK) });
    expect(live.offersShown()).not.toContain(TEAM_QUESTION.id);
    // Only that one read.
    live.say("And the deck went out.");
    await live.pause(5000);
    expect(live.deps.ask).toHaveBeenCalledTimes(4);
    expect(live.deps.ask.mock.calls[3][0]).not.toHaveProperty("reread");
  });

  it("still owes that read when it fails, so the next words are read with Claude too", async () => {
    const second = deferred<CoachResponse>();
    const live = setup();
    await secondRead(live, second.promise);
    await live.speak(1500);
    second.resolve(ok(TEAM_QUESTION));
    await live.pause(10_000);
    live.deps.ask.mockRejectedValueOnce(new Error("network"));
    live.say(TEAM_OK);
    await live.pause(500);
    expect(live.deps.ask).toHaveBeenCalledTimes(3);
    expect(live.deps.ask.mock.calls[2][0]).toMatchObject({ reread: true });
    // That read never reached Claude: the next few words are read with it, not decided from before.
    live.say("Ya.");
    await live.pause(6000);
    expect(live.deps.ask).toHaveBeenCalledTimes(4);
    expect(live.deps.ask.mock.calls[3][0]).toMatchObject({ reread: true, transcript: expect.stringContaining(TEAM_OK) });
    expect(live.offersShown()).not.toContain(TEAM_QUESTION.id);
  });

  // A remark while the read is still out isn't left for later: if that read's answer came after
  // they had clearly stopped, with the remark's text not back, the offer would go, and the server
  // would offer it again from what it knew.
  it("has a sub-second remark made while its read is out transcribed at the pause", async () => {
    const second = deferred<CoachResponse>();
    const live = setup();
    await secondRead(live, second.promise);
    const commits = live.connection.commit.mock.calls.length;
    await live.speak(600);
    await live.pause(1000);
    expect(live.connection.commit).toHaveBeenCalledTimes(commits + 1);
  });

  it("is held once: the read that confirms it decides, and its question shows at the next pause even if they said more", async () => {
    const second = deferred<CoachResponse>();
    const confirming = deferred<CoachResponse>();
    const live = setup();
    await secondRead(live, second.promise);
    live.deps.ask.mockReturnValueOnce(confirming.promise);
    await live.speak(1500);
    live.say(TEAM_OK);
    second.resolve(ok(TEAM_QUESTION));
    await live.pause(1500); // the read to confirm it goes at the 1.2 s pause
    expect(live.deps.ask).toHaveBeenCalledTimes(3);
    expect(live.deps.ask.mock.calls[2][0]).toMatchObject({ reread: true });
    // They go on before it answers: a pause shorter than a read is all they give.
    await live.speak(1500);
    confirming.resolve(ok(QUESTION_2));
    live.say("Ya, everyone pitched in.");
    await live.pause(1600);
    expect(live.view()).toMatchObject({ mode: "live", offer: QUESTION_2 });
    // No read to confirm the confirmation.
    expect(live.deps.ask).toHaveBeenCalledTimes(3);
    expect(live.offersShown()).not.toContain(TEAM_QUESTION.id);
  });

  // What they said before it showed was said to the question before: a read of only that would bring
  // a question that, once they have clearly stopped, replaces this one while they think about it.
  it("isn't replaced, while they think about it, by a read of what they said before it showed", async () => {
    const second = deferred<CoachResponse>();
    const confirming = deferred<CoachResponse>();
    const live = setup();
    await secondRead(live, second.promise);
    live.deps.ask.mockReturnValueOnce(confirming.promise).mockResolvedValue(ok(TEAM_QUESTION));
    await live.speak(1500);
    live.say(TEAM_OK);
    second.resolve(ok(QUESTION_1));
    await live.pause(1500); // the read to confirm it goes
    expect(live.deps.ask).toHaveBeenCalledTimes(3);
    await live.speak(1500);
    confirming.resolve(ok(QUESTION_2));
    await live.speak(4500);
    live.say(MORE); // 21 words since that read
    await live.pause(10_000);
    expect(live.view()).toMatchObject({ mode: "live", offer: QUESTION_2 });
    expect(live.deps.ask).toHaveBeenCalledTimes(3);
  });

  it("gets at most one read to confirm it while they go on in short phrases", async () => {
    const second = deferred<CoachResponse>();
    const live = setup();
    await secondRead(live, second.promise);
    let id = 10;
    live.deps.ask.mockImplementation(async () => ok({ id: ++id, kind: "question", text: `Question ${id}?` }));
    await live.speak(600);
    live.say("Team ok lah.");
    second.resolve(ok(TEAM_QUESTION));
    // Five more short phrases (13 words), each with a pause too short for a question to show.
    for (const phrase of ["Quite happy.", "Busy though.", "Two people out.", "We managed.", "Deck went out."]) {
      await live.pause(1300);
      await live.speak(600);
      live.say(phrase);
    }
    await live.pause(1300);
    expect(live.deps.ask).toHaveBeenCalledTimes(3);
  });

  it("isn't confirmed before the question on screen has had its time, but is once they have clearly stopped", async () => {
    const live = setup();
    live.deps.ask.mockResolvedValueOnce(ok(TEAM_QUESTION)).mockResolvedValueOnce(ok(QUESTION_2));
    await firstRead(live); // TEAM_QUESTION waits: too early for a follow-up
    await live.speak(1500);
    live.say(TEAM_OK);
    await live.pause(1600);
    // It couldn't be shown yet anyway: no read is spent on it at this pause.
    expect(live.deps.ask).toHaveBeenCalledOnce();
    await live.pause(2000);
    expect(live.deps.ask).toHaveBeenCalledTimes(2);
    expect(live.deps.ask.mock.calls[1][0]).toMatchObject({ reread: true, transcript: expect.stringContaining(TEAM_OK) });
    expect(live.view()).toMatchObject({ mode: "live", offer: QUESTION_2 });
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

  // Someone who talks 7 s at a time with 3.5 s pauses, and coach calls that take 2.5 s (Claude's read,
  // the route's database calls, the network), with coach.md's pacing: every answer comes once they
  // talk again, so every offer is held for what they said meanwhile. The one a read that heard them
  // brings shows at their next pause: no newer read holds it back and replaces it with one held again.
  it("still shows when every read answers after they talk again, and is only said to be coming once it will", async () => {
    const coachMd: Pacing = { showAfterSilenceMs: 2500, stoppedSilenceMs: 6000, minQuestionMs: 20_000, minWordsPerQuestion: 20, firstFollowUpAfterMs: 25_000 };
    const live = setup({ start: vi.fn(async () => ({ ...READY, pacing: coachMd })) });
    let next = 10;
    live.deps.ask.mockImplementation(
      () =>
        new Promise((resolve) => {
          const offer: ShownOffer = { id: next++, kind: "question", text: "How did the team take it?" };
          setTimeout(() => resolve(ok(offer)), 2500);
        }),
    );
    const startedAt = Date.now();
    await live.record();
    await live.pause(500); // quiet: the meter learns the room
    while (Date.now() - startedAt < 210_000) {
      await live.speak(7000);
      live.say(MORE);
      await live.pause(3500);
    }
    expect(new Set(live.offersShown().filter((id) => id !== 0)).size).toBeGreaterThanOrEqual(3);
    // "A follow-up will show when you pause." only ever gives way to that follow-up.
    expect(live.statuses()).toContain("ready");
    const views = live.views();
    views.forEach((view, i) => {
      const after = views[i + 1];
      if (view.mode === "live" && view.status === "ready" && after && !(after.mode === "live" && after.status === "ready")) {
        expect(after.offer.id).not.toBe(view.offer.id);
      }
    });
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

// The line under the question (followUpStatus in pacing.ts): starting, listening, checking for a
// follow-up, one ready for their next pause, or no more. Only "ready" says one is coming.
// Someone who talks on with pauses long enough for a read but too short for a question to show
// (2.5 s here, as in coach.md): a question a read that heard them brought waits, as it is, for their
// next pause, however long they talk.
describe("a question lined up to show while they talk on", () => {
  const start = vi.fn(async () => ({ ...READY, pacing: { ...PACING, showAfterSilenceMs: 2500 } }));

  // QUESTION_2 lined up by a read that heard them; returns when that read was asked for.
  async function lineUp(live: ReturnType<typeof setup>) {
    live.deps.ask.mockResolvedValueOnce(ok(QUESTION_1)).mockResolvedValueOnce(ok(QUESTION_2));
    const startedAt = Date.now();
    await firstRead(live); // QUESTION_1 waits: too early for a follow-up
    await live.speak(8000);
    live.say(MORE);
    await live.speak(8000); // past 20 s: QUESTION_1 is held for what they said
    await live.pause(1800); // a read that heard them goes, and answers at once
    expect(live.deps.ask).toHaveBeenCalledTimes(2);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "ready" });
    return startedAt + live.deps.ask.mock.calls[1][0].elapsedMs;
  }

  // Talks on until the read behind the waiting question is RENEW_AFTER_MS old, with no read meanwhile.
  async function talkPast(live: ReturnType<typeof setup>, readAt: number) {
    while (Date.now() + 7800 < readAt + RENEW_AFTER_MS) {
      await live.speak(6000);
      live.say(MORE);
      await live.pause(1800);
    }
    expect(live.deps.ask).toHaveBeenCalledTimes(2);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "ready" });
    await live.speak(readAt + RENEW_AFTER_MS - Date.now() + 500);
    live.say(MORE);
  }

  it("is renewed once its read is 30 s old, and the question that renews it is the one that shows", async () => {
    const live = setup({ start });
    const readAt = await lineUp(live);
    await talkPast(live, readAt);
    live.deps.ask.mockResolvedValueOnce(ok(TEAM_QUESTION));
    await live.pause(1800); // a read goes, and answers at once: too short a pause for it to show
    expect(live.deps.ask).toHaveBeenCalledTimes(3);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "ready" });
    // It isn't held for what they say next: a read that heard them brought it.
    await live.speak(6000);
    live.say(MORE);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "ready" });
    await live.pause(3000);
    expect(live.view()).toMatchObject({ mode: "live", offer: TEAM_QUESTION, status: "listening" });
    expect(live.offersShown()).not.toContain(QUESTION_2.id);
    expect(live.deps.ask).toHaveBeenCalledTimes(3);
  });

  it("still shows at their next pause while the read renewing it is out, and that read's answer then changes nothing", async () => {
    const renewing = deferred<CoachResponse>();
    const live = setup({ start });
    const readAt = await lineUp(live);
    await talkPast(live, readAt);
    live.deps.ask.mockReturnValueOnce(renewing.promise);
    await live.pause(1800);
    expect(live.deps.ask).toHaveBeenCalledTimes(3);
    // A read out that may drop it: no longer promised, once that read has been out a second.
    await live.speak(4000);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "checking" });
    await live.pause(3000);
    expect(live.view()).toMatchObject({ mode: "live", offer: QUESTION_2, status: "listening" });
    const shown = live.views().length;
    await live.pause(2000);
    renewing.resolve(lastOne(null)); // nothing to ask, and none after: of the question before
    await live.pause(10_000);
    expect(live.view()).toMatchObject({ mode: "live", offer: QUESTION_2, status: "listening" });
    // That read is about the question before: nothing it does is said under this one.
    expect(live.statuses().slice(shown)).not.toContain("checking");
    expect(live.statuses()).not.toContain("no_more");
  });

  it("goes when the read renewing it finds nothing to ask now", async () => {
    const live = setup({ start });
    const readAt = await lineUp(live);
    await talkPast(live, readAt);
    live.deps.ask.mockResolvedValue(ok(null));
    await live.pause(1800);
    expect(live.deps.ask).toHaveBeenCalledTimes(3);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "listening" });
    await live.pause(10_000);
    expect(live.offersShown()).not.toContain(QUESTION_2.id);
  });

  it.each([
    ["fails", (live: ReturnType<typeof setup>) => live.deps.ask.mockRejectedValueOnce(new Error("network")), 4000],
    ["is turned away", (live: ReturnType<typeof setup>) => live.deps.ask.mockResolvedValueOnce({ status: "error", code: "unavailable" }), 4000],
    ["comes back degraded", (live: ReturnType<typeof setup>) => live.deps.ask.mockResolvedValueOnce(ok(TEAM_QUESTION, true)), 4000],
    ["never answers", (live: ReturnType<typeof setup>) => live.deps.ask.mockReturnValueOnce(new Promise(() => {})), COACH_TIMEOUT_MS + 1000],
  ])("stays as it was when the read renewing it %s", async (_name, answer, talkMs) => {
    const live = setup({ start });
    const readAt = await lineUp(live);
    await talkPast(live, readAt);
    answer(live);
    await live.pause(1800);
    expect(live.deps.ask).toHaveBeenCalledTimes(3);
    await live.speak(talkMs);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "ready" });
    await live.pause(3000);
    expect(live.view()).toMatchObject({ mode: "live", offer: QUESTION_2 });
    expect(live.offersShown()).not.toContain(TEAM_QUESTION.id);
  });
});

describe("what they're told is coming", () => {
  // The first view with this offer on screen.
  const firstWith = (live: ReturnType<typeof setup>, id: number) => live.views().find((v) => v.offer.id === id);
  // Every status since view `from`, with the offer it was under.
  const since = (live: ReturnType<typeof setup>, from: number) =>
    live.views().slice(from).map((v) => [v.offer.id, v.mode === "live" ? v.status : v.mode]);

  it("says follow-ups are starting until live transcription connects, then that it is listening", async () => {
    const connected = deferred<LiveConnection>();
    const live = setup({ connect: vi.fn(() => connected.promise) });
    await live.record();
    expect(live.view()).toMatchObject({ mode: "live", status: "starting" });
    await live.pause(5000);
    expect(live.view()).toMatchObject({ mode: "live", status: "starting" });
    connected.resolve(live.connection);
    await advance(0);
    await advance(TICK_MS);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "listening" });
    expect(live.statuses()).toEqual(["starting", "listening"]);
  });

  // Before the question on screen has had its time, a question shows only once they have clearly
  // stopped: a short pause promises nothing, as they may talk again first.
  it("promises nothing while they pause before the question's time, and shows it with listening once they have stopped", async () => {
    const live = setup();
    live.deps.ask.mockResolvedValueOnce(ok(QUESTION_1));
    await firstRead(live); // QUESTION_1 waits: too early for a follow-up
    await live.pause(400); // 2 s of quiet
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "listening" });
    await live.pause(1500); // they have clearly stopped: it shows
    expect(live.statuses()).not.toContain("ready");
    expect(live.view()).toMatchObject({ mode: "live", offer: QUESTION_1, status: "listening" });
    // The question and "Listening…" arrive together, never the question with what was coming.
    expect(firstWith(live, QUESTION_1.id)).toMatchObject({ status: "listening" });
  });

  // A slow read at a pause before the question's time: it says checking, and goes on saying so while
  // they stay quiet, until the question it brought shows once they have clearly stopped.
  it("goes on saying it is checking while they stay quiet, until the question a slow read brought shows", async () => {
    const read = deferred<CoachResponse>();
    const live = setup({ ask: vi.fn(() => read.promise), start: vi.fn(async () => ({ ...READY, pacing: { ...PACING, stoppedSilenceMs: 6000 } })) });
    await firstRead(live); // the read goes out at their pause, and doesn't answer yet
    await live.pause(2500);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "checking" });
    read.resolve(ok(QUESTION_1)); // too early for a follow-up: it shows once they have clearly stopped (6 s)
    await live.pause(TICK_MS);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "checking" });
    await live.pause(1000);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "checking" });
    await live.pause(1500);
    expect(live.view()).toMatchObject({ mode: "live", offer: QUESTION_1, status: "listening" });
    expect(live.spans().map(({ status }) => status)).toEqual(["starting", "listening", "checking", "listening"]);
  });

  it("has nothing to take back when they talk again before the question's time", async () => {
    const live = setup();
    live.deps.ask.mockResolvedValueOnce(ok(QUESTION_1));
    await firstRead(live);
    await live.pause(400);
    await live.speak(1800);
    // It won't show at their next short pause, and nothing said it would.
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "listening" });
    expect(live.spans()).toEqual([
      { status: "starting", ms: expect.any(Number) },
      { status: "listening", ms: null },
    ]);
  });

  it("says it is checking for a second at least when a slow read finds nothing just after it appeared", async () => {
    const read = deferred<CoachResponse>();
    const live = setup({ ask: vi.fn(() => read.promise) });
    await firstRead(live); // the read goes out at their pause, and doesn't answer yet
    await advance(800);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "checking" });
    read.resolve(ok(null));
    await advance(TICK_MS);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "checking" });
    await advance(MIN_BUSY_MS);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "listening" });
    expect(live.spans().find((span) => span.status === "checking")).toEqual({ status: "checking", ms: MIN_BUSY_MS });
  });

  it("goes from checking straight to the question a slow read brings while they stay quiet", async () => {
    const read = deferred<CoachResponse>();
    const live = setup({ ask: vi.fn(() => read.promise) });
    await firstRead(live);
    await advance(800);
    expect(live.view()).toMatchObject({ offer: { id: 0 }, status: "checking" });
    const from = live.views().length;
    read.resolve({ ...ok(QUESTION_1), touched: { activity: true, excellence: true, morale: false } });
    await live.pause(3000);
    expect(live.view()).toMatchObject({ offer: QUESTION_1, status: "listening" });
    // The areas tick at once; the line says nothing of one about to show, which then shows.
    expect(since(live, from)).toEqual([
      [0, "checking"],
      [QUESTION_1.id, "listening"],
    ]);
  });

  it("never says one will show just before it does", async () => {
    const live = setup();
    live.deps.ask.mockResolvedValueOnce(ok(QUESTION_1)).mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ ...ok(QUESTION_2), touched: { activity: true, excellence: true, morale: false } }), 400)),
    );
    await firstRead(live);
    await live.pause(2000); // QUESTION_1 shows
    await live.speak(8000);
    live.say(MORE); // QUESTION_1 has had its time
    const from = live.views().length;
    await live.pause(3000); // a read at the pause answers quickly, and its question shows at once
    expect(live.view()).toMatchObject({ offer: QUESTION_2, status: "listening", touched: { excellence: true } });
    expect(since(live, from).map(([, status]) => status)).not.toContain("ready");
  });

  it("says one is ready, while they still talk, once a read that heard them has lined it up and the question on screen has had its time", async () => {
    const confirming = deferred<CoachResponse>();
    const live = setup();
    live.deps.ask.mockResolvedValueOnce(ok(QUESTION_1)).mockReturnValueOnce(confirming.promise);
    await firstRead(live);
    await live.speak(5000);
    live.say(MORE);
    await live.speak(11_000); // past 20 s, still talking
    // QUESTION_1 waits, but its read never heard what they have said since: a read of that decides.
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "listening" });
    await live.pause(1500); // the read to confirm it goes
    expect(live.deps.ask).toHaveBeenCalledTimes(2);
    await live.speak(500);
    confirming.resolve(ok(QUESTION_2));
    await live.speak(TICK_MS);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "ready" });
    // It shows, as it is, at their next pause, whatever they say meanwhile; no read holds it back.
    await live.speak(6000);
    live.say(MORE);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "ready" });
    await live.pause(2000);
    expect(live.view()).toMatchObject({ mode: "live", offer: QUESTION_2, status: "listening" });
    expect(firstWith(live, QUESTION_2.id)).toMatchObject({ status: "listening" });
    expect(live.deps.ask).toHaveBeenCalledTimes(2);
    // The new question has its own time: a question waiting while they talk on isn't ready yet.
    live.deps.ask.mockResolvedValueOnce(ok(TEAM_QUESTION));
    await live.speak(4000);
    live.say(MORE);
    await live.pause(1500); // long enough to be a pause: the line may say ready, for a second
    expect(live.deps.ask).toHaveBeenCalledTimes(3);
    await live.speak(1500);
    expect(live.view()).toMatchObject({ mode: "live", offer: QUESTION_2, status: "listening" });
  });

  // A question held for what they said after its read isn't lined up: the read of what they said may
  // find it answered ("team ok lah"), and bring a closing line or nothing instead.
  it("never says a question held for what they said since its read will show, as that read may bring a closing line", async () => {
    const second = deferred<CoachResponse>();
    const confirming = deferred<CoachResponse>();
    const live = setup();
    await slowSecondRead(live, second.promise);
    live.deps.ask.mockReturnValueOnce(confirming.promise);
    await live.speak(1500);
    live.say(TEAM_OK);
    const from = live.views().length;
    second.resolve(ok(TEAM_QUESTION)); // held: they said TEAM_OK after its read was asked for
    await live.speak(2000);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "listening" });
    await live.pause(1500); // the read to confirm it goes, and takes a while
    expect(live.deps.ask).toHaveBeenCalledTimes(3);
    expect(live.deps.ask.mock.calls[2][0]).toMatchObject({ reread: true });
    await live.pause(1500);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "checking" });
    confirming.resolve(lastOne(COVERED)); // TEAM_OK was the last area worth asking about
    await live.pause(TICK_MS);
    expect(live.view()).toMatchObject({ mode: "live", offer: COVERED, status: "no_more" });
    expect(since(live, from).map(([, status]) => status)).not.toContain("ready");
    expect(live.offersShown()).not.toContain(TEAM_QUESTION.id);
  });

  // Someone who talks on, with pauses long enough for a read but too short for a question to show
  // (2.5 s, as in coach.md): once a read that heard them lines one up, the line says, without moving,
  // that it will show when they pause, all the while, and it does once they do.
  it("keeps saying, still, that a follow-up will show when they pause, while they talk on", async () => {
    const live = setup({ start: vi.fn(async () => ({ ...READY, pacing: { ...PACING, showAfterSilenceMs: 2500 } })) });
    let next = 10;
    live.deps.ask.mockImplementation(async () => ok({ id: next++, kind: "question", text: "What came of the vendor onboarding?" }));
    await firstRead(live); // offer 10 waits: too early for a follow-up
    await live.speak(8000);
    live.say(MORE);
    await live.speak(8000); // past 20 s: the opening question has had its time; offer 10 is held for what they said
    expect(live.view()).toMatchObject({ offer: { id: 0 }, status: "listening" });
    await live.pause(1800); // a read that heard them goes out, and answers at once: offer 11
    expect(live.deps.ask).toHaveBeenCalledTimes(2);
    expect(live.view()).toMatchObject({ offer: { id: 0 }, status: "ready" });
    const from = live.views().length;
    for (let i = 0; i < 8; i++) {
      await live.speak(6000);
      live.say(MORE);
      await live.pause(1800);
    }
    // Over this minute, no read holds it back; only one every RENEW_AFTER_MS renews it (so it isn't
    // about what they said long ago); and nothing changed on screen.
    expect(live.deps.ask).toHaveBeenCalledTimes(2 + Math.floor((8 * 7800) / RENEW_AFTER_MS));
    expect(live.view()).toMatchObject({ offer: { id: 0 }, status: "ready" });
    expect(live.views().length).toBe(from);
    await live.pause(1000); // a pause long enough: the latest renewal shows
    expect(live.view()).toMatchObject({ offer: { id: next - 1 }, status: "listening" });
  });

  it("keeps saying one is ready when a turn's final text has fewer words than its draft", async () => {
    const confirming = deferred<CoachResponse>();
    const live = setup();
    live.deps.ask.mockResolvedValueOnce(ok(QUESTION_1)).mockReturnValueOnce(confirming.promise);
    await live.record();
    await live.pause(500);
    await live.speak(3000);
    const turn = live.draft(FIRST_ANSWER);
    await live.pause(2500); // the read waits for the turn's final text a while, then goes without it
    expect(live.deps.ask).toHaveBeenCalledOnce();
    await live.speak(16_000); // past 20 s, still talking
    live.say("Ya.");
    await live.pause(2400); // a read that heard them goes, once the turn's text has had its while
    expect(live.deps.ask).toHaveBeenCalledTimes(2);
    await live.speak(500);
    confirming.resolve(ok(QUESTION_2));
    await live.speak(TICK_MS);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "ready" });
    live.finish(turn, "Busy week lah."); // now too few words for the question to have had its time
    await live.speak(1000);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "ready" });
  });

  // Read 1 finds nothing; they talk on past the opening question's time; read 2, at the pause,
  // answers when the test says. Returns when read 2 was asked for.
  async function slowSecondRead(live: ReturnType<typeof setup>, second: Promise<CoachResponse>) {
    let askedAt = 0;
    live.deps.ask.mockResolvedValueOnce(ok(null)).mockImplementationOnce(() => {
      askedAt = Date.now();
      return second;
    });
    await firstRead(live);
    await live.speak(8000);
    live.say(MORE);
    await live.speak(8000);
    await live.pause(1500);
    expect(live.deps.ask).toHaveBeenCalledTimes(2);
    return askedAt;
  }

  it("says it is checking only once a read has been out a second, when nothing waits", async () => {
    const second = deferred<CoachResponse>();
    const live = setup();
    const askedAt = await slowSecondRead(live, second.promise);
    await advance(askedAt + CHECKING_AFTER_MS - TICK_MS - Date.now());
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "listening" });
    await advance(TICK_MS);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "checking" });
    // It found nothing worth asking: back to listening, once the line has said checking a second.
    second.resolve(ok(null));
    await advance(TICK_MS);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "checking" });
    await advance(MIN_BUSY_MS - TICK_MS);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "listening" });
  });

  it("never says it is checking for a read that answers quickly", async () => {
    const live = setup({ ask: vi.fn(() => new Promise<CoachResponse>((resolve) => setTimeout(() => resolve(ok(null)), 300))) });
    await firstRead(live);
    for (let i = 0; i < 3; i++) {
      await live.speak(8000);
      live.say(MORE);
      await live.pause(4000);
    }
    expect(live.deps.ask).toHaveBeenCalledTimes(4);
    expect(live.statuses()).not.toContain("checking");
    expect(live.view()).toMatchObject({ mode: "live", status: "listening" });
  });

  it("says no more are coming under a closing line, even while a read is out", async () => {
    const later = deferred<CoachResponse>();
    const live = setup();
    live.deps.ask.mockResolvedValueOnce(ok(COVERED)).mockReturnValueOnce(later.promise);
    await firstRead(live);
    await live.pause(2000);
    expect(live.view()).toMatchObject({ mode: "live", offer: COVERED, status: "no_more" });
    expect(firstWith(live, COVERED.id)).toMatchObject({ status: "no_more" });
    await live.speak(3000);
    live.say(MORE);
    await live.pause(1600);
    expect(live.deps.ask).toHaveBeenCalledTimes(2);
    await live.pause(5000);
    expect(live.view()).toMatchObject({ mode: "live", offer: COVERED, status: "no_more" });
  });

  it("keeps listening while a closing line waits, even with a slow read out", async () => {
    const confirming = deferred<CoachResponse>();
    const live = setup();
    // As the server sends it: no question can follow a closing line. That holds once it shows.
    live.deps.ask.mockResolvedValueOnce(lastOne(COVERED)).mockReturnValueOnce(confirming.promise);
    await firstRead(live); // COVERED waits: too early for it
    await live.speak(8000);
    live.say(MORE);
    await live.speak(8000);
    await live.pause(1500); // the read to confirm it goes, and doesn't answer
    expect(live.deps.ask).toHaveBeenCalledTimes(2);
    await live.pause(5000);
    expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "listening" });
    expect(live.statuses()).not.toContain("checking");
  });

  // The coach says when no more can follow (moreToAsk): the most follow-ups shown, time nearly up,
  // two skips in a row, distress, or a closing line shown.
  describe("once the coach says none can follow", () => {
    it("says so with the last follow-up, and never that it is checking for a read that can only bring a closing line", async () => {
      const read = deferred<CoachResponse>();
      const live = setup();
      live.deps.ask.mockResolvedValueOnce(lastOne(QUESTION_1)).mockReturnValueOnce(read.promise);
      await firstRead(live);
      await live.pause(2000);
      expect(live.view()).toMatchObject({ mode: "live", offer: QUESTION_1, status: "no_more" });
      expect(firstWith(live, QUESTION_1.id)).toMatchObject({ status: "no_more" });
      const from = live.views().length;
      // QUESTION_1 has its time, and a read goes out at their pause, and takes a while.
      await live.speak(5000);
      live.say(MORE);
      await live.speak(4000);
      await live.pause(1500);
      expect(live.deps.ask).toHaveBeenCalledTimes(2);
      await live.pause(3000);
      expect(live.view()).toMatchObject({ mode: "live", offer: QUESTION_1, status: "no_more" });
      read.resolve(lastOne(COVERED));
      await live.pause(4000);
      expect(live.view()).toMatchObject({ mode: "live", offer: COVERED, status: "no_more" });
      expect(since(live, from)).toEqual([[COVERED.id, "no_more"]]);
    });

    it("keeps saying none come after it while Different question swaps the last follow-up", async () => {
      const swap = deferred<CoachResponse>();
      const live = setup();
      live.deps.ask.mockResolvedValueOnce(lastOne(QUESTION_1)).mockReturnValueOnce(swap.promise);
      await firstRead(live);
      await live.pause(2000);
      expect(live.view()).toMatchObject({ offer: QUESTION_1, status: "no_more" });
      const from = live.views().length;
      act(() => live.coach.skip());
      await advance(3000); // a slow swap
      expect(live.view()).toMatchObject({ offer: QUESTION_1, status: "no_more" });
      swap.resolve(lastOne(QUESTION_2));
      await advance(0);
      expect(since(live, from)).toEqual([[QUESTION_2.id, "no_more"]]);
    });

    it("says more may come again when it says so", async () => {
      const live = setup();
      live.deps.ask.mockResolvedValueOnce(lastOne(null)).mockResolvedValueOnce(ok(null));
      await firstRead(live);
      await advance(TICK_MS);
      expect(live.view()).toMatchObject({ offer: { id: 0 }, status: "no_more" });
      await live.speak(3000);
      live.say(MORE);
      await live.pause(6000);
      expect(live.view()).toMatchObject({ offer: { id: 0 }, status: "listening" });
    });

    // What may still come is said for an offer only once it shows: one dropped before then says nothing.
    it("keeps listening once a last question that waited is dropped before it shows", async () => {
      const second = deferred<CoachResponse>();
      const live = setup();
      live.deps.ask.mockResolvedValueOnce(ok(null)).mockReturnValueOnce(second.promise);
      await firstRead(live);
      await live.speak(16_000);
      live.say(MORE);
      await live.pause(1600);
      expect(live.deps.ask).toHaveBeenCalledTimes(2);
      await live.speak(1500);
      second.resolve(lastOne(TEAM_QUESTION));
      await live.pause(10_000); // what they said after its read never comes back as text: it goes
      expect(live.offersShown()).not.toContain(TEAM_QUESTION.id);
      expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "listening" });
      expect(live.statuses()).not.toContain("no_more");
    });

    it("takes a server that doesn't say as more may come", async () => {
      const live = setup();
      live.deps.ask.mockResolvedValueOnce({ ...lastOne(QUESTION_1), more: undefined });
      await firstRead(live);
      await live.pause(2000);
      expect(live.view()).toMatchObject({ offer: QUESTION_1, status: "listening" });
    });
  });

  // No new questions after 40 s here. The start answers at once, so the time is surely over 2 s
  // later (LIMIT_SLACK_MS): the server may have started the session as late as the start answered.
  describe("once the time for new questions is over", () => {
    const LIMIT_MS = 40_000;
    const timed = (limitMs = LIMIT_MS) => setup({ start: vi.fn(async () => ({ ...READY, pacing: { ...PACING, noNewQuestionsAfterMs: limitMs } })) });
    // They talk on until `until` on the clock, a word coming back as text every few seconds.
    async function talkOn(live: ReturnType<typeof setup>, until: number) {
      while (Date.now() < until) {
        await live.speak(Math.min(5000, until - Date.now()));
        live.say("Ya.");
      }
    }

    it("says no more are coming once it is surely over, and never that it is checking for a read after it", async () => {
      const late = deferred<CoachResponse>();
      const live = timed();
      live.deps.ask.mockResolvedValueOnce(ok(QUESTION_1)).mockResolvedValueOnce(ok(null)).mockReturnValueOnce(late.promise);
      const startedAt = Date.now();
      await firstRead(live);
      await live.pause(2000);
      expect(live.view()).toMatchObject({ offer: QUESTION_1, status: "listening" });
      await live.speak(5000);
      live.say(MORE);
      await live.pause(1500); // a read, which finds nothing
      await talkOn(live, startedAt + LIMIT_MS - 100);
      expect(live.view()).toMatchObject({ offer: QUESTION_1, status: "listening" });
      await live.speak(LIMIT_SLACK_MS); // past the time by the recorder's clock, not surely past it on the server
      expect(live.view()).toMatchObject({ offer: QUESTION_1, status: "listening" });
      await live.speak(TICK_MS);
      expect(live.view()).toMatchObject({ offer: QUESTION_1, status: "no_more" });
      const from = live.views().length;
      live.say(MORE);
      await live.pause(1500); // a read goes out, and takes a while: it can only bring "Time is nearly up"
      expect(live.deps.ask).toHaveBeenCalledTimes(3);
      await live.pause(1500);
      expect(live.view()).toMatchObject({ offer: QUESTION_1, status: "no_more" });
      late.resolve(lastOne(LATE));
      await live.pause(1000);
      expect(live.view()).toMatchObject({ offer: LATE, status: "no_more" });
      expect(since(live, from)).toEqual([[LATE.id, "no_more"]]);
    });

    it("says none can come once the time is surely over, with a held question waiting, as its read again can only bring the closing line", async () => {
      const confirming = deferred<CoachResponse>();
      const live = timed();
      live.deps.ask.mockResolvedValueOnce(ok(QUESTION_1)).mockReturnValueOnce(confirming.promise);
      const startedAt = Date.now();
      await firstRead(live); // QUESTION_1 waits
      await live.speak(8000); // they talk on: it waits for a read that has heard them
      live.say(MORE);
      const from = live.views().length;
      await talkOn(live, startedAt + LIMIT_MS - 100); // past the opening question's time, still talking
      expect(live.view()).toMatchObject({ offer: { id: 0 }, status: "listening" });
      await live.speak(TICK_MS);
      expect(live.view()).toMatchObject({ offer: { id: 0 }, status: "listening" });
      await live.speak(LIMIT_SLACK_MS);
      expect(live.view()).toMatchObject({ offer: { id: 0 }, status: "no_more" });
      await live.pause(1500); // the read to confirm it goes
      expect(live.deps.ask).toHaveBeenCalledTimes(2);
      await live.pause(1500);
      expect(live.view()).toMatchObject({ offer: { id: 0 }, status: "no_more" });
      confirming.resolve(lastOne(LATE));
      await live.pause(1000);
      expect(live.view()).toMatchObject({ offer: LATE, status: "no_more" });
      expect(live.offersShown()).not.toContain(QUESTION_1.id);
      expect(live.statuses()).not.toContain("checking");
      expect(since(live, from).map(([, status]) => status)).not.toContain("ready");
    });

    // The server measures the time from when it started the session, which it did before the start
    // answered: a slow start (a cold server) moves it later, so the recorder measures from its answer.
    it("measures it from when the start answered, not from when the recording started", async () => {
      const start = deferred<LiveReady>();
      const live = setup({ start: vi.fn(() => start.promise) });
      const startedAt = Date.now();
      await live.record();
      await live.pause(500);
      await live.speak(2500);
      start.resolve({ ...READY, pacing: { ...PACING, noNewQuestionsAfterMs: LIMIT_MS } });
      await advance(0);
      const answeredAt = Date.now();
      expect(answeredAt - startedAt).toBe(3000);
      await talkOn(live, startedAt + LIMIT_MS + LIMIT_SLACK_MS + TICK_MS);
      expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "listening" });
      await talkOn(live, answeredAt + LIMIT_MS + LIMIT_SLACK_MS - TICK_MS);
      expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "listening" });
      await talkOn(live, answeredAt + LIMIT_MS + LIMIT_SLACK_MS + TICK_MS);
      expect(live.view()).toMatchObject({ mode: "live", offer: { id: 0 }, status: "no_more" });
    });

    // A question already on its way waits for nothing they said since: it still shows past the time.
    it("still shows a question already on its way, past the time, and says none can come only once it has", async () => {
      const live = timed(6000);
      live.deps.ask.mockResolvedValueOnce(ok(QUESTION_1));
      await firstRead(live); // just before the time, a read brings a question, which waits: too early for a follow-up
      await live.pause(1000); // past the time, by the recorder's clock
      expect(live.view()).toMatchObject({ offer: { id: 0 }, status: "listening" });
      await live.pause(1000); // they have clearly stopped: it shows
      expect(live.view()).toMatchObject({ offer: QUESTION_1, status: "listening" });
      await live.pause(LIMIT_SLACK_MS);
      expect(live.view()).toMatchObject({ offer: QUESTION_1, status: "no_more" });
    });
  });

  describe("with Different question", () => {
    // QUESTION_1 on screen; then they talk a little.
    async function onFollowUp(live: ReturnType<typeof setup>) {
      await firstRead(live);
      await live.pause(2000);
      expect(live.view()).toMatchObject({ offer: QUESTION_1, status: "listening" });
    }

    it("doesn't say it is checking for a quick one", async () => {
      const live = setup();
      live.deps.ask.mockResolvedValueOnce(ok(QUESTION_1)).mockResolvedValueOnce(ok(QUESTION_2));
      await onFollowUp(live);
      await live.speak(500);
      const before = live.views().length;
      act(() => live.coach.skip());
      await advance(TICK_MS * 4);
      expect(live.view()).toMatchObject({ offer: QUESTION_2, status: "listening" });
      expect(live.statuses().slice(before)).toEqual(["listening"]);
    });

    it("says it is checking from a second after the tap until the new question shows", async () => {
      const swap = deferred<CoachResponse>();
      const live = setup();
      live.deps.ask.mockResolvedValueOnce(ok(QUESTION_1)).mockReturnValueOnce(swap.promise);
      await onFollowUp(live);
      await live.speak(500);
      act(() => live.coach.skip());
      await advance(CHECKING_AFTER_MS - 100);
      expect(live.view()).toMatchObject({ offer: QUESTION_1, status: "listening" });
      await advance(TICK_MS + 100);
      expect(live.view()).toMatchObject({ offer: QUESTION_1, status: "checking" });
      swap.resolve(ok(QUESTION_2));
      await advance(0);
      expect(live.view()).toMatchObject({ offer: QUESTION_2, status: "listening" });
      expect(firstWith(live, QUESTION_2.id)).toMatchObject({ status: "listening" });
    });

    it("times it from the first tap, and doesn't hold it over the new question, when tapped twice", async () => {
      const swap = deferred<CoachResponse>();
      const live = setup();
      live.deps.ask.mockResolvedValueOnce(ok(QUESTION_1)).mockReturnValueOnce(swap.promise);
      await onFollowUp(live);
      await live.speak(500);
      const from = live.views().length;
      act(() => live.coach.skip());
      await advance(200);
      act(() => live.coach.skip()); // nothing seems to happen yet, so they tap again
      await advance(CHECKING_AFTER_MS + TICK_MS - 200 - 50);
      expect(live.view()).toMatchObject({ offer: QUESTION_1, status: "checking" });
      await advance(1500 - CHECKING_AFTER_MS - TICK_MS + 50);
      swap.resolve(ok(QUESTION_2));
      await advance(0);
      expect(live.deps.ask).toHaveBeenCalledTimes(2); // one swap, not two
      expect(firstWith(live, QUESTION_2.id)).toMatchObject({ status: "listening" });
      await advance(MIN_BUSY_MS + TICK_MS);
      expect(since(live, from)).toEqual([
        [QUESTION_1.id, "checking"],
        [QUESTION_2.id, "listening"],
      ]);
    });

    it("times it from the tap, not from a read already out", async () => {
      const read = deferred<CoachResponse>();
      const live = setup();
      live.deps.ask.mockResolvedValueOnce(ok(QUESTION_1)).mockReturnValueOnce(read.promise).mockResolvedValueOnce(ok(TEAM_QUESTION));
      await onFollowUp(live);
      await live.speak(3000);
      live.say(MORE);
      await live.pause(1500); // a read goes out, and doesn't answer
      expect(live.deps.ask).toHaveBeenCalledTimes(2);
      await live.speak(500);
      expect(live.view()).toMatchObject({ offer: QUESTION_1, status: "listening" });
      act(() => live.coach.skip()); // waits for the read already out
      await advance(CHECKING_AFTER_MS - 100);
      expect(live.view()).toMatchObject({ offer: QUESTION_1, status: "listening" });
      await advance(TICK_MS + 100);
      // QUESTION_1 still hasn't had its time, so the slow read alone wouldn't say so: the tap does.
      expect(live.view()).toMatchObject({ offer: QUESTION_1, status: "checking" });
      read.resolve(ok(QUESTION_2)); // superseded by the skip: never shown
      await advance(MIN_ASK_GAP_MS + TICK_MS);
      expect(live.view()).toMatchObject({ offer: TEAM_QUESTION, status: "listening" });
      expect(live.offersShown()).not.toContain(QUESTION_2.id);
    });

    it("says it is checking at once when tapped while a follow-up was ready", async () => {
      const swap = deferred<CoachResponse>();
      const live = setup({ start: vi.fn(async () => ({ ...READY, pacing: { ...PACING, showAfterSilenceMs: 2500 } })) });
      live.deps.ask.mockResolvedValueOnce(ok(QUESTION_1)).mockResolvedValueOnce(ok(QUESTION_2)).mockReturnValueOnce(swap.promise);
      await onFollowUp(live);
      await live.speak(9000); // QUESTION_1 has had its time
      live.say(MORE);
      await live.pause(2000); // QUESTION_2 waits for a pause of 2.5 s
      expect(live.view()).toMatchObject({ offer: QUESTION_1, status: "ready" });
      const before = live.views().length;
      act(() => live.coach.skip());
      await advance(3000);
      expect(live.deps.ask.mock.calls[2][0]).toMatchObject({ skip: QUESTION_1.id });
      swap.resolve(ok(TEAM_QUESTION));
      await advance(0);
      expect(live.view()).toMatchObject({ offer: TEAM_QUESTION, status: "listening" });
      // The one that was ready went with the tap; never back to "Listening…" before the new question.
      expect(since(live, before)).toEqual([
        [QUESTION_1.id, "checking"],
        [TEAM_QUESTION.id, "listening"],
      ]);
      expect(live.offersShown()).not.toContain(QUESTION_2.id);
    });
  });

  it("says no more are coming once every read is used", async () => {
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
    expect(live.view()).toMatchObject({ mode: "live", status: "listening" }); // the last read is out
    await live.speak(1500);
    live.say(TEAM_OK);
    last.resolve(ok(QUESTION_2));
    await live.pause(2000);
    expect(live.view()).toMatchObject({ mode: "live", offer: QUESTION_2, status: "no_more" });
    // Different question still swaps it, and the line keeps saying none come after it meanwhile.
    const swap = deferred<CoachResponse>();
    live.deps.ask.mockReturnValueOnce(swap.promise);
    const before = live.views().length;
    act(() => live.coach.skip());
    await advance(3000);
    expect(live.view()).toMatchObject({ offer: QUESTION_2, status: "no_more" });
    swap.resolve(ok(TEAM_QUESTION));
    await advance(0);
    expect(since(live, before)).toEqual([[TEAM_QUESTION.id, "no_more"]]);
  });

  it("doesn't publish again while nothing changes", async () => {
    const live = setup();
    await firstRead(live);
    await advance(TICK_MS);
    expect(live.view()).toMatchObject({ mode: "live", status: "listening" });
    const count = live.views().length;
    await live.pause(10_000);
    expect(live.views()).toHaveLength(count);
  });

  describe("once follow-ups have stopped", () => {
    it.each([
      ["the start is refused", { start: vi.fn(async () => ({ status: "off" }) as const) }, async () => {}],
      ["live transcription doesn't connect in time", { connect: vi.fn(() => new Promise<never>(() => {})) }, () => advance(CONNECT_TIMEOUT_MS)],
      [
        "the browser can't measure the microphone's level before it connects",
        { connect: vi.fn(() => new Promise<never>(() => {})), meter: vi.fn(() => () => {}) },
        () => advance(METER_WAIT_MS),
      ],
    ] as const)("says whether live coaching had got going: not when %s", async (_label, overrides, wait) => {
      const live = setup(overrides);
      await live.record();
      await wait();
      expect(live.view()).toEqual({ mode: "fallback", offer: openingOffer(OPENING), started: false });
    });

    it("says it had got going when the connection is lost", async () => {
      const live = setup();
      await live.record();
      live.lose();
      expect(live.view()).toEqual({ mode: "fallback", offer: openingOffer(OPENING), started: true });
    });

    it("says it had got going when coach calls keep failing", async () => {
      const live = setup({ ask: vi.fn(async () => null) });
      await firstRead(live);
      await live.speak(3000);
      live.say(MORE);
      await live.pause(6000);
      expect(live.view()).toEqual({ mode: "fallback", offer: openingOffer(OPENING), started: true });
    });
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
