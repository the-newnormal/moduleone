// How the live coach picks the next question: plain code, no API calls, so it can be tested and
// tuned on its own. Claude only reports what the member has covered (a CoachRead); everything here
// decides what to ask, using the weights and settings in rubrics/coach.md. rubrics/README.md
// explains the rules in words; keep the two in step.
//
// The state lives on the server between calls (live_checkin_sessions.coach_state, 0011) and holds
// topic ids, levels and counts only: never the member's words or the questions' wording.

import { z } from "zod";
import {
  AREAS,
  LEVELS,
  OFFER_KINDS,
  TONES,
  type Area,
  type CoachRead,
  type CoachRubric,
  type Level,
  type Offer,
  type OfferKind,
  type OfferSource,
  type Tone,
  type Topic,
  type Touched,
} from "./types";

const RANK: Record<Level, number> = { none: 0, brief: 1, clear: 2, declined: 3 };
const TONE_RANK: Record<Tone, number> = { neutral: 0, hard_week: 1, distress: 2 };
// Offers kept so the browser can say which one it showed, even if a newer one has arrived since.
const OFFERS_KEPT = 4;
// The opening question is offer 0, on screen from the start.
export const OPENING_OFFER_ID = 0;

const OfferRecord = z.object({
  id: z.number().int().nonnegative(),
  kind: z.enum(OFFER_KINDS),
  topic: z.string().nullable(),
  source: z.enum(["tailored", "bank", "line"]),
  beforeYouFinish: z.boolean(),
});
export type OfferRecord = z.infer<typeof OfferRecord>;

const Counts = z.object({
  // Claude reads, and the ones that failed (timeout, API error, refusal, unusable reply).
  reads: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  // Questions shown with Claude's wording, and with the rubric's.
  tailored: z.number().int().nonnegative(),
  bank: z.number().int().nonnegative(),
  // Claude's wordings turned down by validateQuestion, and reads that flagged instructions in the
  // transcript.
  rejected: z.number().int().nonnegative(),
  instructions: z.number().int().nonnegative(),
  // Total and slowest Claude read time, in ms.
  latencyMs: z.number().nonnegative(),
  slowestMs: z.number().nonnegative(),
});

const State = z.object({
  v: z.literal(1),
  coverage: z.record(z.string(), z.enum(LEVELS)),
  tone: z.enum(TONES),
  // Topics shown to the member (and those they skipped), in order. Each is asked at most once.
  asked: z.array(z.string()),
  skipped: z.array(z.string()),
  followUps: z.number().int().nonnegative(),
  perArea: z.record(z.string(), z.number().int().nonnegative()),
  skipsInARow: z.number().int().nonnegative(),
  linesShown: z.array(z.enum(["covered", "late", "closing", "beforeYouFinish"])),
  offers: z.array(OfferRecord),
  nextOfferId: z.number().int().positive(),
  // The offer on screen now.
  current: z.number().int().nonnegative(),
  // How many words of the transcript Claude had read by the last read.
  wordsRead: z.number().int().nonnegative(),
  // Areas whose coverage went up in the latest read: what they are talking about now.
  flow: z.array(z.enum(AREAS as [Area, ...Area[]])),
  counts: Counts,
});
export type CoachState = z.infer<typeof State>;

export function initialState(): CoachState {
  return {
    v: 1,
    coverage: {},
    tone: "neutral",
    asked: [],
    skipped: [],
    followUps: 0,
    perArea: {},
    skipsInARow: 0,
    linesShown: [],
    offers: [{ id: OPENING_OFFER_ID, kind: "question", topic: null, source: "line", beforeYouFinish: false }],
    nextOfferId: 1,
    current: OPENING_OFFER_ID,
    wordsRead: 0,
    flow: [],
    counts: { reads: 0, failures: 0, tailored: 0, bank: 0, rejected: 0, instructions: 0, latencyMs: 0, slowestMs: 0 },
  };
}

// The state as stored, or a fresh one if it is missing or from an older shape (a new session, or
// one that started before a change to this file): the coach then simply starts over.
export function parseState(stored: unknown): CoachState {
  const parsed = State.safeParse(stored);
  return parsed.success ? parsed.data : initialState();
}

