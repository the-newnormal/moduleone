import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { loadRole, type Role } from "@/lib/dashboard/load";
import { loadPortalAccess, portalNav } from "./access";

// The portal decides once, on the server, what the viewer is offered. Team health shows grades,
// so only leaders and hq get it; Admin needs the admin grant, whatever the role. Every check fails
// closed: a check that can't be made hides what it guards and never takes the portal down.

vi.mock("@/lib/dashboard/load", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard/load")>()),
  loadRole: vi.fn(),
}));

// app_has_grant('admin') for the signed-in user.
const rpc = vi.fn();
const supabase = { rpc } as never;

let log: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.mocked(loadRole).mockReset().mockResolvedValue("member");
  rpc.mockReset().mockResolvedValue({ data: false, error: null });
  log = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  log.mockRestore();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("portalNav", () => {
  const navFor = async (role: Role | null, isAdmin: boolean) => {
    vi.mocked(loadRole).mockResolvedValue(role);
    rpc.mockResolvedValue({ data: isAdmin, error: null });
    return portalNav(await loadPortalAccess(supabase)).map((item) => item.id);
  };

  it.each([
    ["a member", "member", false, ["portal", "checkin"]],
    ["a leader", "leader", false, ["portal", "checkin", "team-health"]],
    ["hq", "hq", false, ["portal", "checkin", "team-health"]],
    ["an admin who is a member", "member", true, ["portal", "checkin", "admin"]],
    ["an admin who is hq", "hq", true, ["portal", "checkin", "team-health", "admin"]],
    // A login not linked to anyone yet: the check-in page explains that, so it stays.
    ["someone with no role", null, false, ["portal", "checkin"]],
  ] as const)("offers %s exactly these, in this order", async (_who, role, isAdmin, ids) => {
    expect(await navFor(role, isAdmin)).toEqual(ids);
  });

  it("links each item to its page", () => {
    expect(portalNav({ seesTeamHealth: true, isAdmin: true })).toEqual([
      { id: "portal", href: "/portal", label: "Portal" },
      { id: "checkin", href: "/portal/checkin", label: "Check-in" },
      { id: "team-health", href: "/portal/dashboard", label: "Team health" },
      { id: "admin", href: "/admin", label: "Admin" },
    ]);
  });
});

describe("loadPortalAccess", () => {
  it("starts both checks before either answers", async () => {
    const role = deferred<Role | null>();
    const grant = deferred<{ data: unknown; error: null }>();
    vi.mocked(loadRole).mockReturnValue(role.promise);
    rpc.mockReturnValue(grant.promise);

    const access = loadPortalAccess(supabase);
    // Neither has answered yet, so a check run after the other would not have been asked for.
    expect(loadRole).toHaveBeenCalledWith(supabase);
    expect(rpc).toHaveBeenCalledWith("app_has_grant", { requested: "admin" });

    grant.resolve({ data: true, error: null });
    role.resolve("leader");
    await expect(access).resolves.toEqual({ role: "leader", seesTeamHealth: true, isAdmin: true });
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ["member", false],
    ["leader", true],
    ["hq", true],
    [null, false],
  ] as const)("gives Team health to role %s: %s", async (role, seesTeamHealth) => {
    vi.mocked(loadRole).mockResolvedValue(role);
    expect(await loadPortalAccess(supabase)).toEqual({ role, seesTeamHealth, isAdmin: false });
  });

  describe("when the role can't be read", () => {
    it("treats the viewer as having no role, logs it and still answers", async () => {
      vi.mocked(loadRole).mockRejectedValue(new Error("Couldn't load your role: Ada's row is locked"));
      rpc.mockResolvedValue({ data: true, error: null });

      // The admin check is separate: losing the role doesn't take the Admin item with it.
      expect(await loadPortalAccess(supabase)).toEqual({ role: null, seesTeamHealth: false, isAdmin: true });
      expect(log).toHaveBeenCalledWith("portal role check failed", expect.anything());
      // Only code and status reach the log, never the message.
      expect(JSON.stringify(log.mock.calls)).not.toContain("Ada");
    });
  });

  describe("the admin check", () => {
    it("is true only when app_has_grant answers true", async () => {
      rpc.mockResolvedValue({ data: true, error: null });
      expect((await loadPortalAccess(supabase)).isAdmin).toBe(true);
    });

    it("is false, and logged, when app_has_grant returns an error", async () => {
      rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "canceling statement due to timeout" } });
      vi.mocked(loadRole).mockResolvedValue("hq");

      expect(await loadPortalAccess(supabase)).toEqual({ role: "hq", seesTeamHealth: true, isAdmin: false });
      expect(log).toHaveBeenCalledWith("portal admin check failed", { code: "57014", status: undefined });
    });

    it("is false when an error comes back alongside data true", async () => {
      rpc.mockResolvedValue({ data: true, error: { code: "PGRST000", message: "down" } });
      expect((await loadPortalAccess(supabase)).isAdmin).toBe(false);
      expect(log).toHaveBeenCalledWith("portal admin check failed", { code: "PGRST000", status: undefined });
    });

    it("is false, and logged, when the request itself rejects", async () => {
      rpc.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { status: 503 }));
      vi.mocked(loadRole).mockResolvedValue("leader");

      expect(await loadPortalAccess(supabase)).toEqual({ role: "leader", seesTeamHealth: true, isAdmin: false });
      expect(log).toHaveBeenCalledWith("portal admin check failed", { code: undefined, status: 503 });
    });

    // Anything but the boolean true is a no: a string or a number is not the grant.
    it.each([["true"], [1], [null], [{}]])("is false for data %j", async (data) => {
      rpc.mockResolvedValue({ data, error: null });
      expect((await loadPortalAccess(supabase)).isAdmin).toBe(false);
    });

    // supabase.rpc returns PostgREST's builder, which is a thenable rather than a Promise.
    it("reads PostgREST's builder as well as a Promise", async () => {
      rpc.mockReturnValue({
        then: (resolve: (result: { data: boolean; error: null }) => unknown) => resolve({ data: true, error: null }),
      });
      expect((await loadPortalAccess(supabase)).isAdmin).toBe(true);
    });
  });
});
