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
  person: { id: string; name: string; pendingEmail: string | null };
  setPendingEmail: TeamActions["setPendingEmail"];
  onDone: (message: string) => void;
};

// "Set email" (or "Edit email" once there is one) on a person without a login: the address their
// first invite will go to, noted now and sent nothing (the setPendingEmail server action). Give
// login offers it later. The button stays after a change, so focus goes back to it.
export function SetEmailDialog({ person, setPendingEmail, onDone }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {person.pendingEmail ? "Edit email" : "Set email"}
          <span className="sr-only"> ({person.name})</span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <SetEmailForm
          person={person}
          setPendingEmail={setPendingEmail}
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
export function SetEmailForm({
  person,
  setPendingEmail,
  onBusy,
  onDone,
}: Props & { onBusy?: (busy: boolean) => void }) {
  const id = useId();
  const [email, setEmail] = useState(person.pendingEmail ?? "");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startSaving] = useTransition();

  const save = (address: string | null, message: string) => {
    setFieldError(null);
    setError(null);
    onBusy?.(true);
    startSaving(async () => {
      const result = await settle(() => setPendingEmail(person.id, address), "setPendingEmail");
      startTransition(() => {
        onBusy?.(false);
        if (result.ok) onDone(message);
        else setError(result.error);
      });
    });
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const address = parseEmail(email);
    if (!address.ok) {
      setFieldError(address.error);
      setError(null);
      return;
    }
    save(address.value, `Noted ${address.value} for ${person.name}'s invite. Nobody was emailed.`);
  };

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Email for {person.name}&apos;s invite</DialogTitle>
        <DialogDescription>
          Module One keeps this address for when you give {person.name} a login, and emails nobody now. Only
          admins see it. Use an address only they read: whoever reads the invite can sign in as {person.name}.
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
        {person.pendingEmail && (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => save(null, `Forgot the email noted for ${person.name}.`)}
          >
            Forget email
          </Button>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save email"}
        </Button>
      </DialogFooter>
    </form>
  );
}
