"use client";

import { LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { currentSave, pendingSave, wasDeleted } from "../checkin/pending-save";
import type { SaveOutcome } from "../checkin/take";

// Coming back here from the recorder can beat the take's upload: the page was rendered before the
// draft was saved, so it would read "Not started". While this tab still holds a save, say so
// instead, then show the page as it is once the save settles. It only watches the save: the
// recorder and Sign out are the ones that take it over or release it.
export function SaveWatch({ children }: { children: ReactNode }) {
  // Read once, as the recorder does: the module holds nothing on a full page load, so the server
  // render and the first client render agree.
  const [save] = useState(currentSave);
  const router = useRouter();
  const [outcome, setOutcome] = useState<SaveOutcome | null | "waiting">(save ? "waiting" : null);

  useEffect(() => {
    if (!save) return;
    let mounted = true;
    void pendingSave().then((settled) => {
      if (!mounted) return;
      setOutcome(settled);
      if (!atRisk(settled)) router.refresh();
    });
    return () => {
      mounted = false;
    };
  }, [save, router]);

  if (outcome === "waiting") {
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
  if (atRisk(outcome)) {
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
const atRisk = (outcome: SaveOutcome | null | "waiting"): boolean =>
  outcome !== null && outcome !== "waiting" && outcome.step === "failed" && !outcome.updated && !wasDeleted(outcome);
