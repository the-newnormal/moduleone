import { describe, expect, it, vi } from "vitest";
import { countWords } from "@/lib/grader/prompt";
import { TEST_RUBRIC as R } from "./fixtures";
import { initialState, type CoachState } from "./policy";
import { coachTurn, FIRST_READ_WORDS, NEW_READ_WORDS, type TurnRead } from "./turn";
import { CoachError, type CoachRead } from "./types";

// One coach call, with Claude's read replaced by a fake: when it reads, what it does with the read,
// and what it does when the read fails.

const SPEECH = (
  "This week I mostly settled the vendor onboarding for the Jurong site then helped with the budget deck for Finance " +
  "and on Wednesday I took the client call and walked them through the timeline step by step and the team was quite happy lah"
).split(" ");
// The first n words they have said.
const say = (n: number) => Array.from({ length: n }, (_, i) => SPEECH[i % SPEECH.length]).join(" ");

function readOf(overrides: Partial<CoachRead> = {}): CoachRead {
  return {
    coverage: {},
    tone: "neutral",
    wrappingUp: false,
    instructionsInTranscript: false,
    target: null,
    quote: "",
    question: "",
    ...overrides,
  };
}

function reader(read: CoachRead = readOf(), latencyMs = 150) {
  return vi.fn(
    async (alreadyAsked: string[]): Promise<TurnRead> => ({
      read,
      model: "claude-haiku-5-5",
      usage: { inputTokens: 900, outputTokens: 120, asked: alreadyAsked.length },
      latencyMs,
    }),
  );
}

function turn(input: Partial<Parameters<typeof coachTurn<TurnRead>>[0]> & { read: (alreadyAsked: string[]) => Promise<TurnRead> }) {
  return coachTurn({ state: initialState(), rubric: R, transcript: "", elapsedS: 60, shown: null, skip: null, ...input });
}

const stateWith = (changes: Partial<CoachState>): CoachState => ({ ...initialState(), ...changes });

