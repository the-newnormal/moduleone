import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accepts, FIXTURES, LABELLED_TOPICS, type CoachFixture } from "./fixtures";
import { COACH_DEADLINE_MS, CoachError, readTranscript, type CoachReadResult } from "./index";
import { coachRubric } from "./rubric";
import { LEVELS, TONES } from "./types";

// The live coach against the real Anthropic API, on the labelled check-ins in fixtures.ts: the seed
// of the coach's eval set. It calls Claude once per check-in (a dozen short calls on the coach's
// model, about a cent with Claude Haiku), so it only runs when asked:
//   ANTHROPIC_API_KEY=... RUN_LIVE_COACH_TESTS=1 pnpm vitest run --silent=false src/lib/coach/coach.live.test.ts
// (--silent=false shows the table even when every check passes). Set COACH_MODEL to try another model. It prints how often Claude's levels agree with the labels,
// check-in by check-in and topic by topic, for whoever is tuning rubrics/coach.md; it fails only on
// what must hold on every run. Agreement below 100% is expected: read the misses before changing
// the rubric, and add a labelled check-in to fixtures.ts for anything worth watching.
const live = Boolean(process.env.ANTHROPIC_API_KEY) && process.env.RUN_LIVE_COACH_TESTS === "1";

// A few calls at a time, each with one more try if it failed in a way worth retrying.
const AT_ONCE = 4;
const TIMEOUT_MS = Math.ceil(FIXTURES.length / AT_ONCE) * 2 * (COACH_DEADLINE_MS + 2_000) + 10_000;

async function readFixture(fixture: CoachFixture): Promise<CoachReadResult> {
  try {
    return await readTranscript({ transcript: fixture.transcript, alreadyAsked: [] });
  } catch (error) {
    if (!(error instanceof CoachError) || !error.retryable) throw error;
    return readTranscript({ transcript: fixture.transcript, alreadyAsked: [] });
  }
}

const short = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}~` : text.padEnd(width));

function report(results: Map<string, CoachReadResult>): string {
  const lines = [`Coach agreement with the labels in fixtures.ts (${results.size} check-ins):`, ""];
  lines.push(`${"check-in".padEnd(24)} ${"topics".padEnd(7)} ${"mood".padEnd(5)} ${"instr".padEnd(6)} misses (got, wanted)`);
  const perTopic = new Map<string, number>(LABELLED_TOPICS.map((id) => [id, 0]));
  let tones = 0;
  let flags = 0;
  for (const fixture of FIXTURES) {
    const result = results.get(fixture.name);
    if (!result) continue;
    const { read } = result;
    const misses: string[] = [];
    for (const id of LABELLED_TOPICS) {
      const got = read.coverage[id] ?? "none";
      if (accepts(fixture.coverage[id], got)) perTopic.set(id, (perTopic.get(id) ?? 0) + 1);
      else misses.push(`${id} ${got}, ${[fixture.coverage[id]].flat().join("/")}`);
    }
    const tone = accepts(fixture.tone, read.tone);
    const flag = read.instructionsInTranscript === fixture.instructions;
    if (tone) tones++;
    else misses.push(`mood ${read.tone}, ${[fixture.tone].flat().join("/")}`);
    if (flag) flags++;
    const agreed = LABELLED_TOPICS.length - misses.filter((m) => !m.startsWith("mood ")).length;
    lines.push(
      `${short(fixture.name, 24)} ${`${agreed}/${LABELLED_TOPICS.length}`.padEnd(7)} ${(tone ? "ok" : "MISS").padEnd(5)} ${(flag ? "ok" : "MISS").padEnd(6)} ${misses.join("; ")}`,
    );
  }
  lines.push("", `${"topic".padEnd(24)} agreement`);
  for (const [id, agreed] of perTopic) lines.push(`${id.padEnd(24)} ${agreed}/${results.size}`);
  lines.push(`${"mood".padEnd(24)} ${tones}/${results.size}`, `${"instructions flag".padEnd(24)} ${flags}/${results.size}`);
  const unlabelled = coachRubric()
    .topics.map((t) => t.id)
    .filter((id) => !(LABELLED_TOPICS as readonly string[]).includes(id));
  if (unlabelled.length) lines.push("", `Not labelled in fixtures.ts yet: ${unlabelled.join(", ")}`);
  return lines.join("\n");
}

// Runs on every test run, without the API: the labels must name topics rubrics/coach.md has.
describe("the coach's labelled check-ins", () => {
  it("label only topics the rubric has, with real levels and moods", () => {
    const ids = coachRubric().topics.map((t) => t.id);
    const names = new Set<string>();
    for (const fixture of FIXTURES) {
      expect(names.has(fixture.name), fixture.name).toBe(false);
      names.add(fixture.name);
      expect(fixture.transcript.trim().length, fixture.name).toBeGreaterThan(0);
      for (const [id, expected] of Object.entries(fixture.coverage)) {
        expect(ids, fixture.name).toContain(id);
        for (const level of [expected].flat()) expect(LEVELS, `${fixture.name} ${id}`).toContain(level);
      }
      for (const tone of [fixture.tone].flat()) expect(TONES, fixture.name).toContain(tone);
    }
  });
});

describe.skipIf(!live)("readTranscript on the labelled check-ins, against the real API", () => {
  const results = new Map<string, CoachReadResult>();
  const readOf = (name: string) => {
    const result = results.get(name);
    if (!result) throw new Error(`No read for the check-in "${name}"`);
    return result.read;
  };

  beforeAll(async () => {
    for (let i = 0; i < FIXTURES.length; i += AT_ONCE) {
      const batch = FIXTURES.slice(i, i + AT_ONCE);
      const reads = await Promise.all(batch.map(readFixture));
      batch.forEach((fixture, j) => results.set(fixture.name, reads[j]));
    }
  }, TIMEOUT_MS);

  afterAll(() => {
    if (results.size > 0) console.log(report(results));
  });

  it("gives a complete read of every check-in", () => {
    const ids = coachRubric().topics.map((t) => t.id);
    for (const fixture of FIXTURES) {
      const result = results.get(fixture.name);
      expect(result, fixture.name).toBeDefined();
      expect(Object.keys(result!.read.coverage).sort(), fixture.name).toEqual([...ids].sort());
      expect(TONES, fixture.name).toContain(result!.read.tone);
      expect(result!.model, fixture.name).not.toBe("");
      expect(result!.usage.outputTokens, fixture.name).toBeGreaterThan(0);
    }
  });

  it("flags the check-in that tries to give it instructions", () => {
    expect(readOf("injection").instructionsInTranscript).toBe(true);
  });

  it("reads plain distress as distress", () => {
    expect(readOf("distress").tone).toBe("distress");
  });

  it("doesn't count a week on leave as work covered", () => {
    expect(readOf("on_leave").coverage.activity_work).not.toBe("clear");
  });

  it("finds every key topic in a strong check-in", () => {
    const read = readOf("strong_all_round");
    for (const topic of coachRubric().topics.filter((t) => t.key)) {
      expect(["brief", "clear"], topic.id).toContain(read.coverage[topic.id]);
    }
  });
});
