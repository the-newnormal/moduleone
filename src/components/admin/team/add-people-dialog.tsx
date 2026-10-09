"use client";

import { startTransition, useEffect, useId, useRef, useState, useTransition } from "react";
import type { Candidate, TeamSummary } from "@/app/admin/teams/[id]/team-view";
import { matchesSearch } from "@/app/admin/teams/[id]/team-view";
import { ActionError } from "@/components/admin/action-error";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { type ActionResult, settle } from "@/lib/admin/errors";
import { ROLE_LABELS } from "@/lib/admin/roles";
import { ASSIGNABLE_ROLES, type AssignableRole, parseName } from "@/lib/admin/validate";
import type { TeamActions } from "./types";

type Props = {
  team: TeamSummary;
  candidates: Candidate[];
  actions: Pick<TeamActions, "addMember" | "createMember">;
  onDone: (message: string) => void;
};

// "Add people": put someone already in Module One in this team (people without a team listed
// first; moving someone from another team needs a confirm, since people are in one team at a
// time), or add a new person. The dialog stays open so several people can be added in a row, and
// can't be closed while a change is saving (its refusal shows in the dialog).
export function AddPeopleDialog(props: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <DialogTrigger asChild>
        <Button type="button">Add people</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add people to {props.team.name}</DialogTitle>
          <DialogDescription>
            Pick someone already in Module One, or add a new person. Everyone is in one team at a time.
          </DialogDescription>
        </DialogHeader>
        <AddPeoplePanel {...props} onBusy={setBusy} />
      </DialogContent>
    </Dialog>
  );
}

// The dialog's content (exported for tests). onBusy says when a change starts and ends saving.
export function AddPeoplePanel({ team, candidates, actions, onDone, onBusy }: Props & { onBusy?: (busy: boolean) => void }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [moving, setMoving] = useState<Candidate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [pending, startWorking] = useTransition();
  // Keyboard focus: onto "Move" when asked to confirm, and back to the search once someone has
  // been added (their row, and the button that was focused, are gone).
  const moveButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [added, setAdded] = useState(0);

  useEffect(() => {
    if (moving) moveButton.current?.focus();
  }, [moving]);
  useEffect(() => {
    if (added > 0) searchInput.current?.focus();
  }, [added]);

  // Run an action; on success say so here (the page behind the dialog says it too, for later).
  const run = (action: () => Promise<ActionResult>, context: string, message: string, after?: () => void) => {
    setError(null);
    onBusy?.(true);
    startWorking(async () => {
      const result = await settle(action, context);
      startTransition(() => {
        onBusy?.(false);
        if (result.ok) {
          setMoving(null);
          setNotice(message);
          onDone(message);
          after?.();
        } else {
          setError(result.error);
        }
      });
    });
  };

  const add = (person: Candidate) =>
    run(
      () => actions.addMember(team.id, person.id, person.teamId),
      "addMember",
      `Added ${person.name} to ${team.name}.`,
      () => setAdded((n) => n + 1),
    );

  const shown = candidates.filter((c) => matchesSearch(c.name, query));

  return (
    <div className="grid min-w-0 gap-5">
      <section aria-labelledby={`${id}-existing`} className="grid gap-3">
        <h3 id={`${id}-existing`} className="font-medium">
          Someone already in Module One
        </h3>
        {moving ? (
          <div role="group" aria-labelledby={`${id}-move`} className="grid gap-3 rounded-lg border p-4">
            <p id={`${id}-move`} className="font-medium">
              Move {moving.name} from {moving.teamName} to {team.name}?
            </p>
            <p className="text-sm text-muted-foreground">
              People are in one team at a time. Their past check-ins stay with {moving.teamName}.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button ref={moveButton} type="button" disabled={pending} onClick={() => add(moving)}>
                {pending ? "Moving…" : "Move"}
              </Button>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setMoving(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-search`}>Search by name</Label>
              <Input
                ref={searchInput}
                id={`${id}-search`}
                type="search"
                autoComplete="off"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {candidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">Everyone you can add is already here.</p>
            ) : shown.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nobody by that name.</p>
            ) : (
              <ul aria-label="People you can add" className="max-h-64 divide-y overflow-y-auto pr-1">
                {shown.map((person) => (
                  <li key={person.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <p className="font-medium break-words">{person.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {person.teamName ? `moves from ${person.teamName}` : "No team"}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => (person.teamId === null ? add(person) : setMoving(person))}
                    >
                      {person.teamId === null ? "Add" : "Move here"}
                      <span className="sr-only"> ({person.name})</span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <Separator />

      <NewPersonForm team={team} pending={pending} run={run} createMember={actions.createMember} />

      <ActionError message={error} />
      <p role="status" className="text-sm empty:hidden">
        {notice}
      </p>
    </div>
  );
}

function NewPersonForm({
  team,
  pending,
  run,
  createMember,
}: {
  team: TeamSummary;
  pending: boolean;
  run: (action: () => Promise<ActionResult>, context: string, message: string, after?: () => void) => void;
  createMember: TeamActions["createMember"];
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [role, setRole] = useState<AssignableRole>("member");
  const [nameError, setNameError] = useState<string | null>(null);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = parseName(name);
    if (!parsed.ok) {
      setNameError(parsed.error);
      return;
    }
    run(
      () => createMember(team.id, { name: parsed.value, role }),
      "createMember",
      `Added ${parsed.value} to ${team.name}.`,
      () => setName(""),
    );
  };

  return (
    <form onSubmit={submit} noValidate aria-labelledby={`${id}-title`} className="grid gap-3">
      <h3 id={`${id}-title`} className="font-medium">
        New person
      </h3>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          autoComplete="off"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameError(null);
          }}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? `${id}-name-error` : undefined}
        />
        {nameError && (
          <p id={`${id}-name-error`} className="text-xs text-destructive">
            {nameError}
          </p>
        )}
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">Role</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {ASSIGNABLE_ROLES.map((value) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${id}-role`}
                value={value}
                checked={role === value}
                onChange={() => setRole(value)}
                className="size-4 accent-primary"
              />
              {ROLE_LABELS[value]}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-sm text-muted-foreground">New people have no login until you give them one.</p>
      <div>
        <Button type="submit" disabled={pending}>
          Add new person
        </Button>
      </div>
    </form>
  );
}
