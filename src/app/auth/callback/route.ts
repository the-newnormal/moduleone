import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { safeNextPath } from "@/lib/auth/safe-next";
import { createClient } from "@/lib/supabase/server";

// Sign-in and invite links land here, then continue to `next` (same-site paths only).
// - ?token_hash=…&type=email: from our magic-link template. Works on any device or browser.
// - ?token_hash=…&type=invite: from our invite template (an admin gave this person a login).
// - ?code=…: Supabase's default template (PKCE). Only works in the browser that asked for the link.
// `type` defaults to email; any other value is refused, so a link can't ask for another kind of
// verification (password recovery, email change, …) that this app doesn't handle.
const LINK_TYPES: ReadonlySet<EmailOtpType> = new Set<EmailOtpType>(["email", "invite"]);

const isLinkType = (value: string): value is EmailOtpType => LINK_TYPES.has(value as EmailOtpType);

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const code = searchParams.get("code");
  const type = searchParams.get("type") ?? "email";
  const next = safeNextPath(searchParams.get("next"));

  if ((tokenHash || code) && isLinkType(type)) {
    const supabase = await createClient();
    const { error } = tokenHash
      ? await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
      : await supabase.auth.exchangeCodeForSession(code!);
    if (!error) {
      return NextResponse.redirect(new URL(next, origin));
    }
  }

  return NextResponse.redirect(new URL("/login?error=link", origin));
}
