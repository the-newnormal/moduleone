import { describe, expect, it } from "vitest";
import gradingFile from "../../../rubrics/grading.md";
import { OUTSIDE_SECTIONS, RubricError, withoutNotes } from "../rubrics/markdown";
import { gradingRubric, parseGradingRubric } from "./rubric";
import { CATEGORIES } from "./types";

// rubrics/grading.md is edited by people on GitHub. This test runs on every pull request: the real
// file must parse, and each mistake an editor might make must be refused with a message they can act
// on. The broken versions are the real file with one edit, made by the structure (headings, level
// numbers, theme names) rather than the wording, so rewording the rubric never breaks this test.

// Rewrites one "## " section of the file, from its heading up to the next "## " heading. Fails if
// the section is gone or the edit changed nothing, so no test can pass by editing nothing.
function editSection(heading: string, change: (section: string) => string, source: string = gradingFile): string {
  const start = source.indexOf(`\n## ${heading}\n`);
  if (start < 0) throw new Error(`rubrics/grading.md has no "## ${heading}" section any more; update this test`);
  const next = source.indexOf("\n## ", start + 1);
  const end = next < 0 ? source.length : next;
  const section = source.slice(start, end);
  const changed = change(section);
  if (changed === section) throw new Error(`The edit to "## ${heading}" changed nothing; update this test`);
  return source.slice(0, start) + changed + source.slice(end);
}

const replaceIn = (heading: string, pattern: RegExp | string, replacement: string, source?: string) =>
  editSection(heading, (section) => section.replace(pattern, replacement), source);

function refused(source: string): RubricError {
  let error: unknown;
  try {
    parseGradingRubric(source);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(RubricError);
  return error as RubricError;
}

describe("rubrics/grading.md", () => {
  const rubric = gradingRubric();

  it("parses, and is read once", () => {
    expect(gradingRubric()).toBe(rubric);
    expect(parseGradingRubric(gradingFile)).toEqual(rubric);
  });

  it("has all five levels for each dimension, each with wording", () => {
    expect(Object.keys(rubric.dimensions)).toEqual(["activity", "excellence", "morale"]);
    for (const [id, name] of [["activity", "Activity"], ["excellence", "Excellence"], ["morale", "Morale"]] as const) {
      const dimension = rubric.dimensions[id];
      expect(dimension.name).toBe(name);
      expect(dimension.intro).not.toBe("");
      expect(Object.keys(dimension.levels)).toEqual(["1", "2", "3", "4", "5"]);
      for (const wording of Object.values(dimension.levels)) expect(wording.trim()).not.toBe("");
    }
  });

  it("describes all five themes, by the names the database accepts", () => {
    expect(Object.keys(rubric.themes.meanings).sort()).toEqual([...CATEGORIES].sort());
    for (const meaning of Object.values(rubric.themes.meanings)) expect(meaning.trim()).not.toBe("");
  });

  it("has review guidance", () => {
    expect(rubric.review.trim()).not.toBe("");
  });

  it("lays the sections out in the order the file has them", () => {
    // Where each part of the layout starts in the file: the prompt keeps this order.
    const { text } = withoutNotes(gradingFile);
    const at = (heading: string) => text.search(new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "mi"));
    const positions = rubric.layout.map((part) => {
      if (part === "scoring") return Math.min(at("Activity"), at("Excellence"), at("Morale"));
      if (part === "themes") return at("Themes");
      if (part === "review") return at("Review");
      return at(rubric.guidance[part].heading);
    });
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // Every part exactly once.
    expect(rubric.layout.filter((p) => typeof p === "string").sort()).toEqual(["review", "scoring", "themes"]);
    expect(rubric.layout.filter((p) => typeof p === "number")).toEqual(rubric.guidance.map((_, i) => i));
  });

  it("never passes on the notes meant for people", () => {
    const parsed = JSON.stringify(rubric);
    expect(parsed).not.toContain("<!--");
    expect(parsed).not.toContain("-->");
    expect(parsed).not.toContain("Claude never sees them");
  });
});

