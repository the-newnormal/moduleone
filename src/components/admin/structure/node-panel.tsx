"use client";

import { ExternalLinkIcon, PencilIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useId } from "react";
import type { TeamView } from "@/app/admin/teams/[id]/team-view";
import { LeadsSection } from "@/components/admin/team/leads-section";
import { PeopleSection } from "@/components/admin/team/people-section";
import type { TeamActions } from "@/components/admin/team/types";
import { Button } from "@/components/ui/button";

// The side panel a click on a canvas box opens: who sits in that node and who leads it, with the
// same controls as its team page (add people, roles, logins, leads). Changes save at once and the
// canvas redraws with them. Escape or × closes it, and focus goes back to the box.
export function NodePanel({
  view,
  actions,
  onEdit,
  onClose,
}: {
  view: TeamView;
  actions: Omit<TeamActions, "updateNode">;
  onEdit: () => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const { team, crumbs } = view;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A dialog open above the panel handles its own Escape.
      if (event.key === "Escape" && !document.querySelector("[role=dialog], [role=alertdialog]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside
      aria-labelledby={headingId}
      className="absolute inset-y-0 right-0 z-10 grid w-full max-w-md content-start gap-4 overflow-y-auto border-l bg-background p-4 shadow-xl"
    >
      <header className="grid gap-1">
        <div className="flex items-start gap-2">
          <div className="grid min-w-0 flex-1 gap-0.5">
            <p className="text-xs text-muted-foreground">
              {team.kindLabel}
              {crumbs.length > 0 && ` in ${crumbs.map((c) => c.label).join(" › ")}`}
            </p>
            <h2 id={headingId} tabIndex={-1} data-panel-heading className="text-2xl break-words outline-none">
              {team.name}
            </h2>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" data-node-menu={`panel:${team.id}`} onClick={onEdit}>
            <PencilIcon />
            Edit
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href={`/admin/teams/${team.id}`}>
              <ExternalLinkIcon />
              Open its page
            </Link>
          </Button>
        </div>
      </header>
      <PeopleSection
        team={team}
        people={view.people}
        candidates={view.candidates}
        actions={{
          addMember: actions.addMember,
          createMember: actions.createMember,
          giveLogin: actions.giveLogin,
          resendInvite: actions.resendInvite,
          removeFromTeam: actions.removeFromTeam,
          setRole: actions.setRole,
        }}
      />
      <LeadsSection
        team={team}
        ownLeaders={view.ownLeaders}
        leads={view.leads}
        inheritedLeads={view.inheritedLeads}
        leadOptions={view.leadOptions}
        actions={{ addLead: actions.addLead, removeLead: actions.removeLead }}
      />
    </aside>
  );
}
