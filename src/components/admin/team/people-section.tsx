"use client";

import Link from "next/link";
import { useId, useState } from "react";
import type { Candidate, Person, TeamSummary } from "@/app/admin/teams/[id]/team-view";
import {
  demoteDescription,
  loginStatusText,
  promoteDescription,
  removeDescription,
  removePersonDescription,
} from "@/app/admin/teams/[id]/team-view";
import { Tag } from "@/components/normal/tag";
import { Badge } from "@/components/ui/badge";
import type { Removal } from "@/app/admin/teams/[id]/actions";
import { AddPeopleDialog } from "./add-people-dialog";
import { ChangeEmailDialog } from "./change-email-dialog";
import { ConfirmButton } from "./confirm-button";
import { GiveLoginDialog } from "./give-login-dialog";
import type { TeamActions } from "./types";

export type PeopleActions = Pick<
  TeamActions,
  "addMember" | "createMember" | "giveLogin" | "resendInvite" | "removeFromTeam" | "setRole" | "changeEmail" | "removePerson"
>;

type Props = {
  team: TeamSummary;
  people: Person[];
  candidates: Candidate[];
  actions: PeopleActions;
};

// "People": everyone whose team this is, with their role and login, and (except on Master Admin
// rows and the admin's own row, which RLS won't let an admin change) the changes an admin can make.
export function PeopleSection({ team, people, candidates, actions }: Props) {
  const headingId = useId();
  const [status, setStatus] = useState("");
  const noun = team.kind;

  return (
    <section aria-labelledby={headingId} className="grid gap-4 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Focus lands here when the control that was focused goes away with its row. */}
        <h2 id={headingId} tabIndex={-1} className="text-2xl outline-none">
          People <span className="text-base text-muted-foreground">({people.length})</span>
        </h2>
        {!team.archived && team.kind !== "organisation" && (
          <AddPeopleDialog team={team} candidates={candidates} actions={actions} onDone={setStatus} />
        )}
      </div>
      {team.kind === "organisation" && (
        <p className="text-sm text-muted-foreground">
          Only the project owner places people in the organisation, changes their sign-in email or removes them,
          since whoever sits here sees the check-ins of every division.
        </p>
      )}
      {team.archived && (
        <p className="text-sm text-muted-foreground">
          This {noun} is archived, so nobody can be added to it. Restore it on the{" "}
          <Link href="/admin/structure" className="underline underline-offset-4 hover:text-foreground">
            Structure page
          </Link>{" "}
          first.
        </p>
      )}
      {people.length === 0 ? (
        <p className="text-muted-foreground">Nobody is in this {noun} yet.</p>
      ) : (
        // Rows lay out by the list's width, not the window's: the Structure side panel is narrow.
        <ul className="@container divide-y">
          {people.map((person) => (
            <PersonRow
              key={person.id}
              team={team}
              person={person}
              actions={actions}
              onDone={setStatus}
              heading={`[id="${headingId}"]`}
            />
          ))}
        </ul>
      )}
      <p role="status" className="text-sm empty:hidden">
        {status}
      </p>
    </section>
  );
}

// What Remove from Module One says it did.
export function removedMessage(name: string, { outcome, loginKept }: Removal): string {
  const done =
    outcome === "deleted"
      ? `Removed ${name} from Module One. They had nothing recorded, so they're deleted completely.`
      : `Removed ${name} from Module One. Anything they recorded stays.`;
  return loginKept
    ? `${done} Their login couldn't be fully cleaned up: it opens nothing now, and the project owner can finish in Supabase.`
    : done;
}

