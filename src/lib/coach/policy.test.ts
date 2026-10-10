import { describe, expect, it } from "vitest";
import { TEST_RUBRIC as R, TEST_SETTINGS as S } from "./fixtures";
import {
  acknowledge,
  candidates,
  floor,
  initialState,
  mergeRead,
  nextOffer,
  OPENING_OFFER_ID,
  parseState,
  skip,
  touched,
  validateQuestion,
  type CoachState,
  type Decision,
  type OfferRecord,
} from "./policy";
import { coachRubric } from "./rubric";
import { AREAS, LEVELS, type Area, type CoachRead, type CoachRubric, type Level, type Tone, type Topic } from "./types";

// The policy decides what the live check-in asks, from Claude's reads. Exact scores are checked
// against TEST_RUBRIC (fixtures.ts: today's topics and settings, frozen), so retuning
// rubrics/coach.md never breaks these tests; the real file is used where only the behaviour
// matters, and for the anti-nagging simulation, which must hold for any rubric that parses.

const REAL = coachRubric();

const ask = (id: string, rubric: CoachRubric = R) => rubric.topics.find((t) => t.id === id)!.ask;
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

function read(overrides: Partial<CoachRead> = {}): CoachRead {
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

function stateWith(changes: Partial<CoachState> = {}): CoachState {
  return { ...initialState(), ...changes };
}

function rubricWith(settings: Partial<CoachRubric["settings"]>, topics: Topic[] = R.topics): CoachRubric {
  return { ...R, topics, settings: { ...S, ...settings } };
}

const ALL_CLEAR: Record<string, Level> = Object.fromEntries(R.topics.map((t) => [t.id, "clear"]));
const KEYS_CLEAR: Record<string, Level> = { activity_work: "clear", excellence_moment: "clear", morale_feeling: "clear" };

function decide(
  state: CoachState,
  input: { rubric?: CoachRubric; elapsedS?: number; read?: CoachRead | null; transcript?: string } = {},
): Decision {
  return nextOffer(state, { rubric: R, elapsedS: 60, read: null, transcript: "", ...input });
}

// The browser puts the offer on screen and says so on its next call.
function show(decision: Decision, rubric: CoachRubric = R): CoachState {
  if (!decision.offer) throw new Error("There is no offer to show");
  return acknowledge(decision.state, decision.offer.id, rubric);
}

// Adds an offer by hand, for the cases nextOffer wouldn't make on its own.
function withOffer(state: CoachState, record: Omit<OfferRecord, "id">): [CoachState, number] {
  const id = state.nextOfferId;
  return [{ ...state, offers: [...state.offers, { id, ...record }], nextOfferId: id + 1 }, id];
}

const question = (topic: string | null, more: Partial<Omit<OfferRecord, "id" | "kind" | "topic">> = {}): Omit<OfferRecord, "id"> => ({
  kind: "question",
  topic,
  source: "bank",
  beforeYouFinish: false,
  rejected: false,
  ...more,
});
const lineOf = (kind: "covered" | "late" | "closing"): Omit<OfferRecord, "id"> => ({
  kind,
  topic: null,
  source: "line",
  beforeYouFinish: false,
  rejected: false,
});

// Candidates as [id, score], scores rounded so sums like 0.4 + 0.2 compare exactly.
function ranking(state: CoachState, elapsedS = 60, rubric: CoachRubric = R): [string, number][] {
  return candidates(state, rubric, elapsedS).map((c) => [c.topic.id, Math.round(c.score * 1000) / 1000]);
}
const rankedIds = (state: CoachState, elapsedS = 60, rubric: CoachRubric = R) => ranking(state, elapsedS, rubric).map(([id]) => id);

function without<T extends object>(value: T, key: keyof T): Partial<T> {
  const copy: Partial<T> = { ...value };
  delete copy[key];
  return copy;
}

describe("initialState and parseState", () => {
  it("starts with the opening question on screen and nothing counted", () => {
    const state = initialState();
    expect(state.v).toBe(1);
    expect(state.current).toBe(OPENING_OFFER_ID);
    expect(state.offers).toEqual([
      { id: OPENING_OFFER_ID, kind: "question", topic: null, source: "line", beforeYouFinish: false, rejected: false },
    ]);
    expect(state.nextOfferId).toBe(OPENING_OFFER_ID + 1);
    expect(state).toMatchObject({ coverage: {}, tone: "neutral", asked: [], skipped: [], followUps: 0, perArea: {}, skipsInARow: 0 });
    expect(state.linesShown).toEqual([]);
    expect(state.flow).toEqual([]);
    expect(state.counts).toEqual({ reads: 0, failures: 0, tailored: 0, bank: 0, rejected: 0, latencyMs: 0, slowestMs: 0 });
  });

  it("gives a new state each time", () => {
    const first = initialState();
    first.asked.push("activity_work");
    first.counts.reads = 3;
    expect(initialState().asked).toEqual([]);
    expect(initialState().counts.reads).toBe(0);
  });

  it("reads back a lived-in state as the database stores it", () => {
    const first = decide(initialState());
    let state = show(first);
    state = mergeRead(state, read({ coverage: { activity_work: "clear", morale_feeling: "brief" }, tone: "hard_week" }), R);
    state = decide(state).state;
    const stored = JSON.parse(JSON.stringify(state));
    expect(parseState(stored)).toEqual(state);
  });

  it.each<[string, unknown]>([
    ["nothing", undefined],
    ["null", null],
    ["a string", "state"],
    ["a number", 1],
    ["an array", []],
    ["an empty object", {}],
    ["an older version", { ...initialState(), v: 0 }],
    ["a newer version", { ...initialState(), v: 2 }],
    ["a state missing a field (an older shape)", without(initialState(), "flow")],
    ["counts missing a field", { ...initialState(), counts: without(initialState().counts, "slowestMs") }],
    ["an unknown level", { ...initialState(), coverage: { activity_work: "partly" } }],
    ["an unknown mood", { ...initialState(), tone: "sian" }],
    ["a negative count", { ...initialState(), followUps: -1 }],
    ["a fractional count", { ...initialState(), followUps: 1.5 }],
    ["an unknown area in the flow", { ...initialState(), flow: ["finance"] }],
    ["an unknown line", { ...initialState(), linesShown: ["goodbye"] }],
    [
      "an offer of an unknown kind",
      { ...initialState(), offers: [{ id: 0, kind: "poll", topic: null, source: "line", beforeYouFinish: false, rejected: false }] },
    ],
    // Before offers said whether Claude's wording had been turned down, when the counts still kept
    // reads that flagged instructions: such a session starts over.
    [
      "a state from before offers kept whether Claude's wording was turned down",
      {
        ...initialState(),
        offers: [{ id: 0, kind: "question", topic: null, source: "line", beforeYouFinish: false }],
        counts: { ...initialState().counts, instructions: 1 },
      },
    ],
    ["a next offer id of 0", { ...initialState(), nextOfferId: 0 }],
  ])("starts over from %s", (_label, stored) => {
    expect(parseState(stored)).toEqual(initialState());
  });

  it("never reads back a count of reads that flagged instructions", () => {
    const parsed = parseState({ ...initialState(), counts: { ...initialState().counts, instructions: 2 } });
    expect(parsed).toEqual(initialState());
    expect(parsed.counts).not.toHaveProperty("instructions");
  });
});

describe("mergeRead", () => {
  it.each<[Level, Level, Level]>([
    ["none", "none", "none"],
    ["none", "brief", "brief"],
    ["none", "clear", "clear"],
    ["none", "declined", "declined"],
    ["brief", "none", "brief"],
    ["brief", "clear", "clear"],
    ["clear", "none", "clear"],
    ["clear", "brief", "clear"],
    ["clear", "declined", "declined"],
    ["declined", "none", "declined"],
    ["declined", "brief", "declined"],
    ["declined", "clear", "declined"],
  ])("keeps the higher level: %s, then a read of %s, gives %s", (before, now, after) => {
    const state = stateWith({ coverage: before === "none" ? {} : { activity_work: before } });
    const merged = mergeRead(state, read({ coverage: { activity_work: now } }), R);
    expect(merged.coverage.activity_work ?? "none").toBe(after);
  });

  it.each<[Tone, Tone, Tone]>([
    ["neutral", "neutral", "neutral"],
    ["neutral", "hard_week", "hard_week"],
    ["neutral", "distress", "distress"],
    ["hard_week", "neutral", "hard_week"],
    ["hard_week", "distress", "distress"],
    ["distress", "neutral", "distress"],
    ["distress", "hard_week", "distress"],
  ])("only lets the mood get heavier: %s, then a read of %s, gives %s", (before, now, after) => {
    expect(mergeRead(stateWith({ tone: before }), read({ tone: now }), R).tone).toBe(after);
  });

  it("lists the areas whose coverage rose in this read, in area order", () => {
    const state = stateWith({ coverage: { activity_work: "clear" }, flow: ["activity"] });
    const merged = mergeRead(
      state,
      read({ coverage: { morale_feeling: "brief", activity_work: "clear", excellence_moment: "brief", activity_outcome: "none" } }),
      R,
    );
    expect(merged.flow).toEqual(["excellence", "morale"]);
    // A read that adds nothing means they have moved off what they were talking about.
    expect(mergeRead(merged, read({ coverage: { activity_work: "brief" } }), R).flow).toEqual([]);
  });

  it("ignores topics the rubric doesn't have, and treats a missing topic as none", () => {
    const merged = mergeRead(initialState(), read({ coverage: { finance_budget: "clear", morale_feeling: "brief" } }), R);
    expect(merged.coverage).toEqual({ morale_feeling: "brief" });
  });

  // Whether a member's words seemed to give the app instructions is used in the call (no tailored
  // wording) and never kept.
  it("keeps nothing of a read that flagged instructions in the transcript", () => {
    const flagged = mergeRead(initialState(), read({ instructionsInTranscript: true, coverage: { activity_work: "brief" } }), R);
    expect(flagged).toEqual(mergeRead(initialState(), read({ coverage: { activity_work: "brief" } }), R));
    expect(flagged.counts).not.toHaveProperty("instructions");
    expect(JSON.stringify(flagged)).not.toMatch(/instruction/i);
  });

  it("leaves the state it was given alone", () => {
    const state = stateWith({ coverage: { activity_work: "brief" } });
    const before = structuredClone(state);
    mergeRead(state, read({ coverage: { activity_work: "clear", morale_feeling: "clear" }, tone: "hard_week" }), R);
    expect(state).toEqual(before);
  });
});

describe("touched", () => {
  it("marks an area touched once its key topic has come up at all", () => {
    const state = stateWith({ coverage: { activity_work: "brief", excellence_impact: "clear", morale_feeling: "declined" } });
    expect(touched(state, R)).toEqual({ activity: true, excellence: false, morale: true });
    expect(touched(initialState(), R)).toEqual({ activity: false, excellence: false, morale: false });
  });
});

describe("acknowledge", () => {
  it("counts a question as asked the first time it is shown", () => {
    const first = decide(initialState());
    expect(first.offer).toMatchObject({ kind: "question", topic: "activity_work", source: "bank" });
    const state = show(first);
    expect(state).toMatchObject({
      current: first.offer!.id,
      asked: ["activity_work"],
      followUps: 1,
      perArea: { activity: 1 },
      counts: { bank: 1, tailored: 0 },
    });
  });

  it("counts Claude's wording as tailored", () => {
    const [state, id] = withOffer(initialState(), question("activity_work", { source: "tailored" }));
    expect(acknowledge(state, id, R).counts).toMatchObject({ tailored: 1, bank: 0, rejected: 0 });
  });

  it("counts the rubric's question shown in place of Claude's turned-down wording as bank and rejected, once", () => {
    const [state, id] = withOffer(initialState(), question("activity_work", { rejected: true }));
    const shown = acknowledge(state, id, R);
    expect(shown.counts).toMatchObject({ tailored: 0, bank: 1, rejected: 1 });
    expect(acknowledge(shown, id, R)).toBe(shown);
  });

  it("changes nothing when the offer on screen is reported again", () => {
    const first = decide(initialState());
    const state = show(first);
    expect(acknowledge(state, first.offer!.id, R)).toBe(state);
  });

  it("ignores an id it never offered", () => {
    const state = decide(initialState()).state;
    expect(acknowledge(state, 99, R)).toBe(state);
  });

  it("counts a topic once, even if an older offer about it comes back on screen", () => {
    const [first, older] = withOffer(initialState(), question("activity_work"));
    const [both, newer] = withOffer(first, question("activity_work", { source: "tailored" }));
    let state = acknowledge(both, newer, R);
    state = acknowledge(state, older, R);
    expect(state).toMatchObject({ current: older, asked: ["activity_work"], followUps: 1, perArea: { activity: 1 } });
    expect(state.counts).toMatchObject({ tailored: 1, bank: 0 });
  });

  it("moves to an offer about a topic the rubric no longer has without counting it", () => {
    const [state, id] = withOffer(initialState(), question("old_topic"));
    const shown = acknowledge(state, id, R);
    expect(shown.current).toBe(id);
    expect(shown).toMatchObject({ asked: [], followUps: 0, perArea: {} });
  });

  it("records a closing line once", () => {
    const [one, first] = withOffer(initialState(), lineOf("covered"));
    const [both, second] = withOffer(one, lineOf("covered"));
    let state = acknowledge(both, first, R);
    expect(state.linesShown).toEqual(["covered"]);
    state = acknowledge(state, second, R);
    expect(state.linesShown).toEqual(["covered"]);
    expect(state.followUps).toBe(0);
  });

  it("records the Before you finish question as a question and as the line", () => {
    const [state, id] = withOffer(initialState(), question("morale_feeling", { beforeYouFinish: true }));
    expect(acknowledge(state, id, R)).toMatchObject({ asked: ["morale_feeling"], followUps: 1, linesShown: ["beforeYouFinish"] });
  });

  it("counts nothing when the opening question is back on screen", () => {
    const first = decide(initialState());
    const state = show(first);
    const back = acknowledge(state, OPENING_OFFER_ID, R);
    expect(back.current).toBe(OPENING_OFFER_ID);
    expect(back).toMatchObject({ asked: ["activity_work"], followUps: 1 });
  });
});

describe("skip", () => {
  function onScreen() {
    const first = decide(initialState());
    return { state: show(first), id: first.offer!.id };
  }

  it("moves the topic from asked to skipped, and doesn't count it as a follow-up", () => {
    const { state, id } = onScreen();
    expect(skip(state, id)).toMatchObject({ asked: [], skipped: ["activity_work"], followUps: 0, skipsInARow: 1, current: id });
  });

  it("never offers a skipped topic again, even once it is only brief", () => {
    const { state, id } = onScreen();
    let skipped = skip(state, id);
    expect(decide(skipped).offer).toMatchObject({ kind: "question", topic: "excellence_moment" });
    skipped = mergeRead(skipped, read({ coverage: { activity_work: "brief", excellence_moment: "clear", morale_feeling: "clear" } }), R);
    expect(rankedIds(skipped)).not.toContain("activity_work");
    expect(decide(skipped).offer?.topic).not.toBe("activity_work");
  });

  it.each<[string, (state: CoachState, id: number) => [CoachState, number]]>([
    ["an offer that isn't on screen", (state) => withOffer(state, question("morale_feeling"))],
    ["the opening question", (state) => [acknowledge(state, OPENING_OFFER_ID, R), OPENING_OFFER_ID]],
    ["a closing line", (state) => {
      const [next, line] = withOffer(state, lineOf("covered"));
      return [acknowledge(next, line, R), line];
    }],
    ["an id it never offered", (state) => [state, 42]],
    ["a topic already skipped", (state, id) => [skip(state, id), id]],
  ])("ignores a skip of %s", (_label, setUp) => {
    const { state, id } = onScreen();
    const [before, target] = setUp(state, id);
    expect(skip(before, target)).toBe(before);
  });

  it("ends the questions after two skips in a row", () => {
    const first = decide(initialState());
    let state = skip(show(first), first.offer!.id);
    // The replacement comes at once and is shown straight away; they skip that too.
    const second = decide(state);
    expect(second.offer).toMatchObject({ kind: "question", topic: "excellence_moment" });
    state = show(second);
    expect(state.skipsInARow).toBe(1);
    state = skip(state, second.offer!.id);
    expect(state).toMatchObject({ skipsInARow: 2, skipped: ["activity_work", "excellence_moment"], followUps: 0 });
    expect(decide(state).offer).toMatchObject({ kind: "covered", text: R.lines.covered });
  });

  it("starts the count again once they answer a question rather than skip it", () => {
    const first = decide(initialState());
    let state = skip(show(first), first.offer!.id);
    const second = decide(state);
    state = show(second);
    // They answer it, and the next question goes up.
    state = mergeRead(state, read({ coverage: { excellence_moment: "clear" } }), R);
    const third = decide(state);
    expect(third.offer).toMatchObject({ kind: "question", topic: "morale_feeling" });
    state = show(third);
    expect(state.skipsInARow).toBe(0);
    state = skip(state, third.offer!.id);
    expect(state.skipsInARow).toBe(1);
    expect(decide(state).offer).toMatchObject({ kind: "question", topic: "excellence_impact" });
  });
});

describe("candidates", () => {
  it("starts with each area's key topic, with the untouched-area bonus, activity first", () => {
    expect(ranking(initialState())).toEqual([
      ["activity_work", 1.5],
      ["excellence_moment", 1.5],
      ["morale_feeling", 1.5],
    ]);
  });

  it("puts an untouched area's key topic ahead of depth on the area they are talking about", () => {
    const state = stateWith({ coverage: { activity_work: "brief" }, flow: ["activity"] });
    expect(ranking(state)).toEqual([
      ["excellence_moment", 1.5],
      ["morale_feeling", 1.5],
      // 0.8 + the flow bonus; a brief key topic needs 0.6 of its weight, and its area is touched.
      ["activity_outcome", 1],
      ["activity_work", 0.8],
      ["activity_more", 0.6],
    ]);
  });

  it.each<[Level, string[]]>([
    ["none", []],
    ["brief", ["excellence_impact", "excellence_strength"]],
    ["clear", ["excellence_impact", "excellence_strength"]],
    ["declined", []],
  ])("with excellence_moment %s, offers the topics that need it: %j", (level, expected) => {
    const state = stateWith({ coverage: level === "none" ? {} : { excellence_moment: level }, asked: ["excellence_moment"] });
    const needing = rankedIds(state).filter((id) => id === "excellence_impact" || id === "excellence_strength");
    expect(needing).toEqual(expected);
  });

  it("never follows up a topic whose brief answer is enough, but does one whose isn't", () => {
    const state = stateWith({
      coverage: { ...KEYS_CLEAR, morale_reason: "brief", morale_team: "brief", activity_outcome: "brief" },
    });
    const ranked = ranking(state);
    expect(ranked.map(([id]) => id)).not.toContain("morale_reason");
    expect(ranked.map(([id]) => id)).not.toContain("morale_team");
    expect(ranked).toContainEqual(["activity_outcome", 0.48]);
    expect(rankedIds(stateWith({ coverage: KEYS_CLEAR }))).toContain("morale_reason");
  });

  it("leaves out topics that are clear, declined, asked or skipped", () => {
    const state = stateWith({
      coverage: { activity_work: "clear", activity_outcome: "declined", excellence_moment: "brief", morale_feeling: "brief" },
      asked: ["excellence_impact"],
      skipped: ["morale_feeling"],
    });
    expect(rankedIds(state)).toEqual(["excellence_moment", "morale_reason", "activity_more", "excellence_strength", "morale_team"]);
  });

  it("stops at the most follow-ups per area", () => {
    const state = stateWith({ coverage: { activity_work: "clear" }, perArea: { activity: S.maxPerArea } });
    expect(rankedIds(state)).toEqual(["excellence_moment", "morale_feeling"]);
    expect(rankedIds(stateWith({ coverage: { activity_work: "clear" }, perArea: { activity: S.maxPerArea - 1 } }))).toContain(
      "activity_outcome",
    );
  });

  it("stops at the most follow-up questions", () => {
    expect(ranking(stateWith({ followUps: S.maxFollowUps }))).toEqual([]);
    expect(ranking(stateWith({ followUps: S.maxFollowUps - 1 }))).toHaveLength(3);
  });

  it("asks only key topics late in the recording", () => {
    const state = stateWith({ coverage: { activity_work: "clear" } });
    expect(rankedIds(state, S.keysOnlyAfterS - 1)).toContain("activity_outcome");
    expect(rankedIds(state, S.keysOnlyAfterS)).toEqual(["excellence_moment", "morale_feeling"]);
  });

  it("asks nothing new near the end", () => {
    expect(ranking(initialState(), S.noNewQuestionsAfterS - 0.1)).toHaveLength(3);
    expect(ranking(initialState(), S.noNewQuestionsAfterS)).toEqual([]);
  });

  const side = (id: string, area: Area, weight: number): Topic => ({ ...R.topics[1], id, label: id, area, weight, key: false, needs: null });

  it("breaks a tie by putting key topics first", () => {
    // Activity's extra topic scores 1.5, like the key topics with their bonus.
    const rubric = rubricWith({}, [...R.topics, side("activity_side", "activity", 1.5)]);
    expect(ranking(initialState(), 60, rubric)).toEqual([
      ["activity_work", 1.5],
      ["excellence_moment", 1.5],
      ["morale_feeling", 1.5],
      ["activity_side", 1.5],
    ]);
  });

  it("treats scores equal on paper as equal, so the tie goes to the key topic", () => {
    // excellence_strength: 0.4 and the flow bonus of 0.2, which floating point makes a hair over 0.6;
    // morale_feeling: a key topic only touched on, so 1.0 × 0.6. Equal on paper.
    expect(0.4 + 0.2).not.toBe(0.6);
    const state = stateWith({
      coverage: {
        activity_work: "clear",
        activity_outcome: "clear",
        activity_more: "clear",
        excellence_moment: "clear",
        excellence_impact: "clear",
        morale_feeling: "brief",
      },
      flow: ["excellence"],
    });
    // Exact scores, not rounded by the test.
    expect(candidates(state, R, 60).map((c) => [c.topic.id, c.score])).toEqual([
      ["morale_feeling", 0.6],
      ["excellence_strength", 0.6],
      ["morale_reason", 0.5],
      ["morale_team", 0.4],
    ]);
    expect(decide(state).offer).toMatchObject({ kind: "question", topic: "morale_feeling", source: "bank" });
  });

  it("then by area order, then by the file's order", () => {
    const rubric = rubricWith({}, [
      ...R.topics,
      side("excellence_side", "excellence", 0.5),
      side("activity_side_b", "activity", 0.5),
      side("activity_side_a", "activity", 0.5),
    ]);
    expect(ranking(stateWith({ coverage: ALL_CLEAR }), 60, rubric)).toEqual([
      ["activity_side_b", 0.5],
      ["activity_side_a", 0.5],
      ["excellence_side", 0.5],
    ]);
  });
});

describe("floor", () => {
  it.each<[string, Partial<CoachState>, number]>([
    ["at the start", {}, S.minScore],
    ["with some key topics still to come", { coverage: { activity_work: "clear", excellence_moment: "brief" } }, S.minScore],
    ["once every key topic is clear", { coverage: KEYS_CLEAR }, S.minScoreAfterKeys],
    [
      "once every key topic is clear, declined, asked or skipped",
      { coverage: { activity_work: "declined" }, asked: ["excellence_moment"], skipped: ["morale_feeling"] },
      S.minScoreAfterKeys,
    ],
    ["in a hard week", { tone: "hard_week" }, S.minScoreHardWeek],
    ["in a hard week, every key topic done", { tone: "hard_week", coverage: KEYS_CLEAR }, S.minScoreHardWeek],
  ])("is the right least score %s", (_label, changes, expected) => {
    expect(floor(stateWith(changes), R)).toBe(expected);
  });

  it("never falls in a hard week, whatever the settings", () => {
    const rubric = rubricWith({ minScore: 0.45, minScoreAfterKeys: 0.6, minScoreHardWeek: 0.5 });
    expect(floor(stateWith({ tone: "hard_week" }), rubric)).toBe(0.5);
    expect(floor(stateWith({ tone: "hard_week", coverage: KEYS_CLEAR }), rubric)).toBe(0.6);
  });

  it("lets through a score equal to it on paper", () => {
    // excellence_impact: 0.7 and a flow bonus of 0.1, which floating point makes a hair under 0.8.
    expect(0.7 + 0.1).toBeLessThan(0.8);
    const rubric = rubricWith({ flowBonus: 0.1, minScoreAfterKeys: 0.8 });
    const state = stateWith({ coverage: { ...ALL_CLEAR, excellence_impact: "none" }, flow: ["excellence"] });
    expect(floor(state, rubric)).toBe(0.8);
    expect(candidates(state, rubric, 60).map((c) => [c.topic.id, c.score])).toEqual([["excellence_impact", 0.8]]);
    expect(decide(state, { rubric }).offer).toMatchObject({ kind: "question", topic: "excellence_impact" });
    // A floor any higher still turns it away.
    expect(decide(state, { rubric: rubricWith({ flowBonus: 0.1, minScoreAfterKeys: 0.800001 }) }).offer).toMatchObject({
      kind: "covered",
    });
  });
});

describe("nextOffer", () => {
  it("asks the best topic in the rubric's own words", () => {
    const decision = decide(initialState());
    expect(decision.offer).toEqual({ id: 1, kind: "question", topic: "activity_work", source: "bank", text: ask("activity_work") });
    expect(decision.state.nextOfferId).toBe(2);
    expect(decision.state.offers.at(-1)).toEqual({
      id: 1,
      kind: "question",
      topic: "activity_work",
      source: "bank",
      beforeYouFinish: false,
      rejected: false,
    });
  });

  it("uses the hard-week wording in a hard week, where the topic has one", () => {
    // Every key topic clear, activity in flow: activity_outcome (1.0) clears the hard-week floor.
    const state = stateWith({ tone: "hard_week", coverage: KEYS_CLEAR, flow: ["activity"] });
    expect(decide(state).offer).toMatchObject({ topic: "activity_outcome", text: R.topics[1].askHardWeek });
    // excellence_impact has none, so its usual question is used.
    const noVariant = stateWith({
      tone: "hard_week",
      coverage: { ...KEYS_CLEAR, activity_outcome: "clear", activity_more: "clear" },
      flow: ["excellence"],
    });
    expect(decide(noVariant).offer).toMatchObject({ topic: "excellence_impact", text: ask("excellence_impact") });
  });

  it("asks fewer questions in a hard week", () => {
    // activity_more scores 0.6: enough in an ordinary week, not in a hard one.
    const coverage = { ...ALL_CLEAR, activity_more: "none" as const };
    expect(decide(stateWith({ coverage, flow: ["activity"] })).offer).toMatchObject({ kind: "question", topic: "activity_more" });
    expect(decide(stateWith({ coverage, flow: ["activity"], tone: "hard_week" })).offer).toMatchObject({ kind: "covered" });
  });

  it("shows the covered line when nothing is left worth asking", () => {
    expect(decide(stateWith({ coverage: ALL_CLEAR })).offer).toMatchObject({ kind: "covered", topic: null, source: "line", text: R.lines.covered });
  });

  it("shows the covered line once the follow-ups are used up", () => {
    expect(decide(stateWith({ followUps: S.maxFollowUps })).offer).toMatchObject({ kind: "covered" });
  });

  it("shows the late line near the end, then nothing", () => {
    const late = decide(initialState(), { elapsedS: S.noNewQuestionsAfterS });
    expect(late.offer).toMatchObject({ kind: "late", text: R.lines.late });
    expect(decide(show(late), { elapsedS: S.noNewQuestionsAfterS + 30 }).offer).toBeNull();
    expect(decide(initialState(), { elapsedS: S.noNewQuestionsAfterS - 1 }).offer).toMatchObject({ kind: "question" });
  });

  it("after distress, shows the closing line once and then nothing", () => {
    const state = mergeRead(initialState(), read({ tone: "distress", coverage: { activity_work: "brief" } }), R);
    const closing = decide(state);
    expect(closing.offer).toMatchObject({ kind: "closing", topic: null, text: R.lines.closing });
    const after = show(closing);
    expect(after.linesShown).toEqual(["closing"]);
    expect(decide(after).offer).toBeNull();
    expect(decide(mergeRead(after, read({ wrappingUp: true, tone: "neutral" }), R), { read: read({ wrappingUp: true }) }).offer).toBeNull();
  });

  it("after distress, closes even when the covered line was already shown", () => {
    const covered = decide(stateWith({ coverage: ALL_CLEAR }));
    const state = mergeRead(show(covered), read({ tone: "distress" }), R);
    expect(decide(state).offer).toMatchObject({ kind: "closing" });
  });

  it.each<["covered" | "late" | "closing"]>([["covered"], ["late"], ["closing"]])("offers nothing more after the %s line", (kind) => {
    const [state, id] = withOffer(initialState(), lineOf(kind));
    const shown = acknowledge(state, id, R);
    expect(decide(shown).offer).toBeNull();
    // Not even when they wrap up with an area untouched, or Claude suggests a question.
    const wrapping = read({ wrappingUp: true, target: "excellence_moment", question: "Where did you use your superpower this week?" });
    expect(decide(mergeRead(shown, wrapping, R), { read: wrapping }).offer).toBeNull();
  });

  it("keeps the offer on screen and the few latest, and numbers each new one", () => {
    let state = initialState();
    for (let i = 0; i < 6; i++) state = decide(state).state;
    expect(state.offers.map((o) => o.id)).toEqual([OPENING_OFFER_ID, 4, 5, 6]);
    expect(state.nextOfferId).toBe(7);
  });
});

describe("nextOffer with Claude's wording", () => {
  // Every key topic clear and all three areas in flow: activity_outcome is best (1.0),
  // excellence_impact is within the slack (0.9), the rest are below it.
  const base = stateWith({ coverage: KEYS_CLEAR, flow: ["activity", "excellence", "morale"] });
  const TRANSCRIPT =
    "Settled the vendor onboarding for the Jurong site lah. On Wednesday I took the client call and walked them through the timeline.";
  const OUTCOME = "You mentioned the vendor onboarding: where did that get to?";
  const IMPACT = "What difference did the client call make for the team?";
  const tailoredBy = (overrides: Partial<CoachRead>, state = base, rubric = R) => {
    const r = read(overrides);
    return decide(state, { read: r, transcript: TRANSCRIPT, rubric });
  };

  it("starts from this ranking", () => {
    expect(ranking(base)).toEqual([
      ["activity_outcome", 1],
      ["excellence_impact", 0.9],
      ["morale_reason", 0.7],
      ["activity_more", 0.6],
      ["excellence_strength", 0.6],
      ["morale_team", 0.6],
    ]);
  });

  it("uses it for the best topic", () => {
    const decision = tailoredBy({ target: "activity_outcome", question: OUTCOME, quote: "vendor onboarding" });
    expect(decision.offer).toMatchObject({ kind: "question", topic: "activity_outcome", source: "tailored", text: OUTCOME });
    expect(acknowledge(decision.state, decision.offer!.id, R).counts).toMatchObject({ tailored: 1, bank: 0 });
  });

  it("uses it for a topic scoring within the slack of the best", () => {
    expect(tailoredBy({ target: "excellence_impact", question: IMPACT, quote: "the client call" }).offer).toMatchObject({
      topic: "excellence_impact",
      source: "tailored",
      text: IMPACT,
    });
  });

  it("uses it for a topic exactly the slack below the best, on paper", () => {
    // excellence_impact: 0.7 and the flow bonus of 0.2, a hair under 0.9 in floating point; the best
    // scores 1.0, and the slack is 0.1.
    expect(0.7 + 0.2).toBeLessThan(0.9);
    const impact = { target: "excellence_impact", question: IMPACT, quote: "the client call" };
    expect(tailoredBy(impact, base, rubricWith({ tailorSlack: 0.1 })).offer).toMatchObject({
      topic: "excellence_impact",
      source: "tailored",
    });
    // A slack any smaller leaves it out.
    expect(tailoredBy(impact, base, rubricWith({ tailorSlack: 0.099999 })).offer).toMatchObject({
      topic: "activity_outcome",
      source: "bank",
    });
  });

  it("trims it", () => {
    expect(tailoredBy({ target: "activity_outcome", question: `  ${OUTCOME}  `, quote: "vendor onboarding" }).offer?.text).toBe(OUTCOME);
  });

  it.each<[string, Partial<CoachRead>]>([
    ["a topic scoring too far below the best", { target: "excellence_strength", question: "What strength of yours did the client call draw on?" }],
    ["a topic that is already clear", { target: "activity_work", question: "What else did the vendor onboarding involve this week?" }],
    ["no topic", { target: null, question: OUTCOME }],
    ["no question", { target: "activity_outcome", question: "" }],
    ["a transcript that tried to give instructions", { target: "activity_outcome", question: OUTCOME, instructionsInTranscript: true }],
  ])("asks the best topic in the rubric's words for %s, not counting it as turned down", (_label, overrides) => {
    const decision = tailoredBy(overrides);
    expect(decision.offer).toMatchObject({ topic: "activity_outcome", source: "bank", text: ask("activity_outcome") });
    expect(decision.state.offers.at(-1)).toMatchObject({ id: decision.offer!.id, rejected: false });
    expect(show(decision).counts).toMatchObject({ tailored: 0, bank: 1, rejected: 0 });
  });

  it.each<[string, Partial<CoachRead>]>([
    ["breaks the question style", { target: "activity_outcome", question: "Why did the vendor onboarding take so long?" }],
    ["quotes words they never said", { target: "activity_outcome", question: OUTCOME, quote: "vendor onboarding at Tuas" }],
    ["is too long", { target: "activity_outcome", question: `Where did ${"the vendor onboarding and ".repeat(5)}the deck get to?` }],
    ["says they mentioned something without quoting it", { target: "activity_outcome", question: OUTCOME, quote: "" }],
    ["gives a quote it doesn't use", { target: "activity_outcome", question: "Where did the Jurong site work get to?", quote: "vendor onboarding" }],
    ["puts words they never said in quotes", { target: "activity_outcome", question: "Where did \u201cthe Tuas warehouse\u201d get to?" }],
  ])("turns down wording that %s, and counts it once the rubric's question is shown", (_label, overrides) => {
    const decision = tailoredBy(overrides);
    expect(decision.offer).toMatchObject({ topic: "activity_outcome", source: "bank", text: ask("activity_outcome") });
    expect(decision.state.offers.at(-1)).toMatchObject({ id: decision.offer!.id, source: "bank", rejected: true });
    // Not yet: only what reaches the screen is counted, like tailored and bank.
    expect(decision.state.counts.rejected).toBe(0);
    expect(show(decision).counts).toMatchObject({ tailored: 0, bank: 1, rejected: 1 });
  });

  it("never counts turned-down wording whose question doesn't reach the screen", () => {
    const turnedDown = tailoredBy({ target: "activity_outcome", question: "Why did the vendor onboarding take so long?" });
    // A newer call replaces it before the browser shows it, and again; neither counts the first.
    const again = tailoredBy({ target: "activity_outcome", question: "Why did the deck take so long?" }, turnedDown.state);
    const next = decide(again.state, { transcript: TRANSCRIPT });
    expect(next.offer).toMatchObject({ topic: "activity_outcome", source: "bank" });
    expect(next.state.counts.rejected).toBe(0);
    const state = show(next);
    expect(state.counts).toMatchObject({ bank: 1, rejected: 0 });
    // Nor when it comes back on screen after its topic was asked.
    expect(acknowledge(state, turnedDown.offer!.id, R).counts).toMatchObject({ bank: 1, rejected: 0 });
  });

  it("never uses it for a topic that doesn't allow it", () => {
    // morale_reason is the best topic here, and its wording is never Claude's.
    const state = stateWith({ coverage: { ...ALL_CLEAR, morale_reason: "none", morale_team: "none" }, flow: ["morale"] });
    const decision = tailoredBy({ target: "morale_reason", question: "What's behind how you feel about the team this week?" }, state);
    expect(decision.offer).toMatchObject({ topic: "morale_reason", source: "bank", text: ask("morale_reason") });
    expect(show(decision).counts).toMatchObject({ bank: 1, rejected: 0 });
  });

  it("never uses it for morale with the real rubric", () => {
    expect(REAL.topics.filter((t) => t.area === "morale").every((t) => !t.tailor)).toBe(true);
    for (const target of REAL.topics.filter((t) => t.area === "morale").map((t) => t.id)) {
      const state = stateWith({ coverage: { activity_work: "clear", excellence_moment: "clear" } });
      const r = read({ target, question: "How are you finding the team this week?" });
      const decision = nextOffer(state, { rubric: REAL, elapsedS: 60, read: r, transcript: TRANSCRIPT });
      expect(decision.offer?.source).not.toBe("tailored");
    }
  });

  it("takes the slack from the rubric", () => {
    const strict = rubricWith({ tailorSlack: 0 });
    expect(tailoredBy({ target: "excellence_impact", question: IMPACT }, base, strict).offer).toMatchObject({
      topic: "activity_outcome",
      source: "bank",
    });
  });
});

describe("nextOffer as they wrap up", () => {
  const wrapping = (state: CoachState, rubric: CoachRubric = R) => decide(state, { read: read({ wrappingUp: true }), rubric });

  it("asks once about an area that hasn't come up, starting \"Before you finish\"", () => {
    const decision = wrapping(stateWith({ coverage: { activity_work: "clear" } }));
    expect(decision.offer).toEqual({
      id: 1,
      kind: "question",
      topic: "excellence_moment",
      source: "bank",
      text: "Before you finish, where did you or your team get to use your superpower this week?",
    });
    expect(decision.state.offers.at(-1)?.beforeYouFinish).toBe(true);
  });

  it("passes over an area that has come up, even briefly", () => {
    expect(wrapping(stateWith({ coverage: { activity_work: "clear", excellence_moment: "brief" } })).offer).toMatchObject({
      topic: "morale_feeling",
      text: "Before you finish, how are you feeling about the team at the moment?",
    });
  });

  it("uses the hard-week wording, lower-cased", () => {
    expect(wrapping(stateWith({ tone: "hard_week", coverage: { activity_work: "clear" } })).offer?.text).toBe(
      "Before you finish, in the middle of all that, what did you or your team do that made a difference?",
    );
  });

  it("does it only once", () => {
    let state = show(wrapping(stateWith({ coverage: { activity_work: "clear" } })));
    expect(state.linesShown).toEqual(["beforeYouFinish"]);
    state = mergeRead(state, read({ coverage: { excellence_moment: "clear" } }), R);
    const again = wrapping(state);
    expect(again.offer).toMatchObject({ kind: "question", topic: "morale_feeling", text: ask("morale_feeling") });
  });

  it("asks nothing extra once every area has come up", () => {
    const state = stateWith({ coverage: KEYS_CLEAR, flow: ["activity"] });
    expect(wrapping(state).offer).toMatchObject({ topic: "activity_outcome", text: ask("activity_outcome") });
  });

  it("doesn't ask about an area whose key topic was skipped", () => {
    const state = stateWith({ coverage: { activity_work: "clear", morale_feeling: "clear" }, skipped: ["excellence_moment"] });
    expect(wrapping(state).offer?.text.startsWith(R.lines.beforeYouFinish)).toBe(false);
  });

  it("asks nothing once the follow-ups are used up", () => {
    const state = stateWith({ coverage: { activity_work: "clear" }, followUps: S.maxFollowUps });
    expect(wrapping(state).offer).toMatchObject({ kind: "covered" });
  });

  it("builds the line from the real file's words", () => {
    const decision = wrapping(stateWith({ coverage: { activity_work: "clear", excellence_moment: "clear" } }), REAL);
    const key = REAL.topics.find((t) => t.area === "morale" && t.key)!;
    expect(decision.offer?.text).toBe(`${REAL.lines.beforeYouFinish} ${lowerFirst(key.ask)}`);
  });
});

describe("validateQuestion", () => {
  const TRANSCRIPT = "Settled the vendor onboarding for the Jurong site, lah. Then the Q3 budget deck for Finance, sent Friday.";
  const MAX = S.maxQuestionChars;
  const long = `Where did ${"the vendor onboarding and ".repeat(5)}the budget deck get to?`;

  it("has test questions of the right sizes", () => {
    expect(long.length).toBeGreaterThan(MAX);
    expect(long.split(" ").length).toBeLessThanOrEqual(30);
  });

  it.each<[string, string, string, string | null]>([
    ["a plain question", "Where did the vendor onboarding get to by Friday?", "", null],
    ["a question quoting their words", "You mentioned the vendor onboarding: where did that get to?", "vendor onboarding", null],
    [
      "a quote in another case, with other punctuation",
      "You mentioned the vendor onboarding for the Jurong site: where did that get to?",
      "Vendor onboarding, for the JURONG site!",
      null,
    ],
    ["a question with spaces around it", "  Where did the budget deck for Finance end up?  ", "", null],
    ["a quote that is only punctuation", "Where did the budget deck for Finance end up?", "...", null],
    ["an apostrophe", "What's left to do on the vendor onboarding?", "", null],
    ["a curly apostrophe", "What\u2019s left on the budget deck for Finance?", "", null],
    ["a question asking what they say, not claiming they said it", "What did you say to Finance about the budget deck?", "", null],
    ["their words in double quotes", 'Where did "the vendor onboarding" get to by Friday?', "", null],
    ["their words in curly quotes, in another case", "Where did \u201cthe Q3 Budget Deck\u201d end up?", "", null],
    ["the quote, also in double quotes", 'You mentioned "the vendor onboarding": where did that get to?', "the vendor onboarding", null],

    ["a question under twelve characters", "Which one?", "", "too_short"],
    ["a question over the longest allowed", long, "", "too_long"],
    ["a question of over thirty words", `${"so ".repeat(30)}what?`, "", "too_many_words"],
    ["a question on two lines", "Where did the vendor onboarding\nget to by Friday?", "", "several_lines"],
    ["a statement", "Tell me where the vendor onboarding got to.", "", "not_one_question"],
    ["two questions", "Where did the deck go? Who signed it off?", "", "not_one_question"],
    ["a question mark in the middle", "What? Where did the vendor onboarding get to?", "", "not_one_question"],

    ["a rating", "How would you rate the vendor onboarding?", "", "blocked_grading"],
    ["a score", "What score would you give your week?", "", "blocked_grading"],
    ["marks out of five", "Out of 5, how did the budget deck go?", "", "blocked_grading"],
    ["HQ", "What would you like HQ to know about the tender?", "", "blocked_audience"],
    ["who reads it", "What do you think your boss will make of the deck?", "", "blocked_audience"],
    ["praise", "What made the vendor onboarding such a great success?", "", "blocked_praise"],
    ["fishing for positives", "What are you proud of from the vendor onboarding?", "", "blocked_praise"],
    ["\"why\"", "Why did the deployment slip to Friday?", "", "blocked_pressure"],
    ["asking them to elaborate", "Can you elaborate on the vendor onboarding?", "", "blocked_pressure"],
    ["\"only\"", "Was the deck the only thing you did this week?", "", "blocked_pressure"],
    ["\"should\"", "What do you think you should change on the deck?", "", "blocked_pressure"],
    ["family", "How is your family coping with the long hours?", "", "blocked_personal"],
    ["health", "How is your health holding up with the deadlines?", "", "blocked_personal"],
    ["a link", "Did you share the deck at www.example.com with the client?", "", "blocked_links"],
    ["an email address", "Did you send the deck to meiling@example.sg on Friday?", "", "blocked_links"],

    ["a quote they never said", "You mentioned the Tuas site: where did that get to?", "the Tuas site", "quote_not_said"],
    ["a quote cut out of a word", "You mentioned the onboarding: where did that get to?", "endor onboarding", "quote_not_said"],
    ["a quote the question doesn't use", "Where did the Jurong site work get to?", "vendor onboarding", "quote_not_in_question"],
    ["a quote only partly in the question", "You mentioned the onboarding: where did that get to?", "vendor onboarding", "quote_not_in_question"],
    ["\"you said\" without a quote", "You said the deck went out Friday: who picked it up?", "", "claims_without_quote"],
    ["\"you mentioned\" without a quote", "You mentioned the vendor onboarding: where did that get to?", "", "claims_without_quote"],
    ["\"you told\" without a quote", "What came of the deck you told Finance about?", "", "claims_without_quote"],
    ["\"you called\" without a quote, in capitals", "What came of what YOU CALLED the Jurong site?", "", "claims_without_quote"],
    ["words in double quotes they never said", 'Where did "the Tuas warehouse" get to?', "", "quote_not_said"],
    ["words in curly quotes they never said", "Where did \u201cthe Tuas warehouse\u201d get to?", "", "quote_not_said"],
    ["words in double quotes cut out of a word", 'Where did "endor onboarding" get to?', "", "quote_not_said"],
    [
      "a true quote, with other words in double quotes they never said",
      'You mentioned the vendor onboarding: did "the Tuas team" pitch in?',
      "vendor onboarding",
      "quote_not_said",
    ],
    [
      "a quote of over eight words",
      "You mentioned the onboarding: where did that get to?",
      "settled the vendor onboarding for the Jurong site lah",
      "quote_too_long",
    ],
  ])("%s gives %s", (_label, text, quote, expected) => {
    expect(validateQuestion(text, quote, TRANSCRIPT, MAX)).toBe(expected);
  });
});

describe("a whole check-in", () => {
  it("asks each thing once, keeps to the limits and ends with the covered line", () => {
    // They start on their work, get one general example in when asked, say how they feel, and
    // answer the tailored follow-up; the coach then has nothing left worth asking.
    const transcript = "Settled the vendor onboarding for the Jurong site. Wednesday the client call, I walked them through it.";
    const asked: (string | null)[] = [];
    let state = initialState();

    let r = read({ coverage: { activity_work: "clear", activity_outcome: "brief" } });
    let decision = decide(mergeRead(state, r, R), { read: r, elapsedS: 30, transcript });
    asked.push(decision.offer!.topic);
    state = show(decision);

    r = read({ coverage: { activity_work: "clear", excellence_moment: "brief" } });
    decision = decide(mergeRead(state, r, R), { read: r, elapsedS: 60, transcript });
    asked.push(decision.offer!.topic);
    state = show(decision);

    r = read({ coverage: { morale_feeling: "clear" }, target: "excellence_impact", question: "What difference did the client call make?", quote: "the client call" });
    decision = decide(mergeRead(state, r, R), { read: r, elapsedS: 90, transcript });
    expect(decision.offer).toMatchObject({ topic: "excellence_impact", source: "tailored" });
    asked.push(decision.offer!.topic);
    state = show(decision);

    r = read({ coverage: { excellence_impact: "clear" } });
    decision = decide(mergeRead(state, r, R), { read: r, elapsedS: 120, transcript });
    expect(decision.offer).toMatchObject({ kind: "covered" });
    state = show(decision);

    expect(asked).toEqual(["excellence_moment", "morale_feeling", "excellence_impact"]);
    expect(state).toMatchObject({ followUps: 3, perArea: { excellence: 2, morale: 1 }, linesShown: ["covered"] });
    expect(state.counts).toMatchObject({ bank: 2, tailored: 1 });
    r = read({ coverage: { activity_more: "brief" }, wrappingUp: true });
    expect(decide(mergeRead(state, r, R), { read: r, elapsedS: 150, transcript }).offer).toBeNull();
  });
});

// ---------- anti-nagging: random check-ins ----------

// A small seeded generator (mulberry32), so a failure can be replayed from its seed.
function generator(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SAID = "Settled the vendor onboarding for the Jurong site lah, then the Q3 budget deck. Team ok lah, quite shiok.";
const WORDINGS = [
  "",
  "You mentioned the vendor onboarding: where did that get to?",
  "What else took up your week besides the budget deck?",
  "Why did the deck take so long?",
  "How would you rate your week?",
  "What happened with the Tuas warehouse?",
];

// One made-up recording: Claude's reads are noisy (sometimes lower than before, sometimes off), the
// mood sometimes turns, they sometimes wrap up early, and the browser shows the latest offer only
// some of the time and sometimes gets a different question.
function simulate(rubric: CoachRubric, seed: number) {
  const random = generator(seed);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  const ids = rubric.topics.map((t) => t.id);
  const s = rubric.settings;
  const truth: Record<string, Level> = {};
  const newlyAsked: string[] = [];
  let state = initialState();
  let waiting: number | null = null;
  let elapsedS = 0;

  for (let call = 0; call < 50 && elapsedS < s.noNewQuestionsAfterS + 60; call++) {
    elapsedS += 4 + random() * 16;
    if (waiting !== null && random() < 0.7) {
      const before = state.asked;
      state = acknowledge(state, waiting, rubric);
      newlyAsked.push(...state.asked.filter((id) => !before.includes(id)));
      waiting = null;
    }

    const onScreen = state.offers.find((o) => o.id === state.current);
    let decision: Decision;
    const before = state;
    if (onScreen?.kind === "question" && onScreen.topic && random() < 0.2) {
      state = skip(state, state.current);
      decision = nextOffer(state, { rubric, elapsedS, read: null, transcript: SAID });
    } else {
      for (const id of ids) if (random() < 0.15) truth[id] = pick(["brief", "clear", "declined"] as const);
      const coverage = Object.fromEntries(ids.map((id) => [id, random() < 0.2 ? pick(LEVELS) : (truth[id] ?? "none")]));
      const tone: Tone = random() < 0.01 ? "distress" : random() < 0.1 ? "hard_week" : "neutral";
      const r = read({
        coverage,
        tone,
        wrappingUp: random() < 0.1,
        instructionsInTranscript: random() < 0.05,
        target: random() < 0.8 ? pick(ids) : null,
        quote: random() < 0.5 ? "vendor onboarding" : "",
        question: pick(WORDINGS),
      });
      state = mergeRead(state, r, rubric);
      decision = nextOffer(state, { rubric, elapsedS, read: r, transcript: SAID });
    }

    const where = `seed ${seed}, call ${call}`;
    const offer = decision.offer;
    const ended = before.linesShown.some((l) => l !== "beforeYouFinish");
    if (offer?.kind === "question") {
      // A question only about something not yet asked or skipped, within the limits, and never
      // once the questions have ended.
      const topic = rubric.topics.find((t) => t.id === offer.topic)!;
      expect(state.asked.includes(topic.id) || state.skipped.includes(topic.id), where).toBe(false);
      expect(state.followUps, where).toBeLessThan(s.maxFollowUps);
      expect(state.perArea[topic.area] ?? 0, where).toBeLessThan(s.maxPerArea);
      expect(ended, where).toBe(false);
      expect(state.tone, where).not.toBe("distress");
    }
    if (before.linesShown.includes("closing")) expect(offer, where).toBeNull();
    else if (ended && offer) expect(offer.kind, where).toBe("closing");

    state = decision.state;
    if (offer) waiting = offer.id;

    expect(state.followUps, where).toBe(state.asked.length);
    expect(state.followUps, where).toBeLessThanOrEqual(s.maxFollowUps);
    for (const area of AREAS) expect(state.perArea[area] ?? 0, where).toBeLessThanOrEqual(s.maxPerArea);
    expect(new Set([...state.asked, ...state.skipped]).size, where).toBe(state.asked.length + state.skipped.length);
    expect(new Set(newlyAsked).size, where).toBe(newlyAsked.length);
    expect(state.offers.length, where).toBeLessThanOrEqual(4);
    expect(state.offers.some((o) => o.id === state.current), where).toBe(true);
    // Each topic is counted once, when its question first reaches the screen, and a turned-down
    // wording only with the rubric's question that was shown instead.
    expect(state.counts.tailored + state.counts.bank, where).toBe(state.asked.length + state.skipped.length);
    expect(state.counts.rejected, where).toBeLessThanOrEqual(state.counts.bank);
  }
  return state;
}

describe("anti-nagging, over many made-up check-ins", () => {
  it.each<[string, CoachRubric]>([
    ["the frozen rubric", R],
    ["rubrics/coach.md", REAL],
  ])("never asks a topic twice or past the limits, with %s", (_label, rubric) => {
    let questions = 0;
    let rejected = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const state = simulate(rubric, seed);
      questions += state.followUps;
      rejected += state.counts.rejected;
    }
    // The simulation does ask things, and turns wording down: otherwise it would prove nothing.
    expect(questions).toBeGreaterThan(300);
    expect(rejected).toBeGreaterThan(0);
  });
});
