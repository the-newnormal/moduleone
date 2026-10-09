"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { currentSave, failedTakeShown, finishRecording, pendingSave, releaseSave } from "./checkin/pending-save";
import { signOut } from "./actions";

// Signs out, but not while a check-in take is still saving in this tab (the member left the
// recorder, or is recording beside this in the app bar, which finishes the recording first):
// signing out first would end the session the save needs, and lose the take. It waits for the save. If the save failed, it asks: sign out anyway and lose the take, or
// go back to the check-in, where the take is offered again.
const UNSAVED = "Your latest check-in recording hasn't been saved, and signing out would lose it. Sign out anyway?";

export function SignOutButton() {
  const router = useRouter();
  const [waiting, setWaiting] = useState(false);
  const mounted = useRef(false);
  // Set when this button resends the form itself, the member's answer given: let that one through.
  const decided = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    if (decided.current) {
      decided.current = false;
      return; // already waited for, or asked about: the form signs out as usual
    }
    finishRecording(); // a recording still going is finished, so its take is saving now
    if (!currentSave()) {
      // Nothing saving: the form signs out as usual, unless the check-in beside this shows a take
      // whose save failed, and the member would rather stay and try again.
      if (failedTakeShown() && !window.confirm(UNSAVED)) event.preventDefault();
      return;
    }
    event.preventDefault();
    const form = event.currentTarget;
    // Waited for outside a transition: an async transition open this long would hold up every
    // navigation meanwhile (React entangles later transitions with it).
    setWaiting(true);
    void pendingSave().then((outcome) => {
      if (!mounted.current) return; // the member went elsewhere meanwhile
      setWaiting(false);
      if (outcome?.step === "failed" && !outcome.updated && !window.confirm(UNSAVED)) {
        router.push("/portal/checkin");
        return;
      }
      releaseSave();
      decided.current = true;
      form.requestSubmit(); // nothing held now, so the form signs out as usual
    });
  }

  return (
    <form action={signOut} onSubmit={onSubmit}>
      {/* The full words fit beside the tabs only on wide screens; the name is always the full words. */}
      <Button type="submit" variant="outline" disabled={waiting} aria-label={waiting ? "Saving your check-in…" : undefined}>
        {waiting ? (
          <>
            <span className="lg:hidden">Saving…</span>
            <span className="max-lg:hidden">Saving your check-in…</span>
          </>
        ) : (
          "Sign out"
        )}
      </Button>
    </form>
  );
}
