"use client";

import Link from "next/link";
import { startTransition, useEffect, useId, useRef, useState, useTransition } from "react";
import type { InheritedLead, LeadPerson, OwnLeader, TeamSummary } from "@/app/admin/teams/[id]/team-view";
import { coverage, matchesSearch } from "@/app/admin/teams/[id]/team-view";
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
import { settle } from "@/lib/admin/errors";
import { ConfirmButton } from "./confirm-button";
import type { TeamActions } from "./types";

type Props = {
  team: TeamSummary;
  ownLeaders: OwnLeader[];
  leads: LeadPerson[];
  inheritedLeads: InheritedLead[];
  leadOptions: LeadPerson[];
  actions: Pick<TeamActions, "addLead" | "removeLead">;
};

// Where a lead sits themselves.
function leadWhere(lead: LeadPerson, noun: string): string {
  if (lead.inThisTeam) return `Leader in this ${noun}, also added as a lead`;
  if (lead.viaOwnTeam) return `Leader in ${lead.teamName}, which holds this ${noun}`;
  const where = lead.teamName ? `Leader in ${lead.teamName}` : "Leader with no team";
  return lead.viaDomain ? `${where}, also leads ${lead.viaDomain}` : where;
}

// What removing someone's lead row changes: nothing they can see, when they still lead this node
// by sitting in it or by leading a node that holds it (leads cover everything under them).
function removeLeadCopy(lead: LeadPerson, team: TeamSummary, noun: string) {
  const keeps = lead.inThisTeam
    ? `they sit in this ${noun}`
    : lead.viaDomain
      ? `they also lead ${lead.viaDomain}, which holds it`
      : null;
  if (!keeps) {
    return {
      description: `They'll no longer see the check-ins made in ${coverage(team)} through this lead.`,
      done: `${lead.name} no longer leads ${team.name}.`,
    };
  }
  return {
    description: `This only removes the extra lead. They'll still see the check-ins made in ${coverage(team)}, because ${keeps}.`,
    done: `Removed the extra lead. ${lead.name} still leads ${team.name}, because ${keeps}.`,
  };
}

// One line on what leading means here.
export function leadsExplanation(team: Pick<TeamSummary, "kind">): string {
  if (team.kind === "organisation") {
    return "Whoever sits in the organisation leads it: they see the check-ins made in it and in every division in it. Only the project owner places people here.";
  }
  if (team.kind === "division") return "Leads see the check-ins made in this division and in everything in it.";
  return team.kind === "domain"
    ? "Leads see the check-ins made in this domain and in its sub-teams."
    : "Leads see the check-ins made in this team.";
}

