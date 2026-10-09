"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

// Admin pages throw when Supabase refuses a load or the admin check fails; say so plainly. (Renders
// inside the admin layout, which never throws for a failed check; see requireAdminLayout.)
export default function AdminError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div className="grid gap-4">
      <h1 className="text-4xl">Admin</h1>
      <p className="rounded-xl border bg-card p-6">
        This page couldn&apos;t load just now. Try again, and if it keeps happening, send the project
        owner this code: <code className="font-mono text-sm">{error.digest ?? "no code"}</code>.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => retry()}>Try again</Button>
        <Link href="/portal" className="text-sm text-muted-foreground hover:text-foreground">
          ← Portal
        </Link>
      </div>
    </div>
  );
}
