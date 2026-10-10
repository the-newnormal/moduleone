import { describe, expect, it } from "vitest";
import coachFile from "../../../rubrics/coach.md";
import { RubricError } from "../rubrics/markdown";
import { coachRubric, pacingFrom, parseCoachRubric, SETTINGS } from "./rubric";
import { AREAS } from "./types";

// rubrics/coach.md is edited by people on GitHub. This test runs on every pull request: the real
// file must parse with every number in range, and each mistake an editor might make must be refused
// with a message they can act on. The broken versions are the real file with one edit, made by the
// structure (headings, topic ids, line and setting labels) rather than the wording, so rewording a
// question or a description never breaks this test.

// Rewrites one part of the file: a "## " section or a "### " topic, from its heading up to the next
// heading of the same level or higher. Fails if the part is gone or the edit changed nothing, so no
// test can pass by editing nothing.
function editPart(heading: string, change: (part: string) => string, source: string = coachFile): string {
  const line = source.indexOf(`\n${heading}`);
  if (line < 0) throw new Error(`rubrics/coach.md has no "${heading}" any more; update this test`);
  const start = line + 1;
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  const next = new RegExp(`\\n#{1,${level}} `).exec(source.slice(start));
  const end = next ? start + next.index : source.length;
  const part = source.slice(start, end);
  const changed = change(part);
  if (changed === part) throw new Error(`The edit to "${heading}" changed nothing; update this test`);
  return source.slice(0, start) + changed + source.slice(end);
}

const inSection = (name: string, pattern: RegExp | string, replacement: string, source?: string) =>
  editPart(`## ${name}\n`, (part) => part.replace(pattern, replacement), source);
const inTopic = (id: string, pattern: RegExp | string, replacement: string, source?: string) =>
  editPart(`### ${id}:`, (part) => part.replace(pattern, replacement), source);
// A "- Label: value" line of the settings, by its label.
const setting = (label: string, value: string, source?: string) =>
  inSection("Settings", new RegExp(`^- ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:.*$`, "m"), `- ${label}: ${value}`, source);