const level = (state: CoachState, id: string): Level => state.coverage[id] ?? "none";
const areaCount = (state: CoachState, area: Area) => state.perArea[area] ?? 0;
const keyTopic = (rubric: CoachRubric, area: Area) => rubric.topics.find((t) => t.area === area && t.key) as Topic;
const seen = (state: CoachState, id: string) => state.asked.includes(id) || state.skipped.includes(id);

// An area is touched once its key topic has come up at all; the member sees only this.
export function touched(state: CoachState, rubric: CoachRubric): Touched {
  return Object.fromEntries(AREAS.map((area) => [area, level(state, keyTopic(rubric, area).id) !== "none"])) as Touched;
}

// An area's key topic is done once it is clear or declined, or has been asked (or skipped) once.
function keyDone(state: CoachState, rubric: CoachRubric, area: Area): boolean {
  const key = keyTopic(rubric, area);
  const l = level(state, key.id);
  return l === "clear" || l === "declined" || seen(state, key.id);
}

// Adds a read to the state: each topic keeps the highest level any read has given it, so a later,
// noisier read never makes the coach ask again about something already covered; the mood only ever
// gets heavier.
export function mergeRead(state: CoachState, read: CoachRead, rubric: CoachRubric): CoachState {
  const coverage = { ...state.coverage };
  const flow = new Set<Area>();
  for (const topic of rubric.topics) {
    const before = level(state, topic.id);
    const now = read.coverage[topic.id] ?? "none";
    if (RANK[now] > RANK[before]) {
      coverage[topic.id] = now;
      flow.add(topic.area);
    }
  }
  return {
    ...state,
    coverage,
    tone: TONE_RANK[read.tone] > TONE_RANK[state.tone] ? read.tone : state.tone,
    flow: AREAS.filter((area) => flow.has(area)),
    counts: { ...state.counts, instructions: state.counts.instructions + (read.instructionsInTranscript ? 1 : 0) },
  };
}

// The browser says offer `id` is on screen now. The first time a question is shown, its topic counts
// as asked; a closing line counts as said. Unknown or repeated ids change nothing.
export function acknowledge(state: CoachState, id: number, rubric: CoachRubric): CoachState {
  if (id === state.current) return state;
  const offer = state.offers.find((o) => o.id === id);
  if (!offer) return state;
  const next: CoachState = { ...state, current: id };
  if (offer.kind === "question" && offer.topic) {
    const topic = rubric.topics.find((t) => t.id === offer.topic);
    if (!topic || seen(state, topic.id)) return next;
    // The question that replaces a skipped one keeps the run of skips going; any other starts it again.
    const replaced = state.offers.find((o) => o.id === state.current)?.topic;
    const afterSkip = replaced != null && state.skipped.includes(replaced);
    return {
      ...next,
      asked: [...state.asked, topic.id],
      followUps: state.followUps + 1,
      perArea: { ...state.perArea, [topic.area]: areaCount(state, topic.area) + 1 },
      skipsInARow: afterSkip ? state.skipsInARow : 0,
      linesShown: offer.beforeYouFinish ? [...state.linesShown, "beforeYouFinish"] : state.linesShown,
      counts: {
        ...state.counts,
        tailored: state.counts.tailored + (offer.source === "tailored" ? 1 : 0),
        bank: state.counts.bank + (offer.source === "bank" ? 1 : 0),
      },
    };
  }
  if (offer.kind !== "question" && !state.linesShown.includes(offer.kind)) {
    return { ...next, linesShown: [...state.linesShown, offer.kind] };
  }
  return next;
}

// The member pressed "Different question" on offer `id`. Its topic stays asked (it is never offered
// again) but doesn't count as a follow-up; two skips in a row end the questions.
export function skip(state: CoachState, id: number): CoachState {
  const offer = state.offers.find((o) => o.id === id);
  if (id !== state.current || !offer || offer.kind !== "question" || !offer.topic) return state;
  if (state.skipped.includes(offer.topic)) return state;
  return {
    ...state,
    asked: state.asked.filter((t) => t !== offer.topic),
    skipped: [...state.skipped, offer.topic],
    followUps: Math.max(0, state.followUps - 1),
    skipsInARow: state.skipsInARow + 1,
  };
}

