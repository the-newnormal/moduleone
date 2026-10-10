// The grading rubric, read from rubrics/grading.md: the file people edit to change how check-ins
// are scored. parseGradingRubric checks the file's shape (a test runs it on every pull request, and
// the server refuses to grade with a broken file rather than send Claude half a rubric); prompt.ts
// builds the grader's instructions from the result.

import { QUESTIONS, type QuestionId } from "@/lib/checkin/week";
import gradingFile from "../../../rubrics/grading.md";
import { keyValue, RubricError, splitSections, withoutNotes } from "../rubrics/markdown";
import { CATEGORIES, type Category, type Score } from "./types";

export const GRADING_RUBRIC_FILE = "rubrics/grading.md";

export type Dimension = {
  // "Activity", as the file names it.
  name: string;
  // The line(s) before the levels: what the dimension is about.
  intro: string;
  levels: Record<Score, string>;
  // Anything after the levels.
  notes: string;
};

export type GradingRubric = {
  dimensions: Record<QuestionId, Dimension>;
  themes: { intro: string; meanings: Record<Category, string>; notes: string };
  review: string;
  // Every other "## " section: extra guidance sent as written.
  guidance: { heading: string; body: string }[];
  // The order the file puts things in, which the prompt keeps: "scoring" where the first of the
  // three dimensions is, "themes", "review", and each guidance section by its index.
  layout: ("scoring" | "themes" | "review" | number)[];
};

const DIMENSION_HEADINGS: Record<QuestionId, string> = { activity: "Activity", excellence: "Excellence", morale: "Morale" };
const SCORES = [1, 2, 3, 4, 5] as const;
const LEVEL_LINE = /^-\s*([1-5])\s*[:=.)]\s*(.*)$/;
// A line that looks like it was meant as a level but isn't one ("- 6: ...", "- 3 Neutral").
const LEVEL_ISH = /^-\s*\d/;
const MAX_TEXT = 4000;

export function parseGradingRubric(source: string, file = GRADING_RUBRIC_FILE): GradingRubric {
  const problems: string[] = [];
  const { text, unclosed } = withoutNotes(source);
  if (unclosed) problems.push('A note starting "<!--" is never closed with "-->", so everything after it would be hidden.');

  const { sections } = splitSections(text, 2);
  const byHeading = new Map<string, string>();
  for (const section of sections) {
    const key = section.heading.toLowerCase();
    if (byHeading.has(key)) problems.push(`The section "## ${section.heading}" appears twice.`);
    byHeading.set(key, section.body);
  }

  const dimensions = {} as Record<QuestionId, Dimension>;
  for (const { id } of QUESTIONS) {
    const name = DIMENSION_HEADINGS[id];
    const body = byHeading.get(name.toLowerCase());
    if (body === undefined) {
      problems.push(`The section "## ${name}" is missing.`);
      continue;
    }
    dimensions[id] = parseDimension(name, body, problems);
  }

  const themesBody = byHeading.get("themes");
  const themes = themesBody === undefined ? null : parseThemes(themesBody, problems);
  if (themesBody === undefined) problems.push('The section "## Themes" is missing.');

  const review = byHeading.get("review");
  if (review === undefined) problems.push('The section "## Review" is missing.');
  else if (!review) problems.push('The section "## Review" is empty.');

  const fixed = new Set(["activity", "excellence", "morale", "themes", "review"]);
  const guidance = sections.filter((s) => !fixed.has(s.heading.toLowerCase()));
  const layout: GradingRubric["layout"] = [];
  for (const section of sections) {
    const key = section.heading.toLowerCase();
    if (key === "activity" || key === "excellence" || key === "morale") {
      if (!layout.includes("scoring")) layout.push("scoring");
    } else if (key === "themes" || key === "review") {
      if (!layout.includes(key)) layout.push(key);
    } else {
      layout.push(guidance.indexOf(section));
    }
  }
  for (const section of guidance) {
    if (!section.heading) problems.push('A "##" heading has no name.');
    if (!section.body) problems.push(`The section "## ${section.heading}" is empty.`);
    if (section.body.length > MAX_TEXT) problems.push(`The section "## ${section.heading}" is over ${MAX_TEXT} characters.`);
  }

  if (problems.length > 0 || !themes || review === undefined) throw new RubricError(file, problems);
  return { dimensions, themes, review, guidance, layout };
}

function parseDimension(name: string, body: string, problems: string[]): Dimension {
  const intro: string[] = [];
  const notes: string[] = [];
  const levels: Partial<Record<Score, string>> = {};
  let phase: "intro" | "levels" | "notes" = "intro";
  for (const line of body.split("\n")) {
    const level = LEVEL_LINE.exec(line.trim());
    if (level) {
      if (phase === "notes") problems.push(`In "## ${name}", the levels must be written together, one after another.`);
      phase = "levels";
      const score = Number(level[1]) as Score;
      const wording = level[2].trim();
      if (levels[score] !== undefined) problems.push(`In "## ${name}", level ${score} is written twice.`);
      if (!wording) problems.push(`In "## ${name}", level ${score} has no wording.`);
      levels[score] = wording;
      continue;
    }
    if (LEVEL_ISH.test(line.trim())) {
      problems.push(`In "## ${name}", "${line.trim().slice(0, 40)}" isn't a level: write levels as "- 1: ..." to "- 5: ...".`);
      continue;
    }
    if (phase === "levels" && line.trim()) phase = "notes";
    (phase === "intro" ? intro : notes).push(line);
  }
  for (const score of SCORES) {
    if (levels[score] === undefined) problems.push(`In "## ${name}", level ${score} is missing.`);
  }
  const introText = intro.join("\n").trim();
  if (!introText) problems.push(`In "## ${name}", say what it is about on the line before the levels.`);
  return { name, intro: introText, levels: levels as Record<Score, string>, notes: notes.join("\n").trim() };
}

function parseThemes(body: string, problems: string[]): GradingRubric["themes"] {
  const intro: string[] = [];
  const notes: string[] = [];
  const meanings: Partial<Record<Category, string>> = {};
  let seenList = false;
  for (const line of body.split("\n")) {
    const pair = keyValue(line);
    if (pair) {
      seenList = true;
      const [id, meaning] = pair;
      if (!(CATEGORIES as readonly string[]).includes(id)) {
        problems.push(`"${id}" isn't one of the themes: the themes are ${CATEGORIES.join(", ")} (the names can't change).`);
      } else if (meanings[id as Category] !== undefined) {
        problems.push(`The theme "${id}" is described twice.`);
      } else if (!meaning) {
        problems.push(`The theme "${id}" has no description.`);
      } else {
        meanings[id as Category] = meaning;
      }
      continue;
    }
    (seenList ? notes : intro).push(line);
  }
  for (const id of CATEGORIES) {
    if (meanings[id] === undefined && !problems.some((p) => p.includes(`"${id}"`))) {
      problems.push(`The theme "${id}" is missing from "## Themes".`);
    }
  }
  return { intro: intro.join("\n").trim(), meanings: meanings as Record<Category, string>, notes: notes.join("\n").trim() };
}

// The rubric the grader uses, read once when the server starts. A broken file stops grading with a
// clear error (process.ts records it and retries later) instead of grading with half a rubric; the
// rubric test catches it before that, on the pull request.
let loaded: GradingRubric | null = null;
export function gradingRubric(): GradingRubric {
  return (loaded ??= parseGradingRubric(gradingFile));
}
