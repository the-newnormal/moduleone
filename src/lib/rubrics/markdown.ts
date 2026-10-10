// Reading the rubric files in rubrics/ (plain Markdown that people edit on GitHub). Only the little
// Markdown those files use: "## " and "### " headings, "- key: value" lines, and <!-- notes -->
// for people, which are dropped before anything is sent to Claude.

import { createHash } from "node:crypto";

// A rubric file that can't be used. The message lists every problem, in words the person who
// edited the file can act on; the rubric test prints it on the pull request.
export class RubricError extends Error {
  readonly problems: string[];

  constructor(file: string, problems: string[]) {
    super(`${file} can't be used:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    this.name = "RubricError";
    this.problems = problems;
  }
}

// The text without <!-- ... --> notes, with Windows line endings made plain. A note that is never
// closed is a problem rather than a silent cut, since everything after it would vanish.
export function withoutNotes(text: string): { text: string; unclosed: boolean } {
  const plain = text.replace(/\r\n?/g, "\n");
  const unclosed = /<!--(?![\s\S]*?-->)/.test(plain);
  return { text: plain.replace(/<!--[\s\S]*?-->/g, ""), unclosed };
}

export type Section = { heading: string; body: string };

// Text that splitSections leaves outside every "## " section (under the "# " title, or after a
// heading typed with one "#") would never reach Claude, so the rubric parsers refuse it.
export const OUTSIDE_SECTIONS =
  'Text outside the "## " sections is never sent to Claude: move it into a section, or make it a note between <!-- and -->. (Check for a heading written with one "#" instead of two.)';

// The file split at headings of one level ("## " or "### "): each heading with the text under it,
// up to the next heading of that level or higher. Text before the first heading is `preamble`.
export function splitSections(text: string, level: 2 | 3): { preamble: string; sections: Section[] } {
  const marker = "#".repeat(level);
  const higher = new RegExp(`^#{1,${level - 1}} `);
  const lines = text.split("\n");
  const sections: Section[] = [];
  const preamble: string[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of lines) {
    if (line.startsWith(`${marker} `)) {
      if (current) sections.push({ heading: current.heading, body: tidy(current.lines) });
      current = { heading: line.slice(level + 1).trim(), lines: [] };
    } else if (higher.test(line)) {
      // A higher heading (the file's "# Title") ends the current section and starts no new one.
      if (current) sections.push({ heading: current.heading, body: tidy(current.lines) });
      current = null;
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) sections.push({ heading: current.heading, body: tidy(current.lines) });
  return { preamble: tidy(preamble), sections };
}

// Trimmed, with runs of blank lines folded to one.
function tidy(lines: string[]): string {
  return lines
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// "- Key: value" → ["Key", "value"], or null for any other line. The key is everything before the
// first ": " (so values may contain colons).
export function keyValue(line: string): [string, string] | null {
  const match = /^-\s+([^:]+?):\s*(.*)$/.exec(line.trim());
  return match ? [match[1].trim(), match[2].trim()] : null;
}

// "yes" / "no" in any case, or null.
export function yesNo(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  return v === "yes" ? true : v === "no" ? false : null;
}

// A plain decimal number ("0.6", "5", "2.5"), or null for anything else ("five", "1e3", "").
export function decimal(value: string): number | null {
  return /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : null;
}

// A short, stable fingerprint of some text: the first 12 hex digits of its SHA-256. Stored with each
// grade (and each live session), so grades made under different rubric versions can be told apart.
export function fingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}