// How much a topic still needs asking: 1 if not mentioned, the "Brief answer counts as" setting if
// only touched on (0 when a brief answer is enough), 0 once clear or declined.
function need(state: CoachState, topic: Topic, rubric: CoachRubric): number {
  const l = level(state, topic.id);
  if (l === "clear" || l === "declined") return 0;
  if (l === "brief") return topic.briefIsEnough ? 0 : rubric.settings.briefNeed;
  return 1;
}

export type Scored = { topic: Topic; score: number };

// Every topic that may be asked now, best first, with its score.
export function candidates(state: CoachState, rubric: CoachRubric, elapsedS: number): Scored[] {
  const s = rubric.settings;
  const scored: Scored[] = [];
  for (const topic of rubric.topics) {
    const n = need(state, topic, rubric);
    if (n === 0 || seen(state, topic.id)) continue;
    if (topic.needs) {
      const needed = level(state, topic.needs);
      if (needed !== "brief" && needed !== "clear") continue;
    }
    if (state.followUps >= s.maxFollowUps || areaCount(state, topic.area) >= s.maxPerArea) continue;
    if (elapsedS >= s.noNewQuestionsAfterS) continue;
    if (elapsedS >= s.keysOnlyAfterS && !topic.key) continue;
    const untouched = rubric.topics.filter((t) => t.area === topic.area).every((t) => level(state, t.id) === "none");
    const score =
      topic.weight * n +
      (topic.key && untouched ? s.untouchedBonus : 0) +
      (state.flow.includes(topic.area) ? s.flowBonus : 0);
    scored.push({ topic, score });
  }
  const order = (t: Topic) => rubric.topics.indexOf(t);
  return scored.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.topic.key) - Number(a.topic.key) ||
      AREAS.indexOf(a.topic.area) - AREAS.indexOf(b.topic.area) ||
      order(a.topic) - order(b.topic),
  );
}

// The least score worth asking now: higher once every area has been touched (only depth on what they
// are talking about is left), and higher still in a hard week (fewer questions, never more).
export function floor(state: CoachState, rubric: CoachRubric): number {
  const s = rubric.settings;
  const allKeys = AREAS.every((area) => keyDone(state, rubric, area));
  const base = allKeys ? s.minScoreAfterKeys : s.minScore;
  return state.tone === "hard_week" ? Math.max(base, s.minScoreHardWeek) : base;
}

export type Decision = { state: CoachState; offer: Offer | null };

// What to show next, given everything so far and, if one was made this call, Claude's latest read.
// Returns no offer when there is nothing new to show (the screen keeps what it has).
export function nextOffer(
  state: CoachState,
  input: { rubric: CoachRubric; elapsedS: number; read: CoachRead | null; transcript: string },
): Decision {
  const { rubric, elapsedS, read, transcript } = input;
  const s = rubric.settings;
  const lines = rubric.lines;
  const said = (kind: CoachState["linesShown"][number]) => state.linesShown.includes(kind);
  const ended = said("closing") || said("covered") || said("late");

  if (state.tone === "distress") return said("closing") ? none(state) : line(state, "closing", lines.closing);
  if (ended) return none(state);
  if (elapsedS >= s.noNewQuestionsAfterS) return line(state, "late", lines.late);

  const allKeys = AREAS.every((area) => keyDone(state, rubric, area));
  const canAsk = (topic: Topic) =>
    !seen(state, topic.id) && state.followUps < s.maxFollowUps && areaCount(state, topic.area) < s.maxPerArea;

  // They are finishing but an area hasn't come up: one last question about it, once.
  if (read?.wrappingUp && !allKeys && !said("beforeYouFinish")) {
    const area = AREAS.find((a) => !keyDone(state, rubric, a) && canAsk(keyTopic(rubric, a)));
    if (area) {
      const topic = keyTopic(rubric, area);
      return question(state, topic, "bank", `${lines.beforeYouFinish} ${lowerFirst(bankText(state, topic))}`, true);
    }
  }

  if (state.followUps >= s.maxFollowUps || state.skipsInARow >= 2) return line(state, "covered", lines.covered);
  const minimum = floor(state, rubric);
  const ranked = candidates(state, rubric, elapsedS).filter((c) => c.score >= minimum);
  if (ranked.length === 0) return line(state, "covered", lines.covered);
  const best = ranked[0];

  // Claude's own wording, when it chose a topic the policy would ask about too (scoring within the
  // slack of the best), the topic allows it, and the wording passes every check.
  if (read?.target && read.question && !read.instructionsInTranscript) {
    const chosen = ranked.find((c) => c.topic.id === read.target);
    if (chosen && chosen.topic.tailor && chosen.score >= best.score - s.tailorSlack) {
      const problem = validateQuestion(read.question, read.quote, transcript, s.maxQuestionChars);
      if (!problem) return question(state, chosen.topic, "tailored", read.question.trim(), false);
      state = { ...state, counts: { ...state.counts, rejected: state.counts.rejected + 1 } };
    }
  }
  return question(state, best.topic, "bank", bankText(state, best.topic), false);
}

