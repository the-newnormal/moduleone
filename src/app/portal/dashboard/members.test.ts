import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadHeatmapData, loadLedTeams, loadRole, loadScoringConfig, loadTeamWeek } from "@/lib/dashboard/load";
import { createClient } from "@/lib/supabase/server";
import PortalPage from "../page";
import TeamWeekPage from "./[teamId]/[week]/page";
import DashboardPage from "./page";
import TrendPage from "./trend/page";

// Members never see their grade: the heat-map and its drill-in show scores, colours and the
// leaders-only review, so a member is sent to their check-in, and the portal doesn't offer them.

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/dashboard/load", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard/load")>()),
  loadHeatmapData: vi.fn(),
  loadLedTeams: vi.fn(),
  loadRole: vi.fn(),
  loadScoringConfig: vi.fn(),
  loadTeamWeek: vi.fn(),
}));
vi.mock("../actions", () => ({ signOut: vi.fn() }));

const CONFIG = { weights: {}, thresholds: { green: 3, yellow: 2 } } as never;

// app_has_grant('admin') for the signed-in user.
const rpc = vi.fn();

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: false, error: null });
  vi.mocked(createClient).mockResolvedValue({
    auth: { getClaims: async () => ({ data: { claims: { sub: "u1", email: "m@example.com" } } }) },
    rpc,
  } as never);
  vi.mocked(loadHeatmapData).mockResolvedValue({
    teams: [],
    checkins: [],
    config: CONFIG,
    role: "member",
    ledTeams: [],
  } as never);
  vi.mocked(loadLedTeams).mockResolvedValue([]);
  vi.mocked(loadScoringConfig).mockResolvedValue(CONFIG);
  vi.mocked(loadTeamWeek).mockResolvedValue({ checkins: [], teamName: "Team", context: [] } as never);
  vi.mocked(loadRole).mockResolvedValue("member");
});

describe("a member", () => {
  it("is sent from the heat-map to their check-in", async () => {
    await expect(DashboardPage({ searchParams: Promise.resolve({}) } as never)).rejects.toThrow(
      "NEXT_REDIRECT /portal/checkin",
    );
  });

  it("is sent from the trend grid to their check-in", async () => {
    await expect(TrendPage({ searchParams: Promise.resolve({}) } as never)).rejects.toThrow(
      "NEXT_REDIRECT /portal/checkin",
    );
  });

  it("is sent from a team's week to their check-in, before any check-in loads", async () => {
    await expect(
      TeamWeekPage({
        params: Promise.resolve({ teamId: "none", week: "2026-10-05" }),
        searchParams: Promise.resolve({}),
      } as never),
    ).rejects.toThrow("NEXT_REDIRECT /portal/checkin");
    expect(loadTeamWeek).not.toHaveBeenCalled();
  });

  it("isn't offered Team health on the portal", async () => {
    const html = renderToStaticMarkup(await PortalPage());
    expect(html).not.toContain("/portal/dashboard");
    expect(html).toContain("/portal/checkin");
  });
});

describe("leaders and hq", () => {
  it.each(["leader", "hq"] as const)("%s is offered Team health on the portal", async (role) => {
    vi.mocked(loadRole).mockResolvedValue(role);
    expect(renderToStaticMarkup(await PortalPage())).toContain("/portal/dashboard");
  });

  it("the portal still renders, without Team health, if the role can't be read", async () => {
    vi.mocked(loadRole).mockRejectedValue(new Error("Couldn't load your role"));
    const html = renderToStaticMarkup(await PortalPage());
    expect(html).not.toContain("/portal/dashboard");
    expect(html).toContain("Sign out");
  });
});

describe("the Admin card", () => {
  it("is offered to an admin-grant holder, whatever their role", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    const html = renderToStaticMarkup(await PortalPage());
    expect(rpc).toHaveBeenCalledWith("app_has_grant", { requested: "admin" });
    expect(html).toContain('href="/admin"');
    expect(html).not.toContain("/portal/dashboard"); // still a member: no Team health
  });

  it("isn't offered without the grant, or if the grant can't be checked", async () => {
    vi.mocked(loadRole).mockResolvedValue("hq");
    expect(renderToStaticMarkup(await PortalPage())).not.toContain('href="/admin"');

    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "timeout" } });
    const html = renderToStaticMarkup(await PortalPage());
    expect(html).not.toContain('href="/admin"');
    expect(html).toContain("/portal/dashboard");
    log.mockRestore();
  });
});
