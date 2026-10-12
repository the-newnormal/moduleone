"use client";

import { startTransition, useId, useMemo, useState, useTransition } from "react";
import type { TeamSummary } from "@/app/admin/teams/[id]/team-view";
import { ActionError } from "@/components/admin/action-error";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { settle } from "@/lib/admin/errors";
import { type ListEntry, MAX_PEOPLE, parsePeopleList } from "@/lib/admin/people-list";
import { ROLE_LABELS } from "@/lib/admin/roles";
import { ASSIGNABLE_ROLES, type AssignableRole } from "@/lib/admin/validate";
import type { TeamActions } from "./types";

type Props = {
  team: TeamSummary;
  // Names already in Module One (this node's people, and everyone who could be added to it), so a
  // list doesn't add someone twice without the admin noticing.
  here: readonly string[];
  elsewhere: readonly string[];
  createMembers: TeamActions["createMembers"];
  onDone: (message: string) => void;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const fold = (name: string) => name.normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/g, " ").trim();

// What Add a list says it did.
export function addedListMessage(team: Pick<TeamSummary, "name">, added: number, withEmail: number): string {
  const done = `Added ${plural(added, "person", "people")} to ${team.name}.`;
  if (withEmail === 0) return `${done} They have no login until you give them one.`;
  if (added === 1) return `${done} Their email is noted for their invite, and nobody was emailed: give them a login when you're ready.`;
  const noted = withEmail === added ? "Their emails are" : plural(withEmail, "email is", "emails are");
  return `${done} ${noted} noted for their invites, and nobody was emailed: give them a login when you're ready.`;
}

// "Add a list": several new people in this node at once, typed or pasted one per line, each with
// the email their first invite will go to if there is one. The list is checked as it's typed, line
// by line; nobody is added until every line is right, and then the whole list is added together
// (createMembers), or nobody. The dialog can't be closed while it's saving.
export function AddListDialog(props: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          Add a list
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <AddListForm
          {...props}
          onBusy={setBusy}
          onDone={(message) => {
            setOpen(false);
            props.onDone(message);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

// The dialog's content (exported for tests). Its state resets each time the dialog opens.
export function AddListForm({
  team,
  here,
  elsewhere,
  createMembers,
  onDone,
  onBusy,
}: Props & { onBusy?: (busy: boolean) => void }) {
  const id = useId();
  const [text, setText] = useState("");
  const [chosen, setRole] = useState<AssignableRole>("member");
  const listRole: AssignableRole = team.everyoneLeads ? "leader" : chosen;
  const [error, setError] = useState<string | null>(null);
  const [pending, startSaving] = useTransition();

  const entries = useMemo(() => parsePeopleList(text), [text]);
  const people = entries.filter((e): e is Extract<ListEntry, { ok: true }> => e.ok);
  const problems = entries.filter((e): e is Extract<ListEntry, { ok: false }> => !e.ok);
  const known = useMemo(
    () => ({ here: new Set(here.map(fold)), elsewhere: new Set(elsewhere.map(fold)) }),
    [here, elsewhere],
  );
  // Everyone placed in a division or the organisation leads it (0006), whatever the line says.
  const roleOf = (role: AssignableRole | null): AssignableRole => (team.everyoneLeads ? "leader" : (role ?? listRole));

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (problems.length > 0) {
      const lines = problems.map((p) => p.line);
      setError(`Fix ${lines.length === 1 ? `line ${lines[0]}` : `lines ${lines.join(", ")}`} first. Nobody has been added yet.`);
      return;
    }
    if (people.length === 0) {
      setError("Type or paste at least one person, one per line.");
      return;
    }
    const list = people.map(({ person }) => ({ name: person.name, email: person.email, role: roleOf(person.role) }));
    const withEmail = list.filter((p) => p.email !== null).length;
    setError(null);
    onBusy?.(true);
    startSaving(async () => {
      const result = await settle(() => createMembers(team.id, list), "createMembers");
      startTransition(() => {
        onBusy?.(false);
        if (result.ok) onDone(addedListMessage(team, result.value.added, withEmail));
        else setError(result.error);
      });
    });
  };

  return (
    <form onSubmit={submit} noValidate className="grid min-w-0 gap-4">
      <DialogHeader>
        <DialogTitle>Add a list of people to {team.name}</DialogTitle>
        <DialogDescription>
          One person per line: their name, then the email their invite will go to, if you have it. Paste from a
          spreadsheet, or separate them with commas. Up to {MAX_PEOPLE} people at a time. Nobody is emailed now:
          give them a login when you&apos;re ready.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-list`}>People</Label>
        <Textarea
          id={`${id}-list`}
          rows={8}
          autoComplete="off"
          spellCheck={false}
          placeholder={"Mei Wong, mei.wong@example.com\nLeo Tan, leo.tan@example.com, Leader\nZed Ong"}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          aria-describedby={`${id}-hint`}
          className="max-h-64 font-mono text-sm"
        />
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {team.everyoneLeads
            ? `Everyone placed in a ${team.kind} leads it, so they'll all be leaders.`
            : `Add ${ROLE_LABELS.leader} or ${ROLE_LABELS.member} to a line to give that person another role than the one below.`}
        </p>
      </div>
      {!team.everyoneLeads && (
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-medium">Everyone else is a</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {ASSIGNABLE_ROLES.map((value) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-role`}
                  value={value}
                  checked={chosen === value}
                  onChange={() => setRole(value)}
                  className="size-4 accent-primary"
                />
                {ROLE_LABELS[value]}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {entries.length > 0 && (
        <section aria-labelledby={`${id}-preview`} className="grid min-w-0 gap-2">
          <h3 id={`${id}-preview`} className="text-sm font-medium">
            {problems.length > 0
              ? `${plural(people.length, "person", "people")} to add, and ${plural(problems.length, "line", "lines")} to fix`
              : `${plural(people.length, "person", "people")} to add`}
          </h3>
          <ul aria-label="The list, line by line" className="max-h-64 divide-y overflow-y-auto rounded-md border text-sm">
            {entries.map((entry) =>
              entry.ok ? (
                <li key={entry.line} className="grid gap-0.5 px-3 py-2">
                  <p className="break-words">
                    <span className="text-muted-foreground">Line {entry.line}: </span>
                    <span className="font-medium">{entry.person.name}</span>
                    {" · "}
                    {entry.person.email ?? <span className="text-muted-foreground">no email</span>}
                    {" · "}
                    {ROLE_LABELS[roleOf(entry.person.role)]}
                  </p>
                  {known.here.has(fold(entry.person.name)) ? (
                    <p className="text-xs text-muted-foreground">Someone called {entry.person.name} is already in {team.name}.</p>
                  ) : (
                    known.elsewhere.has(fold(entry.person.name)) && (
                      <p className="text-xs text-muted-foreground">
                        Someone called {entry.person.name} is already in Module One. To move them here, use Add people instead.
                      </p>
                    )
                  )}
                </li>
              ) : (
                <li key={entry.line} className="grid gap-0.5 px-3 py-2 text-destructive">
                  <p className="break-words">
                    Line {entry.line}: {entry.error}
                  </p>
                  <p className="font-mono text-xs break-all opacity-80">{entry.text}</p>
                </li>
              ),
            )}
          </ul>
        </section>
      )}

      <ActionError message={error} />
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={pending}>
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={pending}>
          {pending ? "Adding…" : people.length > 0 ? `Add ${plural(people.length, "person", "people")}` : "Add people"}
        </Button>
      </DialogFooter>
    </form>
  );
}
