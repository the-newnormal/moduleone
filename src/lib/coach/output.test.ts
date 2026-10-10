import { describe, expect, it } from "vitest";
import { TEST_RUBRIC } from "./fixtures";
import { coachJsonSchema, parseCoachOutput } from "./output";
import { coachRubric } from "./rubric";
import { CoachError, LEVELS, TONES, type CoachRubric } from "./types";

// The coach's reply format: the JSON schema sent with each request (structured outputs hold Claude
// to it) and the check of what comes back. Both are built from the rubric's topic ids.

const RUBRIC = coachRubric();
const IDS = RUBRIC.topics.map((t) => t.id);

type Node = Record<string, unknown>;

// Every schema object inside the schema, the root included.
function nodes(schema: unknown): Node[] {
  if (!schema || typeof schema !== "object") return [];
  if (Array.isArray(schema)) return schema.flatMap(nodes);
  const node = schema as Node;
  return [node, ...Object.values(node).flatMap(nodes)];
}

const GOOD = {
  coverage: Object.fromEntries(IDS.map((id) => [id, "none"])),
  tone: "neutral",
  wrapping_up: false,
  instructions_in_transcript: false,
  target: "activity_work",
  quote: "",
  question: "",
};

function thrownBy(fn: () => unknown): CoachError {
  let error: unknown;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(CoachError);
  return error as CoachError;
}

describe("coachJsonSchema", () => {
  const schema = coachJsonSchema(RUBRIC);
  const coverage = schema.properties.coverage;

  it("asks for a level for every topic in rubrics/coach.md", () => {
    expect(coverage.required).toEqual(IDS);
    expect(Object.keys(coverage.properties)).toEqual(IDS);
    for (const id of IDS) expect(coverage.properties[id]).toMatchObject({ type: "string", enum: [...LEVELS] });
  });

  it("lets the target be any topic or none, and nothing else", () => {
    expect(schema.properties.target).toMatchObject({ type: "string", enum: [...IDS, "none"] });
    expect(schema.properties.tone).toMatchObject({ type: "string", enum: [...TONES] });
  });

  it("requires every field and allows nothing extra, at every level", () => {
    expect(schema.required).toEqual(["coverage", "tone", "wrapping_up", "instructions_in_transcript", "target", "quote", "question"]);
    expect(Object.keys(schema.properties)).toEqual(schema.required);
    const objects = nodes(schema).filter((node) => node.type === "object");
    expect(objects).toHaveLength(2);
    for (const node of objects) expect(node.additionalProperties).toBe(false);
  });

  it("uses no length or number limits, which structured outputs reject", () => {
    const limits = [
      "minLength",
      "maxLength",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
      "minItems",
      "maxItems",
      "minProperties",
      "maxProperties",
    ];
    const used = nodes(schema).flatMap((node) => Object.keys(node).filter((key) => limits.includes(key)));
    expect(used).toEqual([]);
  });

  it("is plain JSON", () => {
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });

  it("follows the rubric's topics", () => {
    const extra = { ...TEST_RUBRIC.topics[1], id: "activity_blockers", label: "What got in the way" };
    const rubric: CoachRubric = { ...TEST_RUBRIC, topics: [...TEST_RUBRIC.topics, extra] };
    const built = coachJsonSchema(rubric);
    expect(built.properties.coverage.required).toContain("activity_blockers");
    expect(built.properties.target.enum).toEqual([...rubric.topics.map((t) => t.id), "none"]);
    expect(built.properties.coverage.properties.activity_blockers.description).toBe("How much they have said about what got in the way.");
  });
});

