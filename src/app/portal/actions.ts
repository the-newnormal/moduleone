"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function signOut() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();
  if (error) {
    // auth-js clears this browser's session cookies before it returns a /logout error (and the
    // proxy has just refreshed the session, so loading it doesn't fail first). The user is
    // signed out here; what failed is signing out their other devices. Say so, don't hide it.
    console.error("signOut failed", { code: error.code, status: error.status });
    redirect("/login?error=signout");
  }
  redirect("/login");
}