// "Leads": leaders who sit in this node (they lead it through their role and team, so they're
// changed under People), leaders of other teams who lead it too (team_leads rows), and whoever
// leads a node above it, its domain or division (leads cover everything under the led node;
// changed on that node's page). Each person once.
export function LeadsSection({ team, ownLeaders, leads, inheritedLeads, leadOptions, actions }: Props) {
  const headingId = useId();
  const [status, setStatus] = useState("");
  const noun = team.kind;
  const none = ownLeaders.length === 0 && leads.length === 0 && inheritedLeads.length === 0;

  return (
    <section aria-labelledby={headingId} className="grid gap-4 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Focus lands here when a removed lead's row goes away. */}
        <h2 id={headingId} tabIndex={-1} className="text-2xl outline-none">
          Leads
        </h2>
        {!team.archived && team.kind !== "organisation" && (
          <AddLeadDialog team={team} leadOptions={leadOptions} addLead={actions.addLead} onDone={setStatus} />
        )}
      </div>
      <p className="text-sm text-muted-foreground">{leadsExplanation(team)}</p>
      {none ? (
        <p className="text-muted-foreground">Nobody leads this {noun} yet.</p>
      ) : (
        <ul className="divide-y">
          {ownLeaders.map((leader) => (
            <li key={leader.id} className="grid gap-1 py-3">
              <p className="font-medium break-words">{leader.name}</p>
              <p className="text-sm text-muted-foreground">
                {team.kind === "organisation" ? "Placed here by the project owner" : `Leader in this ${noun} (change it under People)`}
                {leader.domain && (
                  <>
                    . Also leads <DomainLink {...leader.domain} />, which holds this {noun}
                  </>
                )}
              </p>
            </li>
          ))}
          {leads.map((lead) => (
            <li
              key={lead.id}
              className="grid gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
              <div className="grid min-w-0 gap-1">
                <p className="font-medium break-words">{lead.name}</p>
                <p className="text-sm text-muted-foreground">{leadWhere(lead, noun)}</p>
              </div>
              <div className="flex sm:justify-end">
                <ConfirmButton
                  label={
                    <>
                      Remove as lead<span className="sr-only"> ({lead.name})</span>
                    </>
                  }
                  title={`Remove ${lead.name}'s lead for ${team.name}?`}
                  description={removeLeadCopy(lead, team, noun).description}
                  confirmLabel="Remove lead"
                  destructive
                  run={() => actions.removeLead(team.id, lead.id)}
                  context="removeLead"
                  onDone={() => setStatus(removeLeadCopy(lead, team, noun).done)}
                  focusAfter={`[id="${headingId}"]`}
                />
              </div>
            </li>
          ))}
          {inheritedLeads.map((lead) => (
            <li key={lead.id} className="grid gap-1 py-3">
              <p className="font-medium break-words">{lead.name}</p>
              <p className="text-sm text-muted-foreground">
                Leads <DomainLink id={lead.domainId} name={lead.domainName} />, which holds this {noun}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p role="status" className="text-sm empty:hidden">
        {status}
      </p>
    </section>
  );
}

function DomainLink({ id, name }: { id: string; name: string }) {
  return (
    <Link href={`/admin/teams/${id}`} className="underline underline-offset-4 hover:text-foreground">
      {name}
    </Link>
  );
}

type AddLeadProps = {
  team: TeamSummary;
  leadOptions: LeadPerson[];
  addLead: TeamActions["addLead"];
  onDone: (message: string) => void;
};

// Can't be closed while adding (the refusal shows in the dialog).
function AddLeadDialog(props: AddLeadProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          Add lead
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a lead to {props.team.name}</DialogTitle>
          <DialogDescription>
            Pick a leader from any team. {leadsExplanation(props.team)}
          </DialogDescription>
        </DialogHeader>
        <AddLeadPanel {...props} onBusy={setBusy} />
      </DialogContent>
    </Dialog>
  );
}

// The dialog's content (exported for tests). onBusy says when adding starts and ends.
export function AddLeadPanel({ team, leadOptions, addLead, onDone, onBusy }: AddLeadProps & { onBusy?: (busy: boolean) => void }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [pending, startWorking] = useTransition();
  const shown = leadOptions.filter((o) => matchesSearch(o.name, query));
  // Back to the search once someone has been added (their row, and its button, are gone).
  const searchInput = useRef<HTMLInputElement>(null);
  const [added, setAdded] = useState(0);
  useEffect(() => {
    if (added > 0) searchInput.current?.focus();
  }, [added]);

  const add = (leader: LeadPerson) => {
    setError(null);
    onBusy?.(true);
    startWorking(async () => {
      const result = await settle(() => addLead(team.id, leader.id), "addLead");
      startTransition(() => {
        onBusy?.(false);
        if (result.ok) {
          const message = `${leader.name} now leads ${team.name}.`;
          setNotice(message);
          onDone(message);
          setAdded((n) => n + 1);
        } else {
          setError(result.error);
        }
      });
    });
  };

  return (
    <div className="grid min-w-0 gap-3">
      {leadOptions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          There are no other leaders to add. Make someone a leader on their team&apos;s page first.
        </p>
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
          {shown.length === 0 ? (
            <p className="text-sm text-muted-foreground">No leader by that name.</p>
          ) : (
            <ul aria-label="Leaders you can add" className="max-h-64 divide-y overflow-y-auto pr-1">
              {shown.map((leader) => (
                <li key={leader.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="font-medium break-words">{leader.name}</p>
                    <p className="text-sm text-muted-foreground">{leadWhere(leader, "team")}</p>
                  </div>
                  <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => add(leader)}>
                    Add as lead<span className="sr-only"> ({leader.name})</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <ActionError message={error} />
      <p role="status" className="text-sm empty:hidden">
        {notice}
      </p>
    </div>
  );
}
