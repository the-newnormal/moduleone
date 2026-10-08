// Read lazily (not at import time) so `next build` works in CI without Supabase env vars.
// NEXT_PUBLIC_SUPABASE_ANON_KEY holds the publishable key (sb_publishable_…). It is safe in the browser;
// RLS decides what it can read. The secret key is never read here.
export function supabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. Copy .env.example to .env.local and fill them in.",
    );
  }
  return { url, key };
}
