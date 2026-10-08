import { createServerClient, type CookieMethodsServer, type SetAllCookies } from "@supabase/ssr";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateSession } from "./proxy";

vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn() }));

const ORIGIN = "https://moduleone.test";
const CACHE_HEADERS = {
  "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
  Expires: "0",
  Pragma: "no-cache",
};

// Fakes the Supabase client: getClaims reports `signedIn` and, like a real token
// refresh (or a cleared session), can hand new cookies to setAll first.
function fakeSupabase({
  signedIn,
  refreshed,
}: {
  signedIn: boolean;
  refreshed?: Parameters<SetAllCookies>[0];
}) {
  vi.mocked(createServerClient).mockImplementation((_url, _key, options) => {
    const cookies = options.cookies as CookieMethodsServer;
    return {
      auth: {
        getClaims: async () => {
          if (refreshed) await cookies.setAll!(refreshed, CACHE_HEADERS);
          return { data: signedIn ? { claims: { sub: "u1" } } : null, error: null };
        },
      },
    } as never;
  });
}

function visit(path: string) {
  return updateSession(new NextRequest(`${ORIGIN}${path}`));
}

function redirectTarget(response: Response) {
  expect(response.status).toBe(307);
  return new URL(response.headers.get("location")!);
}

function passesThrough(response: Response) {
  return response.headers.get("x-middleware-next") === "1";
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("updateSession", () => {
  it.each([
    ["/portal", "/portal"],
    ["/portal/checkin?week=2", "/portal/checkin?week=2"],
  ])("sends a signed-out visitor from %s to /login?next=…", async (path, next) => {
    fakeSupabase({ signedIn: false });
    const target = redirectTarget(await visit(path));
    expect(target.origin).toBe(ORIGIN);
    expect(target.pathname).toBe("/login");
    expect([...target.searchParams]).toEqual([["next", next]]);
  });

  it.each(["/login", "/portalx", "/auth/callback?code=c0de"])(
    "lets a signed-out visitor through to %s",
    async (path) => {
      fakeSupabase({ signedIn: false });
      expect(passesThrough(await visit(path))).toBe(true);
    },
  );

  it("sends a signed-in user from /login to /portal", async () => {
    fakeSupabase({ signedIn: true });
    const target = redirectTarget(await visit("/login?next=%2Fportal%2Fcheckin"));
    expect(target.href).toBe(`${ORIGIN}/portal`);
  });

  it("lets a signed-in user through to /portal", async () => {
    fakeSupabase({ signedIn: true });
    expect(passesThrough(await visit("/portal/checkin"))).toBe(true);
  });

  it("puts refreshed cookies and no-cache headers on a pass-through response", async () => {
    fakeSupabase({
      signedIn: true,
      refreshed: [{ name: "sb-test-auth-token", value: "fresh", options: { path: "/", maxAge: 3600 } }],
    });
    const res = await visit("/portal");
    expect(passesThrough(res)).toBe(true);
    expect(res.headers.get("set-cookie")).toContain("sb-test-auth-token=fresh");
    expect(res.headers.get("cache-control")).toBe(CACHE_HEADERS["Cache-Control"]);
    expect(res.headers.get("pragma")).toBe("no-cache");
    // …and on the request, so the page renders with the refreshed session.
    expect(res.headers.get("x-middleware-request-cookie")).toContain("sb-test-auth-token=fresh");
  });

  it.each([
    ["a refreshed session on /login", true, "/login", "fresh", 3600],
    ["a cleared session on /portal", false, "/portal", "", 0],
  ])("keeps cookies and no-cache headers on the redirect for %s", async (_l, signedIn, path, value, maxAge) => {
    fakeSupabase({
      signedIn,
      refreshed: [{ name: "sb-test-auth-token", value, options: { path: "/", maxAge } }],
    });
    const res = await visit(path);
    redirectTarget(res);
    expect(res.cookies.get("sb-test-auth-token")).toMatchObject({ value, path: "/", maxAge });
    expect(res.headers.get("cache-control")).toBe(CACHE_HEADERS["Cache-Control"]);
    expect(res.headers.get("expires")).toBe("0");
    expect(res.headers.get("pragma")).toBe("no-cache");
  });
});
