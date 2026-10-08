import { createBrowserClient } from "@supabase/ssr";
import { supabaseEnv } from "./env";

// Supabase client for Client Components. Uses the publishable key and the user's session cookies.
export function createClient() {
  const { url, key } = supabaseEnv();
  return createBrowserClient(url, key);
}
