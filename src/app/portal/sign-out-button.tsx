"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { currentSave, pendingSave, releaseSave } from "./checkin/pending-save";
import { signOut } from "./actions";

// Signs out, but not while a check-in take is still saving in this tab (the member left the
// recorder and came here): signing out first would end the session the save needs, and lose the
// take. It waits for the save. If the save failed, it asks: sign out anyway and lose the take, or
// go back to the check-in, where the take is offered again.
const UNSAVED = "Your latest check-in recording hasn't been saved, and signing out would lose it. Sign out anyway?";

export function SignOutButton() {
  const router = useRouter();
  const [waiting, setWaiting] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    if (!currentSave()) return; // nothing saving: the form signs out as usual
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
      form.requestSubmit(); // nothing held now, so the form signs out as usual
    });
  }

  return (
    <form action={signOut} onSubmit={onSubmit}>
      <Button type="submit" variant="outline" disabled={waiting}>
        {waiting ? "Saving your check-in…" : "Sign out"}
      </Button>
    </form>
  );
}
