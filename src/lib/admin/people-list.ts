// Reading a list of people typed or pasted into Add a list: one person per line, with their name,
// the email their invite will go to if there is one, and their role if it isn't the list's. A line
// pasted from a spreadsheet splits at its tabs; any other line splits at commas and semicolons
// outside double quotes, as a CSV file's do. Its parts can come in any order: the one with an @ is
// the email, one that says Member or Leader is the role, and the rest is the name. What mail
// programs copy works too: "Mei Wong" <mei@example.com>, mailto:mei@example.com. Quotes around a
// part, and a bullet or number in front of a name, are left out. A first line of column headings
// (Name, Email, Role) is skipped. Pure, so the dialog checks the list as it's typed and the server
// checks each person again (createMembers).

import { ROLE_LABELS } from "./roles";
import { type AssignableRole, parseEmail, parseName } from "./validate";

// The most people one list adds (admin_add_members, migration 0014, refuses more).
export const MAX_PEOPLE = 200;

export type ListedPerson = {
  name: string;
  email: string | null; // trimmed and lower case, as parseEmail stores it
  role: AssignableRole | null; // null: the role chosen for the whole list
};

// One line of the list (blank lines aren't listed): the person on it, or what's wrong with it.
// line counts from 1, blank lines included, as the admin sees them.
export type ListEntry =
  | { line: number; ok: true; person: ListedPerson }
  | { line: number; ok: false; text: string; error: string };

const HEADINGS = new Set(["name", "names", "full name", "email", "emails", "e-mail", "email address", "role"]);

// "Member" or "Leader", in any letter case; "Master Admin" is told no. (Not "HQ": that's also a
// division's name, which a column of departments could hold.)
function roleOf(cell: string): AssignableRole | "hq" | null {
  const word = cell.trim().toLocaleLowerCase("en");
  if (word === ROLE_LABELS.member.toLocaleLowerCase("en")) return "member";
  if (word === ROLE_LABELS.leader.toLocaleLowerCase("en")) return "leader";
  if (word === ROLE_LABELS.hq.toLocaleLowerCase("en")) return "hq";
  return null;
}

const QUOTES = new Set(['"', "\u201C", "\u201D"]);

// The part without one pair of double quotes around it (straight or curly), as a CSV file or a
// mail program writes a name with a comma in it; "" inside them is one ".
function unquote(part: string): string {
  const trimmed = part.trim();
  const chars = [...trimmed];
  if (chars.length >= 2 && QUOTES.has(chars[0]) && QUOTES.has(chars[chars.length - 1])) {
    return chars.slice(1, -1).join("").replaceAll('""', '"').trim();
  }
  return trimmed;
}

// At commas and semicolons outside double quotes.
function splitOutsideQuotes(line: string): string[] {
  const parts: string[] = [];
  let part = "";
  let quoted = false;
  for (const char of line) {
    if (QUOTES.has(char)) quoted = !quoted;
    if (!quoted && (char === "," || char === ";")) {
      parts.push(part);
      part = "";
    } else {
      part += char;
    }
  }
  parts.push(part);
  return parts;
}

// A line's parts: at its tabs if it has any (a spreadsheet's columns, so a comma can stay in a
// name), else at commas and semicolons outside quotes. "Name <email>" is two parts. Empty parts (a
// spreadsheet's empty email column) are dropped.
function cellsOf(line: string): string[] {
  const parts = line.includes("\t") ? line.split("\t") : splitOutsideQuotes(line);
  return parts
    .flatMap((part) => {
      const angled = /^(.*?)\s*<([^<>]*)>\s*$/.exec(part.trim());
      return angled ? [angled[1], angled[2]] : [part];
    })
    .map(unquote)
    .filter((part) => part !== "");
}

// A bullet or a number in front of a name, as a list copied from a document has.
const LIST_MARK = /^(?:[\u2022\u00B7\u2023\u25E6*\u2013\u2014-]|\d{1,3}[.)])\s+/u;

function entryOf(cells: string[]): ListedPerson | string {
  const emails = cells.filter((cell) => cell.includes("@"));
  const roles = cells.filter((cell) => !cell.includes("@") && roleOf(cell) !== null);
  const names = cells.filter((cell) => !cell.includes("@") && roleOf(cell) === null);

  if (emails.length > 1) return "This line has more than one email address. Put each person on their own line.";
  if (roles.length > 1) return "Give one role per person.";
  if (names.length === 0) return "Enter a name.";
  if (names.length > 1) {
    return "This line has more than a name, an email and a role. Put the whole name in one column, and leave out any other columns.";
  }

  const name = parseName(names[0].replace(LIST_MARK, ""));
  if (!name.ok) return name.error;
  let email: string | null = null;
  if (emails.length === 1) {
    const parsed = parseEmail(emails[0].replace(/^mailto:/i, ""));
    if (!parsed.ok) return parsed.error;
    email = parsed.value;
  }
  const role = roles.length === 1 ? roleOf(roles[0]) : null;
  if (role === "hq") return `Only the project owner makes someone a ${ROLE_LABELS.hq}.`;
  return { name: name.value, email, role };
}

export function parsePeopleList(text: string): ListEntry[] {
  const entries: ListEntry[] = [];
  const emailLine = new Map<string, number>();
  let people = 0;
  let first = true;

  text.split(/\r\n|\r|\n/).forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed === "") return;
    // A line of separators only (a CSV file's empty row) lists nobody, like a blank one.
    const cells = cellsOf(raw);
    if (cells.length === 0) return;
    // Column headings, on the list's first line only.
    if (first) {
      first = false;
      if (cells.every((cell) => HEADINGS.has(cell.toLocaleLowerCase("en")))) return;
    }

    const result = entryOf(cells);
    if (typeof result === "string") {
      entries.push({ line, ok: false, text: trimmed, error: result });
      return;
    }
    if (result.email !== null) {
      const earlier = emailLine.get(result.email);
      if (earlier !== undefined) {
        entries.push({ line, ok: false, text: trimmed, error: `That email is on line ${earlier} too.` });
        return;
      }
      emailLine.set(result.email, line);
    }
    people += 1;
    if (people > MAX_PEOPLE) {
      entries.push({
        line,
        ok: false,
        text: trimmed,
        error: `A list can add at most ${MAX_PEOPLE} people. Add the rest in another list.`,
      });
      return;
    }
    entries.push({ line, ok: true, person: result });
  });
  return entries;
}