function bankText(state: CoachState, topic: Topic): string {
  return state.tone === "hard_week" && topic.askHardWeek ? topic.askHardWeek : topic.ask;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function none(state: CoachState): Decision {
  return { state, offer: null };
}

function line(state: CoachState, kind: Exclude<OfferKind, "question">, text: string): Decision {
  return offer(state, { kind, topic: null, source: "line", beforeYouFinish: false }, text);
}

function question(state: CoachState, topic: Topic, source: OfferSource, text: string, beforeYouFinish: boolean): Decision {
  return offer(state, { kind: "question", topic: topic.id, source, beforeYouFinish }, text);
}

// Keeps the offer on screen, the few latest others and the new one.
function offer(state: CoachState, record: Omit<OfferRecord, "id">, text: string): Decision {
  const id = state.nextOfferId;
  const current = state.offers.filter((o) => o.id === state.current);
  const others = state.offers.filter((o) => o.id !== state.current).slice(-(OFFERS_KEPT - 2));
  const offers = [...current, ...others, { id, ...record }];
  return {
    state: { ...state, offers, nextOfferId: id + 1 },
    offer: { id, kind: record.kind, topic: record.topic, source: record.source, text },
  };
}

// ---------- checking Claude's wording ----------

// Words Claude's question must never use: talk of grades or who reads it, praise or pressure, care
// or private life. These back up the rubric's question style; a false alarm only means the rubric's
// own question is shown instead.
const BLOCKED: [string, RegExp][] = [
  ["grading", /scor|grad(e|ing)|\brat(e|ed|ing)\b|rubric|assess|evaluat|out of \d|percent|\d\s*\/\s*\d/i],
  ["audience", /\bHQ\b|\b(leader|manager|boss)s? (will|would|can|might)\b|who (will )?reads?/i],
  ["praise", /\bproud\b|\bgreat\b|amazing|awesome|impressive|well done|good job|bright side|\bat least\b/i],
  ["pressure", /\bwhy\b|\bshould\b|\bonly\b|\bjust\b|didn't|haven't|elaborate|more detail|be (more )?specific|tell me more/i],
  ["personal", /depress|anxi|burn.?out|mental|therap|counsel|health|sick|family|wife|husband|child|kids?\b|parent|money|salary|religio|relationship/i],
  ["links", /https?:|www\.|@|\.com\b/i],
];

const normalise = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

// Why a question Claude wrote can't be shown, or null if it can. The quote (the member's own words the
// question refers to, if any) must really be in what they said, so the coach never claims they said
// something they didn't.
export function validateQuestion(question: string, quote: string, transcript: string, maxChars: number): string | null {
  const q = question.trim();
  if (q.length < 12) return "too_short";
  if (q.length > maxChars) return "too_long";
  if (q.split(/\s+/).length > 30) return "too_many_words";
  if (/[\n\r]/.test(q)) return "several_lines";
  if (!q.endsWith("?") || q.indexOf("?") !== q.length - 1) return "not_one_question";
  for (const [name, pattern] of BLOCKED) if (pattern.test(q)) return `blocked_${name}`;
  const words = normalise(quote);
  if (words) {
    if (words.split(" ").length > 8) return "quote_too_long";
    if (!` ${normalise(transcript)} `.includes(` ${words} `)) return "quote_not_said";
  }
  return null;
}
