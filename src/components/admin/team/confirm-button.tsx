"use client";

import { type ReactNode, startTransition, useRef, useState, useTransition } from "react";
import { ActionError } from "@/components/admin/action-error";
import { focusSoon } from "@/components/admin/focus";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { type ActionResult, settle } from "@/lib/admin/errors";

// A button that asks first, then runs a server action. The dialog stays open while it runs (it
// can't be closed meanwhile) and shows the refusal if there is one; on success it closes and calls
// onDone with what the action answered. Focus then goes back to the button, or to `focusAfter` (a
// selector) when the success takes the button away (the row it was in is gone).
export function ConfirmButton<T = null>({
  label,
  title,
  description,
  confirmLabel,
  pendingLabel = "Saving…",
  destructive = false,
  run,
  context,
  onDone,
  focusAfter,
}: {
  label: ReactNode; // the button's text; include the person's name for screen readers
  title: string;
  description: ReactNode;
  confirmLabel: string;
  pendingLabel?: string; // the confirm button's text while the action runs
  destructive?: boolean;
  run: () => Promise<ActionResult<T>>;
  context: string; // the server action's name, for the log if it throws
  onDone?: (value: T) => void;
  focusAfter?: string;
}) {
  const [open, setOpen] = useState(false);
  const succeeded = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startWorking] = useTransition();

  const confirm = () =>
    startWorking(async () => {
      const result = await settle(run, context);
      // State set after an await isn't part of the transition unless wrapped again.
      startTransition(() => {
        if (result.ok) {
          succeeded.current = true;
          setOpen(false);
          onDone?.(result.value);
        } else {
          setError(result.error);
        }
      });
    });

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        setError(null);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          if (succeeded.current && focusAfter) {
            event.preventDefault();
            focusSoon(focusAfter);
          }
          succeeded.current = false;
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <ActionError message={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            disabled={pending}
            onClick={confirm}
          >
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