function refused(source: string): RubricError {
  let error: unknown;
  try {
    parseCoachRubric(source);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(RubricError);
  return error as RubricError;
}

const IDS = [
  "activity_work",
  "activity_outcome",
  "activity_more",
  "excellence_moment",
  "excellence_impact",
  "excellence_strength",
  "morale_feeling",
  "morale_reason",
  "morale_team",
];

describe("rubrics/coach.md", () => {
  const rubric = coachRubric();
  const topic = (id: string) => rubric.topics.find((t) => t.id === id)!;

  it("parses, and is read once", () => {
    expect(coachRubric()).toBe(rubric);
    expect(parseCoachRubric(coachFile)).toEqual(rubric);
  });

  it("has one opening question, on one line", () => {
    expect(rubric.opening).not.toBe("");
    expect(rubric.opening).not.toContain("\n");
    expect(rubric.opening.length).toBeLessThanOrEqual(300);
  });

  it("keeps the nine topic ids, which are stored with each recording's statistics", () => {
    // A topic may be added, so this checks only that none of these has been renamed. Removing one
    // on purpose means removing it here too.
    const ids = rubric.topics.map((t) => t.id);
    expect(ids.filter((id) => IDS.includes(id))).toEqual(IDS);
    for (const t of rubric.topics.filter((t) => IDS.includes(t.id))) expect(t.id.startsWith(`${t.area}_`)).toBe(true);
  });

  it("has exactly one key topic per area, needing nothing", () => {
    for (const area of AREAS) {
      const keys = rubric.topics.filter((t) => t.area === area && t.key);
      expect(keys, area).toHaveLength(1);
      expect(keys[0].needs).toBeNull();
    }
  });

  it("asks a follow-up only after a topic in the same area that needs nothing", () => {
    for (const t of rubric.topics.filter((t) => t.needs)) {
      const needed = rubric.topics.find((n) => n.id === t.needs);
      expect(needed?.area, t.id).toBe(t.area);
      expect(needed?.needs, t.id).toBeNull();
    }
  });

  it("never quotes a member back in a question about how they feel", () => {
    for (const t of rubric.topics.filter((t) => t.area === "morale")) expect(t.tailor).toBe(false);
    expect(topic("morale_reason").briefIsEnough).toBe(true);
    expect(topic("morale_team").briefIsEnough).toBe(true);
  });

  it("gives every topic a question that fits on screen, and a description for Claude", () => {
    const max = rubric.settings.maxQuestionChars;
    for (const t of rubric.topics) {
      expect(t.label).not.toBe("");
      expect(t.weight).toBeGreaterThanOrEqual(0.05);
      expect(t.weight).toBeLessThanOrEqual(3);
      expect(t.ask).toMatch(/\?$/);
      expect(t.ask.length).toBeLessThanOrEqual(max);
      if (t.askHardWeek !== null) {
        expect(t.askHardWeek).toMatch(/\?$/);
        expect(t.askHardWeek.length).toBeLessThanOrEqual(max);
      }
      expect(t.rules).not.toBe("");
    }
  });

  it("keeps every setting inside its range", () => {
    for (const [label, spec] of Object.entries(SETTINGS)) {
      const value = rubric.settings[spec.key];
      expect(value, label).toBeGreaterThanOrEqual(spec.min);
      expect(value, label).toBeLessThanOrEqual(spec.max);
      if (spec.whole) expect(Number.isInteger(value), label).toBe(true);
    }
    expect(rubric.settings.noNewQuestionsAfterS).toBeGreaterThanOrEqual(rubric.settings.keysOnlyAfterS);
    expect(rubric.settings.stoppedSilenceS).toBeGreaterThanOrEqual(rubric.settings.showAfterSilenceS);
  });

  it("has the four closing lines", () => {
    expect(Object.keys(rubric.lines).sort()).toEqual(["beforeYouFinish", "closing", "covered", "late"]);
    for (const line of Object.values(rubric.lines)) expect(line.trim()).not.toBe("");
  });

  it("describes every coverage level and mood for Claude", () => {
    for (const level of ["none", "brief", "clear", "declined"]) expect(rubric.coverageLevels).toMatch(new RegExp(`^- ${level}:`, "m"));
    for (const mood of ["neutral", "hard_week", "distress"]) expect(rubric.mood).toMatch(new RegExp(`^- ${mood}:`, "m"));
    expect(rubric.questionStyle).not.toBe("");
  });

  it("never passes on the notes meant for people", () => {
    const parsed = JSON.stringify(rubric);
    expect(parsed).not.toContain("<!--");
    expect(parsed).not.toContain("Claude never sees them");
  });
});

describe("pacingFrom", () => {
  it("turns the settings' seconds into milliseconds for the browser", () => {
    const settings = {
      ...coachRubric().settings,
      showAfterSilenceS: 2.5,
      stoppedSilenceS: 6,
      minQuestionS: 20,
      minWordsPerQuestion: 25,
      firstFollowUpAfterS: 45,
    };
    expect(pacingFrom(settings)).toEqual({
      showAfterSilenceMs: 2500,
      stoppedSilenceMs: 6000,
      minQuestionMs: 20_000,
      minWordsPerQuestion: 25,
      firstFollowUpAfterMs: 45_000,
    });
  });
});

describe("parseCoachRubric accepts the edits the file invites", () => {
  it("takes a new weight, setting and question", () => {
    let edited = inTopic("activity_more", /^- Weight:.*$/m, "- Weight: 0.25");
    edited = setting("Most follow-up questions", "3", edited);
    edited = inTopic("excellence_impact", /^- Ask:.*$/m, "- Ask: Who noticed the difference?", edited);
    const parsed = parseCoachRubric(edited);
    expect(parsed.topics.find((t) => t.id === "activity_more")?.weight).toBe(0.25);
    expect(parsed.settings.maxFollowUps).toBe(3);
    expect(parsed.topics.find((t) => t.id === "excellence_impact")?.ask).toBe("Who noticed the difference?");
  });

  it("takes a new topic", () => {
    const edited = editPart("## Question style\n", (part) =>
      [
        "\n### activity_help: Help from others",
        "- Area: activity",
        "- Weight: 0.3",
        "- Needs: activity_work",
        "- Ask: Who did you work with on that?",
        "",
        "Clear when they name who they worked with (\"settled it with Siti from Finance\").",
        part,
      ].join("\n"),
    );
    const added = parseCoachRubric(edited).topics.at(-1);
    expect(added).toMatchObject({ id: "activity_help", area: "activity", weight: 0.3, key: false, needs: "activity_work", tailor: true });
  });

  it("reads line and setting labels in any case", () => {
    let edited = inTopic("morale_feeling", /^- Tailor: no$/m, "- tailor: No");
    edited = inSection("Settings", /^- Most follow-up questions:/m, "- most follow-up questions:", edited);
    expect(parseCoachRubric(edited)).toEqual(coachRubric());
  });
});

describe("parseCoachRubric refuses a broken file, saying what is wrong", () => {
  const max = coachRubric().settings.maxQuestionChars;
  const sections = "Opening question, Coverage levels, Reading the mood, Topics, Question style, Closing lines, Settings";
  const topicLines = "Area, Weight, Key topic, Needs, Ask, Ask in a hard week, Tailor, Brief is enough";

  it.each<[string, () => string, string[]]>([
    // Sections
    [
      "a section renamed",
      () => inSection("Question style", "## Question style", "## Question styles"),
      [`"## Question styles" isn't a section this file has. The sections are: ${sections}.`, 'The section "## Question style" is missing.'],
    ],
    ["a section deleted", () => editPart("## Reading the mood\n", () => ""), ['The section "## Reading the mood" is missing.']],
    ["an empty section", () => editPart("## Opening question\n", () => "\n## Opening question\n"), ['The section "## Opening question" is empty.']],
    [
      "a section written twice",
      () => `${coachFile}\n## Question style\n\n- Keep it short.\n`,
      ['The section "## Question style" appears twice.'],
    ],
    [
      "a note that is never closed",
      () => inSection("Settings", /^/, "<!-- check these numbers with Wei Ling\n"),
      ['A note starting "<!--" is never closed with "-->", so everything after it would be hidden.'],
    ],
    [
      "an opening question over 300 characters",
      () => inSection("Opening question", /^(## Opening question\n\n).*$/m, `$1${"Talk me through your week lah. ".repeat(10)}`),
      ["The opening question is over 300 characters."],
    ],
    [
      "a coverage level not described",
      () => inSection("Coverage levels", /^- declined:.*\n/m, ""),
      ['"## Coverage levels" must describe the level "declined" on a line starting "- declined:".'],
    ],
    [
      "a mood not described",
      () => inSection("Reading the mood", /^- hard_week:/m, "- hard week:"),
      ['"## Reading the mood" must describe "hard_week" on a line starting "- hard_week:".'],
    ],

    // Topics
    [
      "text before the first topic",
      () => inSection("Topics", /^(## Topics\n)/, "$1\nTopics are asked in this order.\n"),
      ['Under "## Topics", every topic needs its own "### <id>: <label>" heading; there is text before the first one.'],
    ],
    [
      "a topic heading with a label for an id",
      () => inTopic("activity_more", /^### activity_more:/, "### Activity more:"),
      [
        '"### Activity more: The rest of the week" should look like "### activity_work: What you worked on" (an id in lower case and underscores, a colon, then a label).',
      ],
    ],
    [
      "a topic heading with no label",
      () => inTopic("activity_more", /^### activity_more:.*$/m, "### activity_more"),
      [
        '"### activity_more" should look like "### activity_work: What you worked on" (an id in lower case and underscores, a colon, then a label).',
      ],
    ],
    [
      "a topic id used twice",
      () => inTopic("morale_team", /^### morale_team:/, "### morale_reason:"),
      ['The topic id "morale_reason" is used twice.'],
    ],
    [
      "an unknown topic line",
      () => inTopic("activity_more", /^(- Area:.*)$/m, "$1\n- Priority: high"),
      [`In topic activity_more, "Priority" isn't a topic line. They are: ${topicLines}.`],
    ],
    [
      "a topic line written twice",
      () => inTopic("activity_more", /^(- Weight:.*)$/m, "$1\n- Weight: 0.5"),
      ['In topic activity_more, "Weight" is written twice.'],
    ],
    ["a topic without its Area", () => inTopic("activity_more", /^- Area:.*\n/m, ""), ['In topic activity_more, "- Area:" is missing.']],
    [
      "a topic in an unknown area",
      () => inTopic("activity_more", /^- Area:.*$/m, "- Area: mood"),
      ['In topic activity_more, the area must be activity, excellence, morale, not "mood".'],
    ],
    ["a topic without its Weight", () => inTopic("activity_more", /^- Weight:.*\n/m, ""), ['In topic activity_more, "- Weight:" is missing.']],
    [
      "a weight over 3",
      () => inTopic("activity_more", /^- Weight:.*$/m, "- Weight: 5"),
      ['In topic activity_more, the weight must be a number from 0.05 to 3, not "5".'],
    ],
    [
      "a weight under 0.05",
      () => inTopic("activity_more", /^- Weight:.*$/m, "- Weight: 0.01"),
      ['In topic activity_more, the weight must be a number from 0.05 to 3, not "0.01".'],
    ],
    [
      "a weight in words",
      () => inTopic("activity_more", /^- Weight:.*$/m, "- Weight: high"),
      ['In topic activity_more, the weight must be a number from 0.05 to 3, not "high".'],
    ],
    [
      "a weight with a decimal comma",
      () => inTopic("activity_more", /^- Weight:.*$/m, "- Weight: 0,4"),
      ['In topic activity_more, the weight must be a number from 0.05 to 3, not "0,4".'],
    ],
    ["a topic without its Ask", () => inTopic("activity_more", /^- Ask:.*\n/m, ""), ['In topic activity_more, "- Ask:" is missing.']],
    [
      'an Ask without "?"',
      () => inTopic("activity_more", /^(- Ask:.*)\?$/m, "$1."),
      ['In topic activity_more, the "Ask" question must end with "?".'],
    ],
    [
      "an Ask over the length limit",
      () => inTopic("activity_more", /^- Ask:.*$/m, `- Ask: ${"x".repeat(max)}?`),
      [`In topic activity_more, the "Ask" question is over ${max} characters.`],
    ],
    [
      'an "Ask in a hard week" without "?"',
      () => inTopic("activity_outcome", /^(- Ask in a hard week:.*)\?$/m, "$1"),
      ['In topic activity_outcome, the "Ask in a hard week" question must end with "?".'],
    ],
    [
      "Tailor not yes or no",
      () => inTopic("morale_feeling", /^- Tailor:.*$/m, "- Tailor: never"),
      ['In topic morale_feeling, "Tailor" must be yes or no, not "never".'],
    ],
    [
      "Brief is enough not yes or no",
      () => inTopic("morale_reason", /^- Brief is enough:.*$/m, "- Brief is enough: can"),
      ['In topic morale_reason, "Brief is enough" must be yes or no, not "can".'],
    ],
    [
      "a topic with no description",
      () => inTopic("activity_more", /\n\n[\s\S]*$/, "\n"),
      ["In topic activity_more, describe after a blank line when the topic counts as covered."],
    ],
    [
      "Needs naming an unknown topic",
      () => inTopic("activity_more", /^- Needs:.*$/m, "- Needs: activity_works"),
      ['In topic activity_more, "Needs: activity_works" isn\'t a topic.'],
    ],
    [
      "Needs naming the topic itself",
      () => inTopic("activity_more", /^- Needs:.*$/m, "- Needs: activity_more"),
      ["Topic activity_more can't need itself."],
    ],
    [
      "Needs naming a topic that needs another",
      () => inTopic("activity_more", /^- Needs:.*$/m, "- Needs: activity_outcome"),
      ['In topic activity_more, "activity_outcome" needs another topic itself; a topic can only need one that needs nothing.'],
    ],
    [
      "two key topics in an area",
      () => inTopic("activity_more", /^(- Weight:.*)$/m, "$1\n- Key topic: yes"),
      ['The area "activity" needs exactly one "Key topic: yes", not 2.'],
    ],
    [
      "no key topic in an area",
      () => inTopic("excellence_moment", /^- Key topic: yes$/m, "- Key topic: no"),
      ['The area "excellence" needs exactly one "Key topic: yes", not 0.'],
    ],
    [
      "a key topic that needs another",
      () => inTopic("activity_work", /^- Key topic: yes$/m, "- Key topic: no", inTopic("activity_outcome", /^(- Weight:.*)$/m, "$1\n- Key topic: yes")),
      ["The key topic activity_outcome can't need another topic."],
    ],
    [
      "no topic for an area",
      () =>
        editPart("### morale_team:", () => "", editPart("### morale_reason:", () => "", editPart("### morale_feeling:", () => ""))),
      ['There is no topic for the area "morale".'],
    ],

    // Settings
    [
      "a setting's label misspelt",
      () => inSection("Settings", /^- Most follow-up questions:/m, "- Most follow up questions:"),
      ['"Most follow up questions" isn\'t a setting. Check the spelling against README.md.', 'The setting "Most follow-up questions" is missing.'],
    ],
    ["a setting deleted", () => inSection("Settings", /^- Brief answer counts as:.*\n/m, ""), ['The setting "Brief answer counts as" is missing.']],
    [
      "a setting written twice",
      () => inSection("Settings", /^(- Most follow-ups per area:.*)$/m, "$1\n- Most follow-ups per area: 3"),
      ['The setting "Most follow-ups per area" is written twice.'],
    ],
    [
      "a setting over its range",
      () => setting("Most follow-up questions", "12"),
      ['The setting "Most follow-up questions" must be from 0 to 10, not 12.'],
    ],
    [
      "a setting under its range",
      () => setting("Silence before showing a new question (seconds)", "0.2"),
      ['The setting "Silence before showing a new question (seconds)" must be from 0.5 to 10, not 0.2.'],
    ],
    [
      "a setting that isn't a plain number",
      () => setting("Brief answer counts as", "60%"),
      ['The setting "Brief answer counts as" must be a plain number, like 2 or 0.5, not "60%".'],
    ],
    [
      "a setting with its unit written in",
      () => setting("No follow-up before (seconds)", "45s"),
      ['The setting "No follow-up before (seconds)" must be a plain number, like 2 or 0.5, not "45s".'],
    ],
    [
      "half a question per area",
      () => setting("Most follow-ups per area", "2.5"),
      ['The setting "Most follow-ups per area" must be a whole number.'],
    ],
    [
      "only key topics after questions have stopped",
      () => setting("No new questions after (seconds)", "200", setting("Only key topics after (seconds)", "300")),
      ['"No new questions after" must not be earlier than "Only key topics after".'],
    ],
    [
      "a stop shorter than the pause before a question",
      () => setting("Silence that means they have stopped (seconds)", "3", setting("Silence before showing a new question (seconds)", "5")),
      ['"Silence that means they have stopped" must not be shorter than "Silence before showing a new question".'],
    ],

    // Closing lines
    ["a closing line deleted", () => inSection("Closing lines", /^- Time is nearly up:.*\n/m, ""), ['The closing line "Time is nearly up" is missing.']],
    [
      "a closing line renamed",
      () => inSection("Closing lines", /^- After a hard moment:/m, "- After a difficult moment:"),
      [
        '"After a difficult moment" isn\'t one of the closing lines: Everything covered, Time is nearly up, After a hard moment, Before you finish.',
        'The closing line "After a hard moment" is missing.',
      ],
    ],
    ["an empty closing line", () => inSection("Closing lines", /^- Before you finish:.*$/m, "- Before you finish:"), ['The closing line "Before you finish" is empty.']],
    [
      "a closing line over 300 characters",
      () => inSection("Closing lines", /^- Time is nearly up:.*$/m, `- Time is nearly up: ${"Whenever you're ready lah. ".repeat(12)}`),
      ['The closing line "Time is nearly up" is over 300 characters.'],
    ],
  ])("%s", (_label, edit, problems) => {
    const error = refused(edit());
    expect(error.problems).toEqual(problems);
    expect(error.message).toContain("rubrics/coach.md can't be used:");
    for (const problem of problems) expect(error.message).toContain(`- ${problem}`);
  });

  it("asks for a blank line when a description runs straight on from the topic's lines", () => {
    const problems = refused(inTopic("activity_more", /^(- Ask:.*)\n\n/m, "$1\n")).problems;
    expect(problems.length).toBeGreaterThan(0);
    for (const problem of problems) {
      expect(problem).toMatch(
        /^In topic activity_more, (".*" isn't one of the topic's lines; leave a blank line before the description\.|describe after a blank line when the topic counts as covered\.)$/,
      );
    }
  });

  it("lists every problem at once, so one pull request can fix them all", () => {
    const edited = setting("Most follow-up questions", "12", inTopic("activity_more", /^- Weight:.*$/m, "- Weight: high"));
    expect(refused(edited).problems).toEqual([
      'The setting "Most follow-up questions" must be from 0 to 10, not 12.',
      'In topic activity_more, the weight must be a number from 0.05 to 3, not "high".',
    ]);
  });
});
