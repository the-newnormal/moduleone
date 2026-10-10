// The follow-up question rubric, read from rubrics/coach.md: the file people edit to change what the
// live check-in asks and when. parseCoachRubric checks the file's shape and every number's range (a
// test runs it on every pull request); a broken file turns the live coach off, and the recorder
// falls back to the three fixed questions, rather than coaching with half a rubric.

import coachFile from "../../../rubrics/coach.md";
import { decimal, keyValue, OUTSIDE_SECTIONS, RubricError, splitSections, withoutNotes, yesNo } from "../rubrics/markdown";
import { AREAS, type Area, type CoachLines, type CoachRubric, type CoachSettings, type Pacing, type Topic } from "./types";

export const COACH_RUBRIC_FILE = "rubrics/coach.md";

const SECTIONS = ["Opening question", "Coverage levels", "Reading the mood", "Topics", "Question style", "Closing lines", "Settings"];

type SettingSpec = { key: keyof CoachSettings; min: number; max: number; whole?: boolean };

// Each setting's label in the file, and the range it must stay in.
export const SETTINGS: Record<string, SettingSpec> = {
  "Most follow-up questions": { key: "maxFollowUps", min: 0, max: 10, whole: true },
  "Most follow-ups per area": { key: "maxPerArea", min: 1, max: 5, whole: true },
  "Brief answer counts as": { key: "briefNeed", min: 0, max: 1 },
  "Bonus for an untouched area": { key: "untouchedBonus", min: 0, max: 3 },
  "Bonus for the area they are talking about": { key: "flowBonus", min: 0, max: 3 },
  "Claude's choice may score lower by up to": { key: "tailorSlack", min: 0, max: 3 },
  "Least score worth asking": { key: "minScore", min: 0, max: 5 },
  "Least score worth asking once every area is touched": { key: "minScoreAfterKeys", min: 0, max: 5 },
  "Least score worth asking in a hard week": { key: "minScoreHardWeek", min: 0, max: 5 },
  "Only key topics after (seconds)": { key: "keysOnlyAfterS", min: 30, max: 600 },
  "No new questions after (seconds)": { key: "noNewQuestionsAfterS", min: 30, max: 600 },
  "Silence before showing a new question (seconds)": { key: "showAfterSilenceS", min: 0.5, max: 10 },
  "Silence that means they have stopped (seconds)": { key: "stoppedSilenceS", min: 1, max: 30 },
  "Least time a question stays up (seconds)": { key: "minQuestionS", min: 0, max: 120 },
  "Least words said to a question before the next": { key: "minWordsPerQuestion", min: 0, max: 200, whole: true },
  "No follow-up before (seconds)": { key: "firstFollowUpAfterS", min: 0, max: 300 },
  "Longest question (characters)": { key: "maxQuestionChars", min: 40, max: 300, whole: true },
};

const LINES: Record<string, keyof CoachLines> = {
  "Everything covered": "covered",
  "Time is nearly up": "late",
  "After a hard moment": "closing",
  "Before you finish": "beforeYouFinish",
};

const TOPIC_KEYS = ["Area", "Weight", "Key topic", "Needs", "Ask", "Ask in a hard week", "Tailor", "Brief is enough"];
const TOPIC_HEADING = /^([a-z][a-z0-9_]{1,39}):\s*(.+)$/;
const MAX_LINE = 300;

export function parseCoachRubric(source: string, file = COACH_RUBRIC_FILE): CoachRubric {
  const problems: string[] = [];
  const { text, unclosed } = withoutNotes(source);
  if (unclosed) problems.push('A note starting "<!--" is never closed with "-->", so everything after it would be hidden.');

  const { preamble, sections } = splitSections(text, 2);
  if (preamble) problems.push(OUTSIDE_SECTIONS);
  const byHeading = new Map<string, string>();
  for (const section of sections) {
    const known = SECTIONS.find((name) => name.toLowerCase() === section.heading.toLowerCase());
    if (!known) {
      problems.push(`"## ${section.heading}" isn't a section this file has. The sections are: ${SECTIONS.join(", ")}.`);
    } else if (byHeading.has(known)) {
      problems.push(`The section "## ${known}" appears twice.`);
    } else {
      byHeading.set(known, section.body);
    }
  }
  for (const name of SECTIONS) {
    if (!byHeading.has(name)) problems.push(`The section "## ${name}" is missing.`);
    else if (!byHeading.get(name)) problems.push(`The section "## ${name}" is empty.`);
  }

  const opening = (byHeading.get("Opening question") ?? "").replace(/\s+/g, " ").trim();
  if (opening.length > MAX_LINE) problems.push(`The opening question is over ${MAX_LINE} characters.`);

  const coverageLevels = byHeading.get("Coverage levels") ?? "";
  for (const level of ["none", "brief", "clear", "declined"]) {
    if (coverageLevels && !new RegExp(`^-\\s*${level}:`, "m").test(coverageLevels)) {
      problems.push(`"## Coverage levels" must describe the level "${level}" on a line starting "- ${level}:".`);
    }
  }
  const mood = byHeading.get("Reading the mood") ?? "";
  for (const tone of ["neutral", "hard_week", "distress"]) {
    if (mood && !new RegExp(`^-\\s*${tone}:`, "m").test(mood)) {
      problems.push(`"## Reading the mood" must describe "${tone}" on a line starting "- ${tone}:".`);
    }
  }

  const settings = parseSettings(byHeading.get("Settings") ?? "", problems);
  const topics = parseTopics(byHeading.get("Topics") ?? "", settings?.maxQuestionChars ?? MAX_LINE, problems);
  const lines = parseLines(byHeading.get("Closing lines") ?? "", problems);

  if (problems.length > 0 || !settings || !lines) throw new RubricError(file, problems);
  return {
    opening,
    coverageLevels,
    mood,
    topics,
    questionStyle: byHeading.get("Question style") ?? "",
    lines,
    settings,
  };
}

