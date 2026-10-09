"use client";

import { XIcon } from "lucide-react";
import { useId, useState } from "react";
import type { Person } from "@/app/admin/teams/[id]/team-view";
import { type PeopleActions, PersonRow } from "@/components/admin/team/people-section";
import { Button } from "@/components/ui/button";
import { useCloseOnEscape } from "./node-panel";

// The side panel for everyone who sits in no division, domain or team: their logins, Change email
// and Remove from Module One, as on a team page. Placing them is done on the canvas, by dragging
// them (with Show people on) onto a box. Escape or × closes it.
export function NoTeamPanel({
  people,
  actions,
  onClose,
}: {
  people: Person[];
  actions: Pick<PeopleActions, "giveLogin" | "resendInvite" | "removeFromTeam" | "setRole" | "changeEmail" | "removePerson">;
  onClose: () => void;
}) {
  const headingId = useId();
  const [status, setStatus] = useState("");
  useCloseOnEscape(onClose);

  return (
    <aside
      aria-labelledby={headingId}
      className="absolute inset-y-0 right-0 z-10 grid w-full max-w-md content-start gap-4 overflow-y-auto border-l bg-background p-4 shadow-xl"
    >
      <header className="flex items-start gap-2">
        {/* Focus lands here when the panel opens, and when the control that was focused goes away with its row. */}
        <h2 id={headingId} tabIndex={-1} data-panel-heading className="flex-1 text-2xl outline-none">
          No team <span className="text-base text-muted-foreground">({people.length})</span>
        </h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      <p className="text-sm text-muted-foreground">
        People who aren&apos;t in any division, domain or team. To place someone, show people on the chart and drag
        them onto a box.
      </p>
      {people.length === 0 ? (
        <p className="text-muted-foreground">Everyone is in a team.</p>
      ) : (
        <ul className="@container divide-y">
          {people.map((person) => (
            <PersonRow
              key={person.id}
              team={null}
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
    </aside>
  );
}
