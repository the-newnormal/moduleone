"use client";

import { startTransition, useId, useState, useTransition } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { settle } from "@/lib/admin/errors";
import { parseEmail } from "@/lib/admin/validate";
import type { TeamActions } from "./types";

type Props = {
  person: { id: string; name: string };
  changeEmail: TeamActions["changeEmail"];
  onDone: (message: string) => void;
};

// "Change email" on a person with a login: the address they sign in with from now on, then the
// changeEmail server action. The page never knows their current address (it stays on the server),
// so this asks only for the new one. The button stays after a change, so focus goes back to it.
export function ChangeEmailDialog({ person, changeEmail, onDone }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          Change email<span className="sr-only"> ({person.name})</span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <ChangeEmailForm
          person={person}
          changeEmail={changeEmail}
          onBusy={setBusy}
          onDone={(message) => {
            setOpen(false);
            onDone(message);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

// The dialog's content (exported for tests). Its state resets each time the dialog opens.
export function ChangeEmailForm({
  person,
  changeEmail,
  onBusy,
  onDone,
}: Props & { onBusy?: (busy: boolean) => void }) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startSaving] = useTransition();

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const address = parseEmail(email);
    if (!address.ok) {
      setFieldError(address.error);
      setError(null);
      return;
    }
    setFieldError(null);
    setError(null);
    onBusy?.(true);
    startSaving(async () => {
      const result = await settle(() => changeEmail(person.id, address.value), "changeEmail");
      startTransition(() => {
        onBusy?.(false);
        if (!result.ok) setError(result.error);
        else if (result.value.invited) {
          onDone(`Sent ${person.name} a new invite at ${address.value}. They sign in from the link in it.`);
        } else {
          onDone(`${person.name} signs in with ${address.value} from now on. Module One didn't email them.`);
        }
      });
    });
  };

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Change {person.name}&apos;s sign-in email</DialogTitle>
        <DialogDescription>
          {person.name} signs in with a link sent to this address. Use an address only they read: whoever reads
          it can sign in as {person.name}. If they&apos;ve used their login already (or it was set up ready to
          use), nobody is emailed about the change, so tell them yourself; they stay signed in where they are.
          If they&apos;re still waiting to use their invite, a new one goes to the new address and the old one
          stops working.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-email`}>New email address</Label>
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
          {pending ? "Changing…" : "Change email"}
        </Button>
      </DialogFooter>
    </form>
  );
}