function parseSettings(body: string, problems: string[]): CoachSettings | null {
  const values: Partial<CoachSettings> = {};
  for (const line of body.split("\n")) {
    const pair = keyValue(line);
    if (!pair) continue;
    const [label, raw] = pair;
    const spec = Object.entries(SETTINGS).find(([name]) => name.toLowerCase() === label.toLowerCase())?.[1];
    if (!spec) {
      problems.push(`"${label}" isn't a setting. Check the spelling against README.md.`);
      continue;
    }
    if (values[spec.key] !== undefined) problems.push(`The setting "${label}" is written twice.`);
    const value = decimal(raw);
    if (value === null) problems.push(`The setting "${label}" must be a plain number, like 2 or 0.5, not "${raw}".`);
    else if (value < spec.min || value > spec.max) problems.push(`The setting "${label}" must be from ${spec.min} to ${spec.max}, not ${value}.`);
    else if (spec.whole && !Number.isInteger(value)) problems.push(`The setting "${label}" must be a whole number.`);
    else values[spec.key] = value;
  }
  for (const [label, spec] of Object.entries(SETTINGS)) {
    if (values[spec.key] === undefined && !problems.some((p) => p.includes(`"${label}"`))) {
      problems.push(`The setting "${label}" is missing.`);
    }
  }
  const s = values as CoachSettings;
  if (s.keysOnlyAfterS !== undefined && s.noNewQuestionsAfterS !== undefined && s.noNewQuestionsAfterS < s.keysOnlyAfterS) {
    problems.push('"No new questions after" must not be earlier than "Only key topics after".');
  }
  if (s.showAfterSilenceS !== undefined && s.stoppedSilenceS !== undefined && s.stoppedSilenceS < s.showAfterSilenceS) {
    problems.push('"Silence that means they have stopped" must not be shorter than "Silence before showing a new question".');
  }
  return Object.keys(SETTINGS).every((label) => values[SETTINGS[label].key] !== undefined) ? s : null;
}

