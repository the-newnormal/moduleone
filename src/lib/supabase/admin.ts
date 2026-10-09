import "server-only";
import { createClient } from "@supabase/supabase-js";

// THE ONLY SERVICE-ROLE CLIENT. It bypasses RLS entirely, so exactly one file may import it: the
// admin team page's actions (src/app/admin/teams/[id]/actions.ts), where giveLogin invites an
// email and links the new login to a member row, and resendInvite re-sends an unused invite, each
// after checking, as the signed-in admin, that it may. Everything else reads and writes as the
// signed-in user (./server.ts) so RLS decides.
// admin-imports.test.ts fails if anything else imports this file.
//
// `server-only` makes a build fail if a Client Component ever imports it, and the key has no
// NEXT_PUBLIC_ prefix, so Next.js never puts it in a browser bundle.

export const MISSING_SERVICE_KEY_MESSAGE =
  "Logins can't be given from this server yet (SUPABASE_SERVICE_ROLE_KEY is not set).";

export class MissingServiceKeyError extends Error {
  constructor() {
    super(MISSING_SERVICE_KEY_MESSAGE);
    this.name = "MissingServiceKeyError";
  }
}

// Read the environment lazily (not at import time), like ./env.ts, so `next build` works without
// it. Throws MissingServiceKeyError when SUPABASE_SERVICE_ROLE_KEY isn't set. Make a new client
// per request; it keeps no session.
export function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new MissingServiceKeyError();
  if (!url) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL. Copy .env.example to .env.local and fill it in.");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
