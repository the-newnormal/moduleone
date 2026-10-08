"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { deleteDraft, submitCheckin, type DeleteDraftResult, type SubmitCheckinResult } from "./actions";
import { settled } from "./unreachable";

// Delete the take and record again, or submit it, with a confirm step because a submitted check-in
// can't be changed. On success each action re-renders the page, which replaces these controls.
export function DraftControls() {
  const [deleted, deleteAction, deleting] = useActionState<DeleteDraftResult | null>(settled(deleteDraft), null);
  const [sent, submitAction, submitting] = useActionState<SubmitCheckinResult | null>(settled(submitCheckin), null);
  const [confirming, setConfirming] = useState(false);
  const submitButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  const busy = deleting || submitting;
  const error = sent?.status === "error" ? sent.message : deleted?.status === "error" ? deleted.message : null;

  // Focus follows the confirm step: onto "Yes, submit" when it opens, back to "Submit check-in"
  // when it is cancelled.
  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
    else if (wasConfirming.current) submitButton.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  return (
    <div className="grid gap-3">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {confirming ? (
        <form action={submitAction} className="grid gap-3 rounded-md bg-muted px-4 py-3">
          <p className="text-sm font-medium">You can&apos;t change it after submitting.</p>
          <div className="flex flex-wrap gap-2">
            <Button ref={confirmButton} type="submit" disabled={busy}>
              {submitting ? "Submitting…" : "Yes, submit"}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button ref={submitButton} type="button" disabled={busy} onClick={() => setConfirming(true)}>
            Submit check-in
          </Button>
          <form action={deleteAction}>
            <Button type="submit" variant="outline" disabled={busy}>
              {deleting ? "Deleting…" : "Delete and record again"}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
