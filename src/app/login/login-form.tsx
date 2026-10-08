"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sendMagicLink, type LoginState } from "./actions";

const initialState: LoginState = { status: "idle" };

// `notice` is a message from the URL (e.g. an expired link). It hides once a new link is sent.
export function LoginForm({ next, notice }: { next: string; notice?: string }) {
  const [state, formAction, pending] = useActionState(sendMagicLink, initialState);

  if (state.status === "sent") {
    return (
      <p role="status" className="text-sm leading-6">
        If <span className="font-medium">{state.email}</span> has access, a sign-in link is on its
        way. It expires in an hour. You can close this tab.
      </p>
    );
  }

  return (
    <form action={formAction} className="grid gap-4">
      {notice && (
        <p role="alert" className="rounded-md bg-muted px-3 py-2 text-sm">
          {notice}
        </p>
      )}
      <input type="hidden" name="next" value={next} />
      <div className="grid gap-2">
        <Label htmlFor="email">Work email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@newnormal.sg"
          // React resets the form after each submit; keep what they typed when there's an error.
          defaultValue={state.status === "error" ? state.email : undefined}
          required
          aria-invalid={state.status === "error" || undefined}
          aria-describedby={state.status === "error" ? "login-error" : undefined}
        />
      </div>
      {state.status === "error" && (
        <p id="login-error" role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Email me a sign-in link"}
      </Button>
    </form>
  );
}
