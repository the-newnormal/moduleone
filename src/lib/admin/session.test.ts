import { notFound, redirect } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@/lib/supabase/server";
import { GENERIC_ERROR, NO_PERMISSION } from "./errors";
import { adminForMetadata, requireAdmin, requireAdminLayout, requireAdminPage } from "./session";

// Like the real ones, stop at the first call.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ADMIN_AUTH = "b0000000-0000-4000-8000-000000000001";
const ADMIN_MEMBER = "a0000000-0000-4000-8000-000000000001";

const getClaims = vi.fn();
const rpc = vi.fn();
const client = { auth: { getClaims }, rpc };

function signedInAs(sub: string | null, { admin = false, member = ADMIN_MEMBER as string | null } = {}) {
  getClaims.mockResolvedValue({ data: sub ? { claims: { sub } } : null, error: null });
  rpc.mockImplementation(async (fn: string) => {
    if (fn === "app_has_grant") return { data: admin, error: null };
    if (fn === "app_current_member_id") return { data: member, error: null };
    throw new Error(`unexpected rpc ${fn}`);
  });
}

beforeEach(() => {
  vi.mocked(createClient).mockResolvedValue(client as never);
  getClaims.mockReset();
  rpc.mockReset();
  vi.mocked(redirect).mockClear();
  vi.mocked(notFound).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an admin", () => {
  beforeEach(() => signedInAs(ADMIN_AUTH, { admin: true }));

  it("gets their own client, member id and auth user id", async () => {
    const expected = { supabase: client, memberId: ADMIN_MEMBER, authUserId: ADMIN_AUTH };
    await expect(requireAdminPage("/admin/scoring")).resolves.toEqual(expected);
    await expect(requireAdminLayout("/admin")).resolves.toEqual(expected);
    await expect(adminForMetadata()).resolves.toEqual(expected);
    await expect(requireAdmin()).resolves.toEqual({ ok: true, value: expected });
    expect(rpc).toHaveBeenCalledWith("app_has_grant", { requested: "admin" });
    expect(redirect).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
  });
});

describe("a signed-in member without the admin grant", () => {
  beforeEach(() => signedInAs(ADMIN_AUTH, { admin: false }));

  it("is refused everywhere: a 404 and no permission", async () => {
    await expect(requireAdminPage("/admin")).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    await expect(requireAdminLayout("/admin")).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    await expect(adminForMetadata()).resolves.toBeNull();
    await expect(requireAdmin()).resolves.toEqual({ ok: false, error: NO_PERMISSION });
    expect(redirect).not.toHaveBeenCalled();
  });

  it.each([
    ["the grant check answers something other than true", { admin: "true" as unknown as boolean }],
    ["there's no member row", { admin: true, member: null }],
  ])("is refused when %s", async (_label, options) => {
    signedInAs(ADMIN_AUTH, options);
    await expect(requireAdminPage("/admin")).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    await expect(requireAdmin()).resolves.toEqual({ ok: false, error: NO_PERMISSION });
  });
});

describe("a signed-out visitor", () => {
  beforeEach(() => signedInAs(null));

  it("is sent to sign in from pages, refused by actions, and never reaches the grant check", async () => {
    await expect(requireAdminPage("/admin/teams/x?y=1")).rejects.toThrow(
      "NEXT_REDIRECT /login?next=%2Fadmin%2Fteams%2Fx%3Fy%3D1",
    );
    await expect(requireAdminLayout("/admin")).rejects.toThrow("NEXT_REDIRECT /login?next=%2Fadmin");
    await expect(adminForMetadata()).resolves.toBeNull();
    await expect(requireAdmin()).resolves.toEqual({ ok: false, error: NO_PERMISSION });
    expect(rpc).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
  });

  it("is treated as signed out when the claims have no subject", async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "" } }, error: null });
    await expect(requireAdmin()).resolves.toEqual({ ok: false, error: NO_PERMISSION });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("when the check itself fails", () => {
  beforeEach(() => {
    signedInAs(ADMIN_AUTH, { admin: true });
    rpc.mockImplementation(async (fn: string) =>
      fn === "app_has_grant"
        ? { data: null, error: { code: "PGRST000", message: "Could not connect: hq@example.com", details: "x" } }
        : { data: ADMIN_MEMBER, error: null },
    );
  });

  it("throws on pages (the error page, not a misleading 404) and refuses actions generically", async () => {
    await expect(requireAdminPage("/admin")).rejects.toThrow("Couldn't check admin access.");
    // The layout doesn't throw (admin/error.tsx can't cover it); the page throws inside it.
    await expect(requireAdminLayout("/admin")).resolves.toBeNull();
    await expect(adminForMetadata()).resolves.toBeNull();
    await expect(requireAdmin()).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(notFound).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("checkAdmin failed", { code: "PGRST000", status: undefined });
  });

  it("does the same when only the member lookup fails", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "app_has_grant"
        ? { data: true, error: null }
        : { data: null, error: { code: "PGRST000", message: "Could not connect", status: 503 } },
    );
    await expect(requireAdminPage("/admin")).rejects.toThrow("Couldn't check admin access.");
    await expect(requireAdmin()).resolves.toEqual({ ok: false, error: GENERIC_ERROR });
    expect(notFound).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("checkAdmin failed", { code: "PGRST000", status: 503 });
  });
});
