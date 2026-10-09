"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { deleteDraft, submitCheckin, type DeleteDraftResult, type SubmitCheckinResult } from "./actions";
import { forgetDeletedTake, pendingSave } from "./pending-save";
import { settled } from "./unreachable";

async function deleteTake(path: string) {
  const result = await deleteDraft(path);
  // A save of this take may still be held in this tab, failed because its reply was lost after it
  // had saved; it must not come back as a take to save again.
  if (result.status === "deleted" && result.path) forgetDeletedTake(result.path);
  return result;
}

// Submits the take on screen, but not past a newer take this tab is still saving (wait for it: if it
// saves, it is the draft now, and the database refuses this stale submit) or holds unsaved (it is
// shown under the draft; the member saves or discards it first).
async function submitShown(path: string): Promise<SubmitCheckinResult> {
  const held = await pendingSave();
  if (held?.step === "failed" && !held.updated && held.take.uploadedPath !== path) {
    return { status: "error", code: "failed", message: HELD_TAKE };
  }
  return submitCheckin(path);
}

const HELD_TAKE = "A newer recording on this device hasn't been saved yet. Try again or discard it below first.";

// Delete the take and record again, or submit it, with a confirm step because a submitted check-in
// can't be changed. On success each action re-renders the page, which replaces these controls.
// `path` is the take on screen: if another tab or device has saved a newer one since, neither
// action touches it, and the page shows that one instead.
export function DraftControls({ path }: { path: string }) {
  const [deleted, deleteAction, deleting] = useActionState<DeleteDraftResult | null>(
    settled(() => deleteTake(path)),
    null,
  );
  const [sent, submitAction, submitting] = useActionState<SubmitCheckinResult | null>(
    settled(() => submitShown(path)),
    null,
  );
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