describe("parseGradingRubric accepts the edits the file invites", () => {
  it("takes new wording for a level", () => {
    const edited = replaceIn("Morale", /^- 3:.*$/m, "- 3: Neither up nor down, or ok lah.");
    expect(parseGradingRubric(edited).dimensions.morale.levels[3]).toBe("Neither up nor down, or ok lah.");
  });

  it("sends a new section as guidance, where it is placed", () => {
    const edited = editSection("Themes", (section) => `\n## Examples\n\nA member who says "settled the Jurong vendor onboarding" has described specific work.\n${section}`);
    const parsed = parseGradingRubric(edited);
    const examples = parsed.guidance.findIndex((g) => g.heading === "Examples");
    expect(parsed.guidance[examples].body).toContain("Jurong vendor onboarding");
    expect(parsed.layout.indexOf(examples)).toBe(parsed.layout.indexOf("themes") - 1);
  });

  it("keeps a moved section where it was moved to", () => {
    const themes = /\n## Themes\n[\s\S]*?(?=\n## )/.exec(gradingFile)?.[0];
    expect(themes).toBeDefined();
    const moved = gradingFile.replace(themes!, "").replace("\n## Activity\n", `${themes}\n\n## Activity\n`);
    expect(parseGradingRubric(moved).layout.slice(0, 2)).toEqual(["themes", "scoring"]);
  });

  it("takes levels written with =, . or ), and blank lines between them", () => {
    let edited = replaceIn("Activity", /^- 1:/m, "- 1 =");
    edited = replaceIn("Activity", /^- 2:/m, "- 2.", edited);
    edited = replaceIn("Activity", /^(- 3):(.*)$/m, "\n$1)$2\n", edited);
    const parsed = parseGradingRubric(edited);
    expect(parsed.dimensions.activity.levels).toEqual(gradingRubric().dimensions.activity.levels);
  });

  it("drops a note added inside a section", () => {
    const edited = replaceIn("Review", /$/, "\n<!-- Wei Ming: keep the review short, HQ reads a lot of these -->\n");
    expect(parseGradingRubric(edited).review).toBe(gradingRubric().review);
  });

  it("reads headings in any case, and Windows line endings", () => {
    const edited = replaceIn("Excellence", "## Excellence", "## excellence").replace(/\n/g, "\r\n");
    expect(parseGradingRubric(edited)).toEqual(gradingRubric());
  });
});