function parseTopics(body: string, maxChars: number, problems: string[]): Topic[] {
  const { preamble, sections } = splitSections(body, 3);
  if (preamble) problems.push('Under "## Topics", every topic needs its own "### <id>: <label>" heading; there is text before the first one.');
  const topics: Topic[] = [];
  for (const section of sections) {
    const heading = TOPIC_HEADING.exec(section.heading);
    if (!heading) {
      problems.push(`"### ${section.heading}" should look like "### activity_work: What you worked on" (an id in lower case and underscores, a colon, then a label).`);
      continue;
    }
    const [, id, label] = heading;
    const where = `In topic ${id}`;
    const lines = section.body.split("\n");
    const fields = new Map<string, string>();
    let i = 0;
    for (; i < lines.length && lines[i].trim(); i++) {
      const pair = keyValue(lines[i]);
      if (!pair) {
        problems.push(`${where}, "${lines[i].trim().slice(0, 40)}" isn't one of the topic's lines; leave a blank line before the description.`);
        continue;
      }
      const name = TOPIC_KEYS.find((k) => k.toLowerCase() === pair[0].toLowerCase());
      if (!name) problems.push(`${where}, "${pair[0]}" isn't a topic line. They are: ${TOPIC_KEYS.join(", ")}.`);
      else if (fields.has(name)) problems.push(`${where}, "${name}" is written twice.`);
      else fields.set(name, pair[1]);
    }
    const rules = lines.slice(i).join("\n").trim();

    const area = fields.get("Area")?.toLowerCase();
    if (!area) problems.push(`${where}, "- Area:" is missing.`);
    else if (!(AREAS as readonly string[]).includes(area)) problems.push(`${where}, the area must be ${AREAS.join(", ")}, not "${area}".`);
    const weightText = fields.get("Weight");
    const weight = weightText === undefined ? null : decimal(weightText);
    if (weightText === undefined) problems.push(`${where}, "- Weight:" is missing.`);
    else if (weight === null || weight < 0.05 || weight > 3) problems.push(`${where}, the weight must be a number from 0.05 to 3, not "${weightText}".`);
    const flag = (name: string, fallback: boolean) => {
      const raw = fields.get(name);
      if (raw === undefined) return fallback;
      const value = yesNo(raw);
      if (value === null) problems.push(`${where}, "${name}" must be yes or no, not "${raw}".`);
      return value ?? fallback;
    };
    const question = (name: string, required: boolean) => {
      const raw = fields.get(name);
      if (raw === undefined) {
        if (required) problems.push(`${where}, "- ${name}:" is missing.`);
        return null;
      }
      if (!raw.endsWith("?")) problems.push(`${where}, the "${name}" question must end with "?".`);
      if (raw.length > maxChars) problems.push(`${where}, the "${name}" question is over ${maxChars} characters.`);
      return raw;
    };
    const ask = question("Ask", true);
    const askHardWeek = question("Ask in a hard week", false);
    if (!rules) problems.push(`${where}, describe after a blank line when the topic counts as covered.`);
    topics.push({
      id,
      label: label.trim(),
      area: (area ?? "activity") as Area,
      weight: weight ?? 1,
      key: flag("Key topic", false),
      needs: fields.get("Needs")?.trim() || null,
      ask: ask ?? "",
      askHardWeek,
      tailor: flag("Tailor", true),
      briefIsEnough: flag("Brief is enough", false),
      rules,
    });
  }

  const ids = new Set<string>();
  for (const topic of topics) {
    if (ids.has(topic.id)) problems.push(`The topic id "${topic.id}" is used twice.`);
    ids.add(topic.id);
  }
  for (const topic of topics) {
    if (!topic.needs) continue;
    const needed = topics.find((t) => t.id === topic.needs);
    if (!needed) problems.push(`In topic ${topic.id}, "Needs: ${topic.needs}" isn't a topic.`);
    else if (needed.id === topic.id) problems.push(`Topic ${topic.id} can't need itself.`);
    else if (needed.needs) problems.push(`In topic ${topic.id}, "${needed.id}" needs another topic itself; a topic can only need one that needs nothing.`);
  }
  for (const area of AREAS) {
    const keys = topics.filter((t) => t.area === area && t.key);
    if (!topics.some((t) => t.area === area)) problems.push(`There is no topic for the area "${area}".`);
    else if (keys.length !== 1) problems.push(`The area "${area}" needs exactly one "Key topic: yes", not ${keys.length}.`);
    else if (keys[0].needs) problems.push(`The key topic ${keys[0].id} can't need another topic.`);
  }
  return topics;
}

function parseLines(body: string, problems: string[]): CoachLines | null {
  const lines: Partial<CoachLines> = {};
  for (const line of body.split("\n")) {
    const pair = keyValue(line);
    if (!pair) continue;
    const key = Object.entries(LINES).find(([name]) => name.toLowerCase() === pair[0].toLowerCase())?.[1];
    if (!key) problems.push(`"${pair[0]}" isn't one of the closing lines: ${Object.keys(LINES).join(", ")}.`);
    else if (!pair[1]) problems.push(`The closing line "${pair[0]}" is empty.`);
    else if (pair[1].length > MAX_LINE) problems.push(`The closing line "${pair[0]}" is over ${MAX_LINE} characters.`);
    else lines[key] = pair[1];
  }
  for (const [name, key] of Object.entries(LINES)) {
    if (lines[key] === undefined && !problems.some((p) => p.includes(`"${name}"`))) problems.push(`The closing line "${name}" is missing.`);
  }
  return Object.values(LINES).every((key) => lines[key] !== undefined) ? (lines as CoachLines) : null;
}

export function pacingFrom(settings: CoachSettings): Pacing {
  return {
    showAfterSilenceMs: settings.showAfterSilenceS * 1000,
    stoppedSilenceMs: settings.stoppedSilenceS * 1000,
    minQuestionMs: settings.minQuestionS * 1000,
    minWordsPerQuestion: settings.minWordsPerQuestion,
    firstFollowUpAfterMs: settings.firstFollowUpAfterS * 1000,
  };
}

// The rubric the live coach uses, read once. Throws RubricError for a broken file; callers turn live
// coaching off rather than fail the page.
let loaded: CoachRubric | null = null;
export function coachRubric(): CoachRubric {
  return (loaded ??= parseCoachRubric(coachFile));
}
