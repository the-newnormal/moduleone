import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { safeNextPath } from "@/lib/auth/safe-next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in · Module One" };

const ERRORS = new Map([
  ["link", "That sign-in link has expired or was already used. Request a new one below."],
  [
    "signout",
    "You're signed out on this device, but we couldn't sign out your other devices. To retry, sign in and sign out again.",
  ],
]);

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const next = safeNextPath(one(params.next));
  const error = ERRORS.get(one(params.error) ?? "");

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1 className="text-3xl">Module One</h1>
          </CardTitle>
          <CardDescription>The Normal weekly check-in. Sign in with your work email.</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm next={next} notice={error} />
        </CardContent>
      </Card>
    </main>
  );
}
