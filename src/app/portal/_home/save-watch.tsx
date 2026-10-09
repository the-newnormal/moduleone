"use client";

import { LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { currentSave, pendingSave, wasDeleted } from "../checkin/pending-save";
import type { SaveOutcome } from "../checkin/take";

// Coming back here from the recorder can beat the take's upload: the page was rendered before the
// draft was saved, so it would read "Not started". While this tab still holds a save, say so
// instead, then show the page as it is once the save settles. It only watches the save: the
// recorder and Sign out are the ones that take it over or release it.
export function SaveWatch({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [held, setHeld] = useState<"saving" | "failed" | null>(null);
  const [refreshing, startRefresh] = useTransition();

  useEffect(() => {
    // Read after mounting, not while rendering: leaving the recorder starts its save in an effect
    // cleanup, which React runs in this same commit, after this page rendered but before this.
    const save = currentSave();
    if (!save) return;
    let mounted = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the save only exists from here
    setHeld("saving");
    void pendingSave().then((outcome) => {
      if (!mounted) return;
      if (atRisk(outcome)) return setHeld("failed");
      // Keep saying "Saving…" until the page that knows about the draft has arrived.
      startRefresh(() => {
        setHeld(null);
        router.refresh();
      });
    });
    return () => {
      mounted = false;
    };
  }, [router]);

  if (held === "saving" || refreshing) {
    return (
      <div className="grid gap-3">
        <p role="status" className="flex items-center gap-2 text-[15px] leading-[22px]">
          <LoaderCircle aria-hidden className="size-4 motion-safe:animate-spin" />
          Saving your recording… This page updates when it&apos;s saved.
        </p>
        <Link href="/portal/checkin" className="w-fit text-sm font-medium underline underline-offset-4">
          Open your check-in
        </Link>
      </div>
    );
  }
  if (held === "failed") {
    return (
      <div className="grid gap-3">
        <p role="alert" className="text-[15px] leading-[22px]">
          Your last recording hasn&apos;t been saved yet.
        </p>
        <Button asChild className="h-12 w-full sm:h-10 sm:w-fit">
          <Link href="/portal/checkin">Open your check-in to try again</Link>
        </Button>
      </div>
    );
  }
  return children;
}

// A take that failed to save and is still held in this tab, as Sign out sees it.
const atRisk = (outcome: SaveOutcome | null): boolean =>
  outcome?.step === "failed" && !outcome.updated && !wasDeleted(outcome);
