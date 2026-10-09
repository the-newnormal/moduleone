"use client";

import { startTransition, useId, useRef, useState, useTransition } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { settle } from "@/lib/admin/errors";
import { parseEmail } from "@/lib/admin/validate";
import type { TeamActions } from "./types";

type Props = {
  person: { id: string; name: string };
  giveLogin: TeamActions["giveLogin"];
  onDone: (message: string) => void;
};

// "Give login" on a person without one: an email address, then the giveLogin server action
// (which invites that address and links the login to this person). Once it's given, this button
// goes away, so focus goes to `focusAfter` (a selector).
export function GiveLoginDialog({ person, giveLogin, onDone, focusAfter }: Props & { focusAfter: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const given = useRef(false);

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          Give login<span className="sr-only"> ({person.name})</span>
        </Button>
      </DialogTrigger>
      <DialogContent
        onCloseAutoFocus={(event) => {
          if (given.current) {
            event.preventDefault();
            focusSoon(focusAfter);
          }
          given.current = false;
        }}
      >
        <GiveLoginForm
          person={person}
          giveLogin={giveLogin}
          onBusy={setBusy}
          onDone={(message) => {
            given.current = true;
            setOpen(false);
            onDone(message);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

// The dialog's content (exported for tests). Its state resets each time the dialog opens.
export function GiveLoginForm({
  person,
  giveLogin,
  onBusy,
  onDone,
}: Props & { onBusy?: (busy: boolean) => void }) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startSending] = useTransition();

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const address = parseEmail(email);
    if (!address.ok) {
      setFieldError(address.error);
      return;
    }
    setFieldError(null);
    setError(null);
    onBusy?.(true);
    startSending(async () => {
      const result = await settle(() => giveLogin(person.id, address.value), "giveLogin");
      startTransition(() => {
        onBusy?.(false);
        if (result.ok) {
          onDone(`Invite sent to ${address.value}. ${person.name} can sign in from the link in it.`);
        } else {
          setError(result.error);
        }
      });
    });
  };

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Give {person.name} a login</DialogTitle>
        <DialogDescription>
          Module One emails this address a link that signs in as {person.name}. Use an address only
          they read. After using the link once, they sign in at the login page with that address.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-email`}>Email address</Label>
        <Input
          id={`${id}-email`}
          type="email"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setFieldError(null);
          }}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? `${id}-email-error` : undefined}
        />
        {fieldError && (
          <p id={`${id}-email-error`} className="text-xs text-destructive">
            {fieldError}
          </p>
        )}
      </div>
      <ActionError message={error} />
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={pending}>
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={pending}>
          {pending ? "Sending…" : "Send invite"}
        </Button>
      </DialogFooter>
    </form>
  );
}
