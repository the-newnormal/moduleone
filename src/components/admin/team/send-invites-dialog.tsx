"use client";

import { startTransition, useState, useTransition } from "react";
import {
  ALREADY_HAS_LOGIN,
  EARLIER_LOGIN,
  EMAIL_FORMAT,
  EMAIL_TAKEN,
  HOLDS_GRANTS,
  INVITE_RACE,
  MASTER_ADMIN_LOGIN,
  NOT_YOURSELF,
  NOTE_CHANGED,
  NOTED_FOR_SOMEONE_ELSE,
  PERSON_CHANGED,
  PERSON_GONE,
  PERSON_REMOVED,
} from "@/app/admin/teams/[id]/messages";
import { ActionError } from "@/components/admin/action-error";
import { focusSoon } from "@/components/admin/focus";
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
import { settle } from "@/lib/admin/errors";
import type { TeamActions } from "./types";

// Someone with an email noted for their first invite, and no login yet.
export type Invitee = { id: string; name: string; email: string };

// Refusals about one person (their address, their records, their row): the others still get their
// invites. Anything else (too many emails, no email sender, no site URL, no service key, no
// permission, something went wrong) would most likely refuse everyone after them too, so sending
// stops there.
const ABOUT_ONE_PERSON: ReadonlySet<string> = new Set([
  ALREADY_HAS_LOGIN,
  EARLIER_LOGIN,
  EMAIL_FORMAT,
  EMAIL_TAKEN,
  HOLDS_GRANTS,
  INVITE_RACE,
  MASTER_ADMIN_LOGIN,
  NOT_YOURSELF,
  NOTE_CHANGED,
  NOTED_FOR_SOMEONE_ELSE,
  PERSON_CHANGED,
  PERSON_GONE,
  PERSON_REMOVED,
]);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export type InviteRun = {
  sent: Invitee[];
  refused: { person: Invitee; error: string }[];
  // Why sending stopped before the end, and who it didn't get to.
  stopped: { error: string; left: Invitee[] } | null;
};

// Send each invite in turn with giveLogin, the same checks and the same invite as Give login on
// each row, plus one: the address must still be the one noted for them (asNoted), since the page
// may be older than another admin's correction. `onProgress` hears how many have been tried.
// Exported for tests.
export async function sendInvites(
  invitees: readonly Invitee[],
  giveLogin: TeamActions["giveLogin"],
  onProgress?: (tried: number) => void,
): Promise<InviteRun> {
  const run: InviteRun = { sent: [], refused: [], stopped: null };
  for (const [index, person] of invitees.entries()) {
    const result = await settle(() => giveLogin(person.id, person.email, true), "giveLogin");
    onProgress?.(index + 1);
    if (result.ok) {
      run.sent.push(person);
    } else if (ABOUT_ONE_PERSON.has(result.error)) {
      run.refused.push({ person, error: result.error });
    } else {
      run.stopped = { error: result.error, left: invitees.slice(index) };
      break;
    }
  }
  return run;
}

// What the page's status line says once sending is over.
export function invitesMessage(run: InviteRun): string {
  const sent = run.sent.length > 0 ? `Sent ${plural(run.sent.length, "invite", "invites")}.` : "No invites were sent.";
  const notSent = run.refused.length + (run.stopped?.left.length ?? 0);
  return notSent === 0 ? sent : `${sent} ${plural(notSent, "person still needs", "people still need")} one: see their rows.`;
}

