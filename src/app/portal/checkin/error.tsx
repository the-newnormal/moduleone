"use client";

import { Button } from "@/components/ui/button";

// A last resort if something on the check-in page throws: say so, and offer to load it again.
export default function CheckinError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="mx-auto grid w-full max-w-2xl gap-4 px-4 py-12">
      <h1 className="text-4xl">Weekly check-in</h1>
      <p role="alert">Something went wrong. Check your connection, then try again.</p>
      <Button type="button" className="justify-self-start" onClick={() => retry()}>
        Try again
      </Button>
    </main>
  );
}
