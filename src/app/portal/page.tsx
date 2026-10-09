import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { logError } from "@/lib/admin/errors";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "./actions";

export const metadata: Metadata = { title: "Portal · Module One" };

export default async function PortalPage() {
  const supabase = await createClient();
  // The proxy already redirects signed-out visitors; check again here so the page
  // never renders without a verified user.
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) redirect("/login?next=/portal");

  // The admin pages check the grant again themselves; this only decides whether to show the link.
  const admin = await supabase.rpc("app_has_grant", { requested: "admin" });
  if (admin.error) logError("portal admin check", admin.error);
  const isAdmin = admin.data === true;

  return (
    <main className="mx-auto grid w-full max-w-2xl gap-8 px-4 py-12">
      <header className="flex items-start justify-between gap-4">
        <div className="grid gap-1">
          <h1 className="text-4xl">Portal</h1>
          <p className="text-sm text-muted-foreground">
            Signed in as <span className="font-medium text-foreground">{data.claims.email}</span>
          </p>
        </div>
        <form action={signOut}>
          <Button type="submit" variant="outline" size="sm">
            Sign out
          </Button>
        </form>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-2xl">Weekly check-in</h2>
          </CardTitle>
          <CardDescription>
            Five minutes, three questions. The recorder arrives in the next release.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-2xl">
              <Link href="/portal/dashboard" className="hover:underline">
                Team health
              </Link>
            </h2>
          </CardTitle>
          <CardDescription>The red, yellow and green heat-map of check-ins, week by week.</CardDescription>
        </CardHeader>
      </Card>

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="text-2xl">
                <Link href="/admin" className="hover:underline">
                  Admin
                </Link>
              </h2>
            </CardTitle>
            <CardDescription>
              Change the team structure, who is in each team, and the scoring settings.
            </CardDescription>
          </CardHeader>
        </Card>
      )}
    </main>
  );
}
