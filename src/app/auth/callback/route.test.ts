import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@/lib/supabase/server";
import { GET } from "./route";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORIGIN = "https://moduleone.test";
const verifyOtp = vi.fn();
const exchangeCodeForSession = vi.fn();

function callback(query: string) {
  return GET(new NextRequest(`${ORIGIN}/auth/callback${query}`));
}

function location(response: Response) {
  expect(response.status).toBe(307);
  return response.headers.get("location");
}

beforeEach(() => {
  vi.mocked(createClient).mockReset();
  vi.mocked(createClient).mockResolvedValue({
    auth: { verifyOtp, exchangeCodeForSession },
  } as never);
  verifyOtp.mockReset().mockResolvedValue({ error: null });
  exchangeCodeForSession.mockReset().mockResolvedValue({ error: null });
});

describe("GET /auth/callback", () => {
  it("verifies a token_hash and continues to next", async () => {
    const res = await callback("?token_hash=abc&type=email&next=%2Fportal%2Fcheckin%3Fweek%3D2");
    expect(verifyOtp).toHaveBeenCalledWith({ type: "email", token_hash: "abc" });
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(location(res)).toBe(`${ORIGIN}/portal/checkin?week=2`);
  });

  it("exchanges a PKCE code and defaults to /portal", async () => {
    const res = await callback("?code=c0de");
    expect(exchangeCodeForSession).toHaveBeenCalledWith("c0de");
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(location(res)).toBe(`${ORIGIN}/portal`);
  });

  it("prefers token_hash when both are present", async () => {
    await callback("?token_hash=abc&code=c0de");
    expect(verifyOtp).toHaveBeenCalledOnce();
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it.each([
    ["protocol-relative", "//evil.example"],
    ["dot segment", "/.//evil.example"],
    ["absolute URL", "https://evil.example/portal"],
  ])("ignores an unsafe next (%s)", async (_label, next) => {
    const res = await callback(`?token_hash=abc&next=${encodeURIComponent(next)}`);
    expect(location(res)).toBe(`${ORIGIN}/portal`);
  });

  it("sends a failed token_hash back to /login?error=link", async () => {
    verifyOtp.mockResolvedValue({ error: { code: "otp_expired", status: 403 } });
    const res = await callback("?token_hash=old&next=%2Fportal");
    expect(location(res)).toBe(`${ORIGIN}/login?error=link`);
  });

  it("sends a failed code exchange back to /login?error=link", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: { code: "flow_state_not_found", status: 404 } });
    const res = await callback("?code=c0de");
    expect(location(res)).toBe(`${ORIGIN}/login?error=link`);
  });

  it("verifies an invite (type=invite) and continues to next", async () => {
    const res = await callback("?token_hash=inv1&type=invite&next=%2Fportal");
    expect(verifyOtp).toHaveBeenCalledExactlyOnceWith({ type: "invite", token_hash: "inv1" });
    expect(location(res)).toBe(`${ORIGIN}/portal`);
  });

  it("treats a token_hash without a type as type=email", async () => {
    await callback("?token_hash=abc");
    expect(verifyOtp).toHaveBeenCalledExactlyOnceWith({ type: "email", token_hash: "abc" });
  });

  it("sends a failed invite back to /login?error=link", async () => {
    verifyOtp.mockResolvedValue({ error: { code: "otp_expired", status: 403 } });
    const res = await callback("?token_hash=old&type=invite&next=%2Fportal");
    expect(location(res)).toBe(`${ORIGIN}/login?error=link`);
  });

  it.each(["recovery", "email_change", "signup", "magiclink", "sms", "", "EMAIL", "invite "])(
    "refuses any other type (%j) without verifying",
    async (type) => {
      const res = await callback(`?token_hash=abc&type=${encodeURIComponent(type)}&next=%2Fportal`);
      expect(createClient).not.toHaveBeenCalled();
      expect(verifyOtp).not.toHaveBeenCalled();
      expect(location(res)).toBe(`${ORIGIN}/login?error=link`);
    },
  );

  it("refuses a PKCE code with an unknown type", async () => {
    const res = await callback("?code=c0de&type=recovery");
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(location(res)).toBe(`${ORIGIN}/login?error=link`);
  });

  it("sends a link with neither token_hash nor code to /login?error=link", async () => {
    const res = await callback("?next=%2Fportal");
    expect(createClient).not.toHaveBeenCalled();
    expect(location(res)).toBe(`${ORIGIN}/login?error=link`);
  });
});