describe("coachTurn", () => {
  it("has test transcripts of the sizes it says", () => {
    for (const n of [FIRST_READ_WORDS - 1, FIRST_READ_WORDS, FIRST_READ_WORDS + NEW_READ_WORDS, 40]) expect(countWords(say(n))).toBe(n);
  });

  it("doesn't read until there are enough words, and still decides from what is known", async () => {
    const read = reader(readOf({ coverage: { activity_work: "clear" } }));
    const result = await turn({ transcript: say(FIRST_READ_WORDS - 1), read });
    expect(read).not.toHaveBeenCalled();
    expect(result).toMatchObject({ result: null, failure: null });
    expect(result.state).toMatchObject({ wordsRead: 0, counts: { reads: 0, failures: 0 } });
    expect(result.offer).toMatchObject({ kind: "question", topic: "activity_work", source: "bank" });
    expect(result.touched).toEqual({ activity: false, excellence: false, morale: false });
  });

  it("reads once there are enough words, and decides from the read", async () => {
    const read = reader(readOf({ coverage: { activity_work: "clear", morale_feeling: "brief" } }), 180);
    const result = await turn({ transcript: say(FIRST_READ_WORDS), read });
    expect(read).toHaveBeenCalledExactlyOnceWith([]);
    expect(result.result).toBe(await read.mock.results[0].value);
    expect(result.failure).toBeNull();
    expect(result.state.coverage).toEqual({ activity_work: "clear", morale_feeling: "brief" });
    expect(result.state.wordsRead).toBe(FIRST_READ_WORDS);
    expect(result.state.counts).toMatchObject({ reads: 1, failures: 0, latencyMs: 180, slowestMs: 180 });
    expect(result.touched).toEqual({ activity: true, excellence: false, morale: true });
    // The area they haven't touched comes first.
    expect(result.offer).toMatchObject({ kind: "question", topic: "excellence_moment" });
  });

  it("reads again only once enough new words have come in", async () => {
    const first = await turn({ transcript: say(FIRST_READ_WORDS), read: reader(readOf({ coverage: { activity_work: "brief" } }), 100) });
    const read = reader(readOf({ coverage: { activity_work: "clear" } }), 300);

    const quiet = await turn({ state: first.state, transcript: say(FIRST_READ_WORDS + NEW_READ_WORDS - 1), read });
    expect(read).not.toHaveBeenCalled();
    expect(quiet.result).toBeNull();
    expect(quiet.state.wordsRead).toBe(FIRST_READ_WORDS);

    const next = await turn({ state: quiet.state, transcript: say(FIRST_READ_WORDS + NEW_READ_WORDS), read });
    expect(read).toHaveBeenCalledOnce();
    expect(next.state.coverage.activity_work).toBe("clear");
    expect(next.state.wordsRead).toBe(FIRST_READ_WORDS + NEW_READ_WORDS);
    expect(next.state.counts).toMatchObject({ reads: 2, latencyMs: 400, slowestMs: 300 });
  });

  it("tells the read which topics have been asked or skipped", async () => {
    const read = reader();
    await turn({ state: stateWith({ asked: ["excellence_moment"], skipped: ["activity_work"] }), transcript: say(FIRST_READ_WORDS), read });
    expect(read).toHaveBeenCalledExactlyOnceWith(["excellence_moment", "activity_work"]);
  });

  it("notes what is on screen before reading and deciding", async () => {
    const first = await turn({ transcript: say(5), read: reader() });
    expect(first.offer).toMatchObject({ topic: "activity_work" });
    const read = reader();
    const next = await turn({ state: first.state, transcript: say(FIRST_READ_WORDS), shown: first.offer!.id, read });
    expect(read).toHaveBeenCalledExactlyOnceWith(["activity_work"]);
    expect(next.state).toMatchObject({ current: first.offer!.id, asked: ["activity_work"], followUps: 1 });
    expect(next.offer).toMatchObject({ kind: "question", topic: "excellence_moment" });
  });

  it("answers a skip with a new question at once, without reading", async () => {
    const first = await turn({ transcript: say(FIRST_READ_WORDS), read: reader() });
    const id = first.offer!.id;
    const read = reader(readOf({ coverage: { excellence_moment: "clear" } }));
    const skipped = await turn({ state: first.state, transcript: say(40), shown: id, skip: id, read });
    expect(read).not.toHaveBeenCalled();
    expect(skipped.result).toBeNull();
    expect(skipped.state).toMatchObject({ skipped: ["activity_work"], asked: [], followUps: 0, wordsRead: FIRST_READ_WORDS });
    expect(skipped.offer).toMatchObject({ kind: "question", topic: "excellence_moment" });
  });

  it("ignores a skip of an offer that isn't on screen", async () => {
    const first = await turn({ transcript: say(FIRST_READ_WORDS), read: reader() });
    const read = reader();
    const next = await turn({ state: first.state, transcript: say(40), skip: first.offer!.id, read });
    expect(read).toHaveBeenCalledOnce();
    expect(next.state.skipped).toEqual([]);
  });

  it("carries on from what is known when the read fails, and reads again next time", async () => {
    const state = stateWith({ coverage: { activity_work: "clear" } });
    const failure = new CoachError("No reply from the Anthropic API within 6 s", { reason: "api", retryable: true });
    const failing = vi.fn(async (): Promise<TurnRead> => {
      throw failure;
    });
    const result = await turn({ state, transcript: say(FIRST_READ_WORDS), read: failing });
    expect(result.failure).toBe(failure);
    expect(result.result).toBeNull();
    expect(result.state).toMatchObject({ wordsRead: 0, counts: { reads: 0, failures: 1 } });
    expect(result.offer).toMatchObject({ kind: "question", topic: "excellence_moment" });

    const read = reader();
    const again = await turn({ state: result.state, transcript: say(FIRST_READ_WORDS), read });
    expect(read).toHaveBeenCalledOnce();
    expect(again.state.counts).toMatchObject({ reads: 1, failures: 1 });
  });

  it("lets any other error through", async () => {
    const broken = vi.fn(async (): Promise<TurnRead> => {
      throw new TypeError("read is not a function");
    });
    await expect(turn({ transcript: say(FIRST_READ_WORDS), read: broken })).rejects.toThrow(TypeError);
  });

  it.each<["covered" | "late" | "closing"]>([["covered"], ["late"], ["closing"]])("stops reading after the %s line", async (line) => {
    const read = reader(readOf({ coverage: { activity_work: "clear" } }));
    const result = await turn({ state: stateWith({ linesShown: [line] }), transcript: say(40), read });
    expect(read).not.toHaveBeenCalled();
    expect(result).toMatchObject({ offer: null, result: null, failure: null });
  });

  it("keeps reading after the Before you finish question", async () => {
    const read = reader();
    await turn({ state: stateWith({ linesShown: ["beforeYouFinish"] }), transcript: say(40), read });
    expect(read).toHaveBeenCalledOnce();
  });

  it("stops reading after distress, and closes", async () => {
    const read = reader();
    const result = await turn({ state: stateWith({ tone: "distress" }), transcript: say(40), read });
    expect(read).not.toHaveBeenCalled();
    expect(result.offer).toMatchObject({ kind: "closing", text: R.lines.closing });
  });

  it("closes at once when the read finds distress", async () => {
    const result = await turn({ transcript: say(FIRST_READ_WORDS), read: reader(readOf({ tone: "distress" })) });
    expect(result.state.tone).toBe("distress");
    expect(result.offer).toMatchObject({ kind: "closing", topic: null });
  });
});
