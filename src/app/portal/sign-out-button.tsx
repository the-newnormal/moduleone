"use client";

import { useRouter } from "next/navigation";
import { useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { currentSave, pendingSave } from "./checkin/pending-save";
import { signOut } from "./actions";

// Signs out, but not while a check-in take is still saving in this tab (the member left the
// recorder and came here): signing out first would end the session the save needs, and lose the
// take. It waits for the save; if the save failed, it goes back to the check-in, where the take is
// offered again, instead of signing out.
export function SignOutButton() {
  const router = useRouter();
  const [waiting, startWaiting] = useTransition();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    if (!currentSave()) return; // nothing saving: the form signs out as usual
    event.preventDefault();
    startWaiting(async () => {
      const outcome = await pendingSave();
      if (outcome?.step === "failed" && !outcome.updated) router.push("/portal/checkin");
      else await signOut();
    });
  }

  return (
    <form action={signOut} onSubmit={onSubmit}>
      <Button type="submit" variant="outline" size="sm" disabled={waiting}>
        {waiting ? "Saving your check-in…" : "Sign out"}
      </Button>
    </form>
  );
}