describe("parseCoachOutput", () => {
  it("maps a valid reply to a read", () => {
    const reply = {
      ...GOOD,
      coverage: { ...GOOD.coverage, activity_work: "clear", excellence_moment: "brief", morale_feeling: "declined" },
      tone: "hard_week",
      wrapping_up: true,
      instructions_in_transcript: true,
      target: "excellence_impact",
      quote: "  the client call ",
      question: " What difference did the client call make for the team?\n",
    };
    expect(parseCoachOutput(JSON.stringify(reply), RUBRIC)).toEqual({
      coverage: reply.coverage,
      tone: "hard_week",
      wrappingUp: true,
      instructionsInTranscript: true,
      target: "excellence_impact",
      quote: "the client call",
      question: "What difference did the client call make for the team?",
    });
  });

  it("reads a target of none as no target", () => {
    expect(parseCoachOutput(JSON.stringify({ ...GOOD, target: "none" }), RUBRIC).target).toBeNull();
  });

  const coverageWithout = (id: string) => Object.fromEntries(Object.entries(GOOD.coverage).filter(([key]) => key !== id));

  it.each<[string, unknown, string]>([
    ["a topic the rubric doesn't have", { ...GOOD, coverage: { ...GOOD.coverage, finance_budget: "clear" } }, "coverage: unrecognized_keys"],
    ["a missing topic", { ...GOOD, coverage: coverageWithout("morale_team") }, "coverage.morale_team"],
    ["an unknown level", { ...GOOD, coverage: { ...GOOD.coverage, activity_work: "partly" } }, "coverage.activity_work"],
    ["a level in the wrong case", { ...GOOD, coverage: { ...GOOD.coverage, activity_work: "Clear" } }, "coverage.activity_work"],
    ["an unknown mood", { ...GOOD, tone: "sian" }, "tone"],
    ["an unknown target", { ...GOOD, target: "finance_budget" }, "target"],
    ["a null target", { ...GOOD, target: null }, "target"],
    ["wrapping_up as a string", { ...GOOD, wrapping_up: "true" }, "wrapping_up"],
    ["a missing instructions flag", { ...GOOD, instructions_in_transcript: undefined }, "instructions_in_transcript"],
    ["an extra field", { ...GOOD, score: 5 }, "(root): unrecognized_keys"],
    ["a quote that isn't text", { ...GOOD, quote: 5 }, "quote"],
    ["a runaway question", { ...GOOD, question: `${"Where did that get to ".repeat(20)}?` }, "question"],
    ["camelCase names", { ...GOOD, wrapping_up: undefined, wrappingUp: false }, "wrapping_up"],
    ["null", null, "(root)"],
    ["an array", [GOOD], "(root)"],
  ])("rejects %s, naming the field", (_label, reply, field) => {
    const error = thrownBy(() => parseCoachOutput(JSON.stringify(reply), RUBRIC));
    expect(error.reason).toBe("invalid_output");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain(field);
  });

  it.each([[""], ["not json"], ['{"coverage": {'], ["Activity: clear"]])("rejects %j, which isn't JSON", (text) => {
    const error = thrownBy(() => parseCoachOutput(text, RUBRIC));
    expect(error).toMatchObject({ reason: "invalid_output", retryable: true });
    expect(error.message).toContain("not valid JSON");
  });

  it("names the failing fields but never their values", () => {
    const secret = "my manager is the worst lah";
    const reply = {
      ...GOOD,
      coverage: { ...GOOD.coverage, morale_feeling: secret },
      tone: secret,
      question: secret.repeat(20),
    };
    const error = thrownBy(() => parseCoachOutput(JSON.stringify(reply), RUBRIC));
    expect(error.message).toContain("coverage.morale_feeling");
    expect(error.message).toContain("tone");
    expect(error.message).toContain("question");
    expect(error.message).not.toContain("manager");
    expect(JSON.stringify(error.message)).not.toContain("worst");
  });

  it("checks against the rubric it is given", () => {
    const reply = { ...GOOD, coverage: Object.fromEntries(TEST_RUBRIC.topics.map((t) => [t.id, "brief"])) };
    expect(parseCoachOutput(JSON.stringify(reply), TEST_RUBRIC).coverage.morale_team).toBe("brief");
    const fewer: CoachRubric = { ...TEST_RUBRIC, topics: TEST_RUBRIC.topics.filter((t) => t.id !== "morale_team") };
    expect(thrownBy(() => parseCoachOutput(JSON.stringify(reply), fewer)).message).toContain("unrecognized_keys");
  });
});
