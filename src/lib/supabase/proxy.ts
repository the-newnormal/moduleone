import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseEnv } from "./env";

const PROTECTED_PREFIXES = ["/portal"];

function isProtected(pathname: string) {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

// Runs on every request: refreshes the Supabase session cookies, then sends
// signed-out visitors away from protected pages. This is a fast first check only;
// pages still verify the user themselves, and RLS guards the data.
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  let cacheHeaders: Record<string, string> = {};
  const { url, key } = supabaseEnv();

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
        // No-cache headers, so a CDN never serves one user's session cookie to another.
        cacheHeaders = { ...cacheHeaders, ...headers };
        Object.entries(cacheHeaders).forEach(([k, v]) => response.headers.set(k, v));
      },
    },
  });

  // Must run before anything else so a refreshed token lands on the response.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims);
  const { pathname, search } = request.nextUrl;

  const redirectTo = (target: URL) => {
    const redirect = NextResponse.redirect(target);
    // Keep any refreshed or cleared session cookies on the redirect too.
    response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
    Object.entries(cacheHeaders).forEach(([k, v]) => redirect.headers.set(k, v));
    return redirect;
  };

  if (!signedIn && isProtected(pathname)) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    login.searchParams.set("next", pathname + search);
    return redirectTo(login);
  }

  if (signedIn && pathname === "/login") {
    const portal = request.nextUrl.clone();
    portal.pathname = "/portal";
    portal.search = "";
    return redirectTo(portal);
  }

  return response;
}