// "Send invites": a first invite to everyone in this node who has an email noted for it and no
// login, one after another (each exactly as Give login sends it). The list is fixed when the
// dialog opens, so rows changing as invites go out don't change who it's for. While it sends, the
// dialog can't be closed; afterwards it says who got an invite, who didn't and why. People with a
// login drop off the page as it refreshes, so once it closes after sending (or once nobody is left
// to offer it to), focus goes to `focusAfter` (a selector). The dialog stays mounted with its
// content while it animates closed, and when the button has gone.
export function SendInvitesDialog({
  invitees,
  giveLogin,
  onDone,
  focusAfter,
}: {
  invitees: readonly Invitee[];
  giveLogin: TeamActions["giveLogin"];
  onDone: (message: string) => void;
  focusAfter: string;
}) {
  const [open, setOpen] = useState(false);
  // Who it's for, fixed when it opens; and what happened. Both stay while it animates closed.
  const [batch, setBatch] = useState<readonly Invitee[]>([]);
  const [tried, setTried] = useState(0);
  const [run, setRun] = useState<InviteRun | null>(null);
  const [busy, startSending] = useTransition();

  const start = (people: readonly Invitee[]) => {
    setTried(0);
    startSending(async () => {
      // Progress is set after each await, so it shows at once (it isn't part of the transition).
      const result = await sendInvites(people, giveLogin, setTried);
      startTransition(() => {
        setRun(result);
        onDone(invitesMessage(result));
      });
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (next) {
          setBatch([...invitees]);
          setRun(null);
          setTried(0);
        }
        setOpen(next);
      }}
    >
      {/* Once the last invite has gone, the button has nobody to offer: it goes, but the dialog
          stays open with what happened. */}
      {invitees.length > 0 && (
        <DialogTrigger asChild>
          <Button type="button" variant="outline">
            Send invites ({invitees.length})
          </Button>
        </DialogTrigger>
      )}
      <DialogContent
        onCloseAutoFocus={(event) => {
          // After sending the button may offer fewer people, and with nobody left it's gone (also
          // when other admins' invites took everyone meanwhile): focus the heading.
          if (run || invitees.length === 0) {
            event.preventDefault();
            focusSoon(focusAfter);
          }
        }}
      >
        <SendInvitesPanel batch={batch} busy={busy} tried={tried} run={run} onSend={() => start(batch)} />
      </DialogContent>
    </Dialog>
  );
}

// The dialog's content (exported for tests): who it's for, then how sending goes.
export function SendInvitesPanel({
  batch,
  busy,
  tried,
  run,
  onSend,
}: {
  batch: readonly Invitee[];
  busy: boolean;
  tried: number;
  run: InviteRun | null;
  onSend: () => void;
}) {
  const n = batch.length;
  return (
    <div className="grid min-w-0 gap-4">
      <DialogHeader>
        <DialogTitle>{run ? (run.sent.length > 0 ? "Invites sent" : "No invites sent") : `Send ${plural(n, "invite", "invites")}?`}</DialogTitle>
        <DialogDescription>
          {run
            ? invitesMessage(run)
            : `Module One emails each of them a link that signs them in, at the address noted for them, as Give login does. ` +
              `Check the addresses first: whoever reads an invite can sign in as that person.`}
        </DialogDescription>
      </DialogHeader>

      {!run && (
        <ul aria-label="Who gets an invite" className="max-h-64 divide-y overflow-y-auto rounded-md border text-sm">
          {batch.map((person) => (
            <li key={person.id} className="px-3 py-2 break-words">
              <span className="font-medium">{person.name}</span> · {person.email}
            </li>
          ))}
        </ul>
      )}

      <p role="status" className="text-sm empty:hidden">
        {busy ? `Sending ${Math.min(tried + 1, n)} of ${n}…` : ""}
      </p>

      {run && run.refused.length > 0 && (
        <section className="grid gap-1.5">
          <h3 className="text-sm font-medium">Not sent</h3>
          <ul className="grid gap-1 text-sm">
            {run.refused.map(({ person, error }) => (
              <li key={person.id} className="break-words">
                <span className="font-medium">{person.name}</span> ({person.email}): {error}
              </li>
            ))}
          </ul>
        </section>
      )}
      {run?.stopped && (
        <ActionError
          message={`Sending stopped: ${run.stopped.error} Not sent yet: ${run.stopped.left.map((p) => p.name).join(", ")}.`}
        />
      )}

      <DialogFooter>
        {run ? (
          <DialogClose asChild>
            <Button type="button">Close</Button>
          </DialogClose>
        ) : (
          <>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" disabled={busy} onClick={onSend}>
              {busy ? "Sending…" : `Send ${plural(n, "invite", "invites")}`}
            </Button>
          </>
        )}
      </DialogFooter>
    </div>
  );
}
