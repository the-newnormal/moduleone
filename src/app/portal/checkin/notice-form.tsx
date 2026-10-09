"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { acceptNotice, type AcceptNoticeResult } from "./actions";
import { settled } from "./unreachable";

// On success the action re-renders the page, which then shows the recorder. `version` is the
// notice shown above the form, so consent is recorded for what the member read.
export function NoticeForm({ version }: { version: string }) {
  const [state, formAction, pending] = useActionState<AcceptNoticeResult | null>(
    settled(() => acceptNotice(version)),
    null,
  );

  return (
    <form action={formAction} className="grid gap-3">
      {state?.status === "error" && (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      )}
      <Button type="submit" disabled={pending} className="justify-self-start">
        {pending ? "Saving…" : "I understand, continue"}
      </Button>
    </form>
  );
}
