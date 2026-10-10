import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decimal, fingerprint, keyValue, RubricError, splitSections, withoutNotes, yesNo } from "./markdown";

describe("withoutNotes", () => {
  it("drops notes for people, however many lines they run to", () => {
    const source = [
      "# Grading rubric",
      "<!--",
      "Ask Mei Ling before changing the levels.",
      "She owns this file lah.",
      "-->",
      "## Activity",
      "What they got done <!-- inline note --> this week.",
    ].join("\n");
    const { text, unclosed } = withoutNotes(source);
    expect(unclosed).toBe(false);
    expect(text).toBe("# Grading rubric\n\n## Activity\nWhat they got done  this week.");
    expect(text).not.toContain("Mei Ling");
  });

  it("makes Windows line endings plain", () => {
    expect(withoutNotes("## Activity\r\nWhat they did.\rDone.").text).toBe("## Activity\nWhat they did.\nDone.");
  });

  it("flags a note that is never closed instead of hiding the rest of the file", () => {
    const { text, unclosed } = withoutNotes("<!-- closed -->\n## Activity\n<!-- check this wording with HQ\n## Review\nTwo sentences.");
    expect(unclosed).toBe(true);
    // Nothing after the open note is cut, so the parsers can still report on the rest.
    expect(text).toContain("## Review\nTwo sentences.");
  });

  it("leaves text with no notes alone", () => {
    expect(withoutNotes("## Morale\n- 3: Neutral or mixed.")).toEqual({ text: "## Morale\n- 3: Neutral or mixed.", unclosed: false });
  });
});

describe("splitSections", () => {
  const file = [
    "# Follow-up question rubric",
    "",
    "## Opening question",
    "",
    "Talk me through your week.   ",
    "",
    "",
    "",
    "## Topics",
    "Text before the first topic.",
    "### activity_work: What you worked on",
    "- Area: activity",
    "",
    "Clear when they name a piece of work.",
    "### morale_feeling: How you feel about the team",
    "- Area: morale",
    "## Settings",
    "- Most follow-up questions: 4",
  ].join("\n");

  it("splits at level 2, keeping level 3 headings in the body", () => {
    const { preamble, sections } = splitSections(file, 2);
    // The "# " title is a higher heading, not text.
    expect(preamble).toBe("");
    expect(sections.map((s) => s.heading)).toEqual(["Opening question", "Topics", "Settings"]);
    // Trimmed, trailing spaces gone and runs of blank lines folded.
    expect(sections[0].body).toBe("Talk me through your week.");
    expect(sections[1].body).toContain("### activity_work: What you worked on");
    expect(sections[1].body).toContain("### morale_feeling: How you feel about the team");
  });

  it("ends a section at a higher heading, which starts no section of its own", () => {
    const { sections } = splitSections(`${file}\n# Appendix\nNot in any section.`, 2);
    expect(sections.map((s) => s.heading)).toEqual(["Opening question", "Topics", "Settings"]);
    expect(sections[2]).toEqual({ heading: "Settings", body: "- Most follow-up questions: 4" });
    expect(JSON.stringify(sections)).not.toContain("Not in any section.");
  });

  it("splits at level 3, with the text before the first heading as the preamble", () => {
    const topics = splitSections(file, 2).sections[1].body;
    const { preamble, sections } = splitSections(topics, 3);
    expect(preamble).toBe("Text before the first topic.");
    expect(sections).toEqual([
      { heading: "activity_work: What you worked on", body: "- Area: activity\n\nClear when they name a piece of work." },
      { heading: "morale_feeling: How you feel about the team", body: "- Area: morale" },
    ]);
  });

  it("ends a level 3 section at a level 2 heading", () => {
    const { sections } = splitSections(file, 3);
    expect(sections.at(-1)).toEqual({ heading: "morale_feeling: How you feel about the team", body: "- Area: morale" });
    expect(JSON.stringify(sections)).not.toContain("Most follow-up questions");
  });

  it("keeps text before any heading as the preamble", () => {
    expect(splitSections("Some words first.\n\n## Review\nTwo sentences.", 2)).toEqual({
      preamble: "Some words first.",
      sections: [{ heading: "Review", body: "Two sentences." }],
    });
  });

  it("needs a space after the hashes for a heading", () => {
    expect(splitSections("##Review\nTwo sentences.", 2)).toEqual({ preamble: "##Review\nTwo sentences.", sections: [] });
  });
});

describe("keyValue", () => {
  it.each([
    ["- Weight: 1.0", ["Weight", "1.0"]],
    ["  - Area:   activity  ", ["Area", "activity"]],
    ["- 1: No example given.", ["1", "No example given."]],
    // Only the first ": " splits, so a value may hold colons of its own.
    ["- Ask: You mentioned the vendor onboarding: where did that get to?", ["Ask", "You mentioned the vendor onboarding: where did that get to?"]],
    ["- Most follow-ups per area: 2", ["Most follow-ups per area", "2"]],
    ["- Tailor:", ["Tailor", ""]],
  ])("reads %j", (line, pair) => {
    expect(keyValue(line)).toEqual(pair);
  });

  it.each([["Weight: 1.0"], ["-Weight: 1.0"], ["- just a bullet point"], [""], ["## Settings"], ["* Weight: 1.0"]])(
    "ignores %j",
    (line) => {
      expect(keyValue(line)).toBeNull();
    },
  );
});

describe("yesNo", () => {
  it.each([
    ["yes", true],
    ["Yes", true],
    [" YES ", true],
    ["no", false],
    ["No", false],
  ])("reads %j as %s", (value, flag) => {
    expect(yesNo(value)).toBe(flag);
  });

  it.each([["y"], ["true"], ["can lah"], [""], ["yes please"]])("rejects %j", (value) => {
    expect(yesNo(value)).toBeNull();
  });
});

describe("decimal", () => {
  it.each([
    ["0.6", 0.6],
    ["5", 5],
    ["2.5", 2.5],
    [" 270 ", 270],
    ["0", 0],
  ])("reads %j as %d", (value, number) => {
    expect(decimal(value)).toBe(number);
  });

  it.each([["five"], ["1e3"], ["-1"], [""], ["  "], [".5"], ["1."], ["1,000"], ["0x10"], ["Infinity"], ["2 seconds"]])(
    "rejects %j",
    (value) => {
      expect(decimal(value)).toBeNull();
    },
  );
});

describe("fingerprint", () => {
  it("is the first 12 hex digits of the text's SHA-256", () => {
    // The standard SHA-256 test vector for "abc".
    expect(fingerprint("abc")).toBe("ba7816bf8f01");
    expect(fingerprint("## Morale")).toBe(createHash("sha256").update("## Morale").digest("hex").slice(0, 12));
  });

  it("is stable, and changes when the text does", () => {
    const rubric = "- 3: Neutral or mixed.";
    expect(fingerprint(rubric)).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprint(rubric)).toBe(fingerprint(rubric));
    expect(fingerprint("- 3: Neutral, or mixed.")).not.toBe(fingerprint(rubric));
    expect(fingerprint(`${rubric}\n`)).not.toBe(fingerprint(rubric));
  });
});

describe("RubricError", () => {
  it("names the file and lists every problem on its own line", () => {
    const error = new RubricError("rubrics/grading.md", ['The section "## Review" is missing.', 'In "## Morale", level 3 is missing.']);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("RubricError");
    expect(error.problems).toEqual(['The section "## Review" is missing.', 'In "## Morale", level 3 is missing.']);
    expect(error.message).toBe(
      'rubrics/grading.md can\'t be used:\n- The section "## Review" is missing.\n- In "## Morale", level 3 is missing.',
    );
  });
});
