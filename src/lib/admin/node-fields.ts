// The fields an admin types for a division, domain or team: name, code, type, the title of the
// leaders who sit there (like President) and note. The add
// and edit forms (on the Structure page, and Edit on a team's page) check them as you type, and
// the createNode and updateNode server actions check them again before writing (the same
// functions, so the messages match). Kind and position aren't here: a node's kind is fixed once
// it exists, and positions change only through admin_move_team.

import { DIVISION_TYPE_LABELS, DOMAIN_TYPE_LABELS, type TeamRow } from "./tree";
import {
  asRecord,
  DIVISION_TYPES,
  type DivisionType,
  DOMAIN_TYPES,
  type DomainType,
  isDivisionType,
  isDomainType,
  parseCode,
  parseLeaderTitle,
  parseName,
  parseNote,
  type TeamKind,
} from "./validate";

export type NodeField = "name" | "code" | "type" | "leaderTitle" | "note";

// The form as typed. `type` is a domain or division type, or "" for none.
export type NodeForm = Record<NodeField, string>;

export const EMPTY_NODE_FORM: NodeForm = { name: "", code: "", type: "", leaderTitle: "", note: "" };

// What the createNode and updateNode server actions take (src/app/admin/structure/actions.ts).
export type CreateNodeInput = NodeForm & { kind: TeamKind; parentId: string | null };
export type UpdateNodeInput = NodeForm & { id: string };

// The teams columns the form becomes (both type columns, so an edit can't leave a stale one).
export type NodeFields = {
  name: string;
  code: string | null;
  domain_type: DomainType | null;
  division_type: DivisionType | null;
  leader_title: string | null;
  note: string | null;
};

export type NodeFieldErrors = Partial<Record<NodeField, string>>;

export type ParsedNodeFields =
  | { ok: true; value: NodeFields }
  | { ok: false; errors: NodeFieldErrors; error: string }; // `error`: the first one, for an action

// The types a kind of node can have, in the order the form lists them. A team has none.
export function typeOptions(kind: TeamKind): { value: string; label: string }[] {
  if (kind === "domain") return DOMAIN_TYPES.map((t) => ({ value: t, label: DOMAIN_TYPE_LABELS[t] }));
  if (kind === "division") {
    return DIVISION_TYPES.map((t) => ({ value: t, label: DIVISION_TYPE_LABELS[t] }));
  }
  return [];
}

// A row's current values as form text, for Edit.
export function nodeToForm(
  row: Pick<TeamRow, "name" | "code" | "kind" | "domain_type" | "division_type" | "leader_title" | "note">,
): NodeForm {
  return {
    name: row.name,
    code: row.code ?? "",
    type: (row.kind === "domain" ? row.domain_type : row.kind === "division" ? row.division_type : null) ?? "",
    leaderTitle: row.leader_title ?? "",
    note: row.note ?? "",
  };
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "";

// Checks the five fields for a node of `kind`. Anything else in `input` is ignored.
export function parseNodeFields(kind: TeamKind, input: unknown): ParsedNodeFields {
  const form = asRecord(input);
  const errors: NodeFieldErrors = {};

  const name = parseName(form.name);
  if (!name.ok) errors.name = name.error;
  const code = parseCode(form.code);
  if (!code.ok) errors.code = code.error;

  let domain_type: DomainType | null = null;
  let division_type: DivisionType | null = null;
  if (!isEmpty(form.type)) {
    if (kind === "domain" && isDomainType(form.type)) domain_type = form.type;
    else if (kind === "division" && isDivisionType(form.type)) division_type = form.type;
    else if (kind === "team") errors.type = "Teams don't have a type.";
    else if (kind === "organisation") errors.type = "The organisation doesn't have a type.";
    else errors.type = `Pick one of the ${kind} types, or none.`;
  }

  const leaderTitle = parseLeaderTitle(form.leaderTitle);
  if (!leaderTitle.ok) errors.leaderTitle = leaderTitle.error;

  const note = parseNote(form.note);
  if (!note.ok) errors.note = note.error;

  const first = errors.name ?? errors.code ?? errors.type ?? errors.leaderTitle ?? errors.note;
  if (first !== undefined || !name.ok || !code.ok || !leaderTitle.ok || !note.ok) {
    return { ok: false, errors, error: first ?? "Check the form." };
  }
  return {
    ok: true,
    value: {
      name: name.value,
      code: code.value,
      domain_type,
      division_type,
      leader_title: leaderTitle.value,
      note: note.value,
    },
  };
}
