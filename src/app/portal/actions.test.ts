import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "./actions";

// Like the real redirect(), stop the action at the first call.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const authSignOut = vi.fn();

beforeEach(() => {
  vi.mocked(redirect).mockClear();
  vi.mocked(createClient).mockResolvedValue({ auth: { signOut: authSignOut } } as never);
  authSignOut.mockReset().mockResolvedValue({ error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("signOut", () => {
  it("signs out and goes to /login", async () => {
    await expect(signOut()).rejects.toThrow("NEXT_REDIRECT /login");
    expect(authSignOut).toHaveBeenCalledOnce();
    expect(redirect).toHaveBeenCalledExactlyOnceWith("/login");
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([
    ["the sign-in service is unreachable", new AuthRetryableFetchError("fetch failed", 0)],
    ["the sign-in service errors", new AuthApiError("boom", 500, "unexpected_failure")],
  ])("tells the user when %s", async (_label, error) => {
    authSignOut.mockResolvedValue({ error });
    await expect(signOut()).rejects.toThrow("NEXT_REDIRECT /login?error=signout");
    expect(redirect).toHaveBeenCalledExactlyOnceWith("/login?error=signout");
    expect(console.error).toHaveBeenCalledWith("signOut failed", {
      code: error.code,
      status: error.status,
    });
  });
});