// One person, with what an admin may change about them. team: the node they're listed under, or
// null in the Structure page's No team panel (rows there aren't editable: they're placed by
// dragging).
export function PersonRow({
  team,
  person,
  actions,
  onDone,
  heading,
}: {
  team: TeamSummary | null;
  person: Person;
  actions: Pick<PeopleActions, "giveLogin" | "resendInvite" | "removeFromTeam" | "setRole" | "changeEmail" | "removePerson">;
  onDone: (message: string) => void;
  heading: string; // where focus goes when a change takes this row's button away
}) {
  const { name } = person;
  const leader = person.role === "leader";
  // Each button says whose it is, for screen readers.
  const who = <span className="sr-only"> ({name})</span>;
  const editable = person.editable && team !== null;
  const login = loginStatusText(person.login);

  return (
    <li className="grid gap-3 py-3 @3xl:grid-cols-[minmax(0,1fr)_auto] @3xl:items-center">
      <div className="grid min-w-0 gap-1">
        <p className="font-medium break-words">
          {name}
          {person.title && <span className="font-normal"> · {person.title}</span>}
          {person.isSelf && <span className="font-normal text-muted-foreground"> (you)</span>}
        </p>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <Badge variant={person.role === "member" ? "outline" : "secondary"}>{person.roleLabel}</Badge>
          <Tag tone={login.tone}>{login.label}</Tag>
          {login.detail && <span>{login.detail}</span>}
        </p>
        {person.loginGiven && <p className="text-xs text-muted-foreground">{person.loginGiven}</p>}
        {person.ownerResendsInvite && (
          <p className="text-xs text-muted-foreground">
            This login wasn&apos;t given in Module One, so only the project owner can send its invite again.
          </p>
        )}
        {person.emailChanged && <p className="text-xs text-muted-foreground">{person.emailChanged}</p>}
        {(person.ownerKeeps === "grants" || person.ownerGivesLogin) && (
          <p className="text-xs text-muted-foreground">
            {person.hasLogin
              ? "They hold grants, so only the project owner can change their sign-in email or remove them."
              : "They hold grants, so the project owner gives them a login. Only the project owner can remove them."}
          </p>
        )}
        {person.ownerKeeps === "organisation" && team?.kind !== "organisation" && (
          <p className="text-xs text-muted-foreground">
            They lead the organisation, so only the project owner can change their sign-in email or remove them.
          </p>
        )}
      </div>

      {(editable || person.canGiveLogin || person.canResendInvite || person.canChangeEmail || person.canRemove) && (
        <div className="flex flex-wrap gap-2 @3xl:justify-end">
          {person.canGiveLogin && (
            <GiveLoginDialog person={person} giveLogin={actions.giveLogin} onDone={onDone} focusAfter={heading} />
          )}
          {person.canResendInvite && (
            <ConfirmButton
              label={<>Resend invite{who}</>}
              title={`Send ${name} a new invite?`}
              description={
                `If ${name} hasn't used their invite yet, Module One emails a new link to the address it ` +
                `went to, and the old link stops working. Once they've used it, they sign in at the login ` +
                `page instead.`
              }
              confirmLabel="Send new invite"
              run={() => actions.resendInvite(person.id)}
              context="resendInvite"
              onDone={() => onDone(`Sent ${name} a new invite.`)}
            />
          )}
          {person.canChangeEmail && <ChangeEmailDialog person={person} changeEmail={actions.changeEmail} onDone={onDone} />}
          {!editable || team === null ? null : leader ? (
            // Everyone placed here leads it (0006): move them out to make them a member.
            !team.everyoneLeads && (
            <ConfirmButton
              label={<>Make member{who}</>}
              title={`Make ${name} a member?`}
              description={demoteDescription(person, team)}
              confirmLabel="Make member"
              run={() => actions.setRole(person.id, "member")}
              context="setRole"
              onDone={() => onDone(`${name} is a member now.`)}
            />
            )
          ) : (
            <ConfirmButton
              label={<>Make leader{who}</>}
              title={`Make ${name} a leader?`}
              description={promoteDescription(person, team)}
              confirmLabel="Make leader"
              run={() => actions.setRole(person.id, "leader")}
              context="setRole"
              onDone={() => onDone(`${name} is a leader now.`)}
            />
          )}
          {editable && team !== null && (
            <ConfirmButton
              label={
                <>
                  Remove from {team.kind}
                  {who}
                </>
              }
              title={`Remove ${name} from ${team.name}?`}
              description={removeDescription(person, team)}
              confirmLabel="Remove"
              destructive
              run={() => actions.removeFromTeam(team.id, person.id)}
              context="removeFromTeam"
              onDone={() => onDone(`Removed ${name} from ${team.name}.`)}
              focusAfter={heading}
            />
          )}
          {person.canRemove && (
            <ConfirmButton
              label={<>Remove from Module One{who}</>}
              title={`Remove ${name} from Module One?`}
              description={removePersonDescription(person, team)}
              confirmLabel="Remove from Module One"
              pendingLabel="Removing…"
              destructive
              run={() => actions.removePerson(person.id)}
              context="removePerson"
              onDone={(removal) => onDone(removedMessage(name, removal))}
              focusAfter={heading}
            />
          )}
        </div>
      )}
    </li>
  );
}
