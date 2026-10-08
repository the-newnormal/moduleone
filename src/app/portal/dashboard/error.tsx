"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

// The dashboard and drill-in pages throw when Supabase refuses a query; say so plainly.
export default function DashboardError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="mx-auto grid w-full max-w-3xl gap-4 px-4 py-10">
      <h1 className="text-4xl">Team health</h1>
      <p className="rounded-xl border bg-card p-6">
        The dashboard couldn&apos;t load just now. Try again, and if it keeps happening, send an admin
        this code: <code className="font-mono text-sm">{error.digest ?? "no code"}</code>.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => retry()}>Try again</Button>
        <Link href="/portal" className="text-sm text-muted-foreground hover:text-foreground">
          ← Portal
        </Link>
      </div>
    </main>
  );
}
