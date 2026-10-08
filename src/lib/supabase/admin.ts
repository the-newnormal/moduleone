import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Supabase client with the service-role (secret) key. It bypasses RLS, so use it only for writes
// the app makes on a member's behalf after taking the member from the session (CLAUDE.md), and
// never send anything it returns to the browser unchecked.
//
// A plain supabase-js client, not the cookie-based @supabase/ssr one: that one would send the
// signed-in user's JWT instead, and every service-role write would fail with 42501.
export function createAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (server-only). Set them in .env.local and in Vercel.",
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