describe("parseGradingRubric refuses a broken file, saying what is wrong", () => {
  const bigSection = `\n## Examples\n\n${"Settled the Jurong vendor onboarding, shiok. ".repeat(100)}\n`;

  it.each<[string, () => string, string[]]>([
    [
      "a dimension's heading renamed",
      () => replaceIn("Morale", "## Morale", "## Mood"),
      ['The section "## Morale" is missing.'],
    ],
    ["the Themes section deleted", () => editSection("Themes", () => ""), ['The section "## Themes" is missing.']],
    [
      "words under the title, outside any section",
      () => gradingFile.replace("# Grading rubric\n", "# Grading rubric\n\nBe generous with new joiners.\n"),
      [OUTSIDE_SECTIONS],
    ],
    [
      "a heading typed with one # instead of two",
      () => replaceIn("Singapore English", "## Singapore English", "## Language\n\nPlain English.\n\n# Singapore English"),
      [OUTSIDE_SECTIONS],
    ],
    ["the Review section deleted", () => editSection("Review", () => ""), ['The section "## Review" is missing.']],
    [
      "a section written twice",
      () => `${gradingFile}\n## Singapore English\n\nMore words about Singlish.\n`,
      ['The section "## Singapore English" appears twice.'],
    ],
    ["a level deleted", () => replaceIn("Morale", /^- 3:.*\n/m, ""), ['In "## Morale", level 3 is missing.']],
    [
      "a level numbered twice",
      () => replaceIn("Morale", /^- 4:/m, "- 3:"),
      ['In "## Morale", level 3 is written twice.', 'In "## Morale", level 4 is missing.'],
    ],
    [
      'a "- 6:" level added',
      () => replaceIn("Morale", /^(- 5:.*)$/m, "$1\n- 6: Over the moon, shiok!"),
      ['In "## Morale", "- 6: Over the moon, shiok!" isn\'t a level: write levels as "- 1: ..." to "- 5: ...".'],
    ],
    [
      "a level without its colon",
      () => replaceIn("Activity", /^- 3:.*$/m, "- 3 Some routine work"),
      [
        'In "## Activity", "- 3 Some routine work" isn\'t a level: write levels as "- 1: ..." to "- 5: ...".',
        'In "## Activity", level 3 is missing.',
      ],
    ],
    ["a level with no wording", () => replaceIn("Excellence", /^- 1:.*$/m, "- 1:"), ['In "## Excellence", level 1 has no wording.']],
    [
      "the levels split by a note to Claude",
      () => replaceIn("Activity", /^(- 3:.*)$/m, "$1\n\nThat's the middle of the scale.\n"),
      ['In "## Activity", the levels must be written together, one after another.'],
    ],
    [
      "a dimension with nothing before its levels",
      () => editSection("Excellence", (section) => section.replace(/^(## Excellence\n)[\s\S]*?(?=^- 1)/m, "$1\n")),
      ['In "## Excellence", say what it is about on the line before the levels.'],
    ],
    [
      "a theme renamed",
      () => replaceIn("Themes", /^- wellbeing:/m, "- health:"),
      [
        '"health" isn\'t one of the themes: the themes are delivery, collaboration, growth, wellbeing, blockers (the names can\'t change).',
        'The theme "wellbeing" is missing from "## Themes".',
      ],
    ],
    ["a theme deleted", () => replaceIn("Themes", /^- blockers:.*\n/m, ""), ['The theme "blockers" is missing from "## Themes".']],
    [
      "a theme written twice",
      () => replaceIn("Themes", /^- growth:/m, "- delivery:"),
      ['The theme "delivery" is described twice.', 'The theme "growth" is missing from "## Themes".'],
    ],
    ["a theme with no description", () => replaceIn("Themes", /^- growth:.*$/m, "- growth:"), ['The theme "growth" has no description.']],
    ["an empty Review", () => editSection("Review", () => "\n## Review\n"), ['The section "## Review" is empty.']],
    [
      "a note that is never closed",
      () => editSection("Review", (section) => `\n<!-- check this wording with HQ before Friday\n${section}`),
      ['A note starting "<!--" is never closed with "-->", so everything after it would be hidden.'],
    ],
    [
      "an extra section between the scoring sections",
      () => editSection("Excellence", (section) => `\n## Examples\n\nA member who says "settled the Jurong vendor onboarding" has described specific work.\n${section}`),
      [
        'Keep "## Activity", "## Excellence" and "## Morale" together, one after another: Claude is sent them as one block, so a section between them would be moved.',
      ],
    ],
    [
      "Themes between the scoring sections",
      () => {
        const themes = /\n## Themes\n[\s\S]*?(?=\n## )/.exec(gradingFile)![0];
        return gradingFile.replace(themes, "").replace("\n## Morale\n", `${themes}\n\n## Morale\n`);
      },
      [
        'Keep "## Activity", "## Excellence" and "## Morale" together, one after another: Claude is sent them as one block, so a section between them would be moved.',
      ],
    ],
    [
      "an empty extra section",
      () => editSection("Themes", (section) => `\n## Examples\n${section}`),
      ['The section "## Examples" is empty.'],
    ],
    [
      "an extra section with no name",
      () => editSection("Themes", (section) => `\n## \nSome guidance.\n${section}`),
      ['A "##" heading has no name.'],
    ],
    [
      "an extra section over 4,000 characters",
      () => editSection("Themes", (section) => `${bigSection}${section}`),
      ['The section "## Examples" is over 4000 characters.'],
    ],
  ])("%s", (_label, edit, problems) => {
    const error = refused(edit());
    expect(error.problems).toEqual(problems);
    expect(error.message).toContain("rubrics/grading.md can't be used:");
    for (const problem of problems) expect(error.message).toContain(`- ${problem}`);
  });

  it("lists every problem at once, so one pull request can fix them all", () => {
    const edited = editSection("Review", () => "", replaceIn("Morale", /^- 3:.*\n/m, ""));
    expect(refused(edited).problems).toEqual(['In "## Morale", level 3 is missing.', 'The section "## Review" is missing.']);
  });

  it("names the file it was given", () => {
    expect(() => parseGradingRubric("", "rubrics/grading-draft.md")).toThrow("rubrics/grading-draft.md can't be used:");
  });

  it("refuses an empty file", () => {
    expect(refused("").problems).toEqual([
      'The section "## Activity" is missing.',
      'The section "## Excellence" is missing.',
      'The section "## Morale" is missing.',
      'The section "## Themes" is missing.',
      'The section "## Review" is missing.',
    ]);
  });
});
