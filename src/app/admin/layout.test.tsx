import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { viewerAccess } from "@/lib/portal/access";
import { createClient } from "@/lib/supabase/server";
import AdminLayout from "./layout";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  }),
  usePathname: () => "/admin/structure",
  // The app bar's Sign out holds a router; rendering it needs only the hook.
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/app/portal/actions", () => ({ signOut: vi.fn() }));
vi.mock("@/lib/portal/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal/access")>();
  return { ...actual, viewerAccess: vi.fn(actual.viewerAccess) };
});

const rpc = vi.fn();
const getClaims = vi.fn();

beforeEach(() => {
  vi.mocked(createClient).mockResolvedValue({ auth: { getClaims }, rpc } as never);
  getClaims.mockResolvedValue({ data: { claims: { sub: "b0000000-0000-4000-8000-000000000001" } }, error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const layout = () =>
  AdminLayout({ children: <p>the page</p>, params: Promise.resolve({}) } as unknown as LayoutProps<"/admin">);

describe("AdminLayout", () => {
  it("shows the app bar, with Admin current, and the admin nav around the page for an admin", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "app_has_grant"
        ? { data: true, error: null }
        : fn === "app_current_role"
          ? { data: "hq", error: null }
          : { data: "a0000000-0000-4000-8000-000000000001", error: null },
    );
    const html = renderToStaticMarkup(await layout());
    expect(html).toMatch(/<header class="fixed inset-x-0 top-0[^"]*">[\s\S]*<\/header><div aria-hidden="true" class="h-\(--app-bar-h\)/);
    expect(html).toContain('<nav aria-label="Main"');
    // Admin's own page redirects to Structure, so Admin is marked as the section, not the page.
    expect(html).toMatch(/<a aria-current="true"[^>]*href="\/admin"[^>]*>Admin<\/a>/);
    expect(html).toContain('href="/portal/dashboard"'); // hq: Team health too
    expect(html.split(">Sign out<")).toHaveLength(2);
    expect(html).toContain('<nav aria-label="Admin"');
    expect(html).not.toContain("Back to portal"); // the app bar leads there
    expect(html.match(/<header/g)).toHaveLength(1); // the app bar is the one banner
    expect(html).toContain("<main");
    expect(html).toContain("the page");
  });

  it("doesn't throw when the admin check fails, so the page's throw reaches admin/error.tsx", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST000", message: "down" } });
    const html = renderToStaticMarkup(await layout());
    expect(html).not.toContain('aria-label="Admin"');
    // The app bar still leads back to the portal; its nav offers only what didn't need the checks.
    expect(html).toContain('<nav aria-label="Main"');
    expect(html).not.toContain('href="/admin"');
    expect(html).toContain("the page");
  });

  it("leaves Admin out of the app bar when its own check fails, though the grant check alone passed", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "app_has_grant"
        ? { data: true, error: null }
        : { data: null, error: { code: "PGRST000", message: "member lookup down" } },
    );
    const html = renderToStaticMarkup(await layout());
    expect(html).toContain('<nav aria-label="Main"');
    expect(html).not.toContain('href="/admin"');
    expect(html).not.toContain('aria-label="Admin"');
  });

  it("keeps Admin in the app bar when its own check passed, though the bar's grant check failed", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "app_has_grant" ? { data: true, error: null } : { data: "a0000000-0000-4000-8000-000000000001", error: null },
    );
    // The bar's own check failed closed (portal access fails closed on any error).
    vi.mocked(viewerAccess).mockResolvedValueOnce({ role: null, seesTeamHealth: false, isAdmin: false });
    const html = renderToStaticMarkup(await layout());
    expect(html).toMatch(/<a aria-current="true"[^>]*href="\/admin"[^>]*>Admin<\/a>/);
  });

  it("still sends everyone else away", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "app_has_grant" ? { data: false, error: null } : { data: "a0000000-0000-4000-8000-000000000002", error: null },
    );
    await expect(layout()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});

// The layout lets a page render when the admin check failed, trusting the page to throw: so every
// page under /admin must call requireAdminPage.
describe("every admin page", () => {
  const pages = (readdirSync(new URL(".", import.meta.url), { recursive: true }) as string[]).filter((file) =>
    /(^|\/)page\.tsx$/.test(file),
  );

  it("is found", () => {
    expect(pages.sort()).toEqual(["page.tsx", "scoring/page.tsx", "structure/page.tsx", "teams/[id]/page.tsx"]);
  });

  it.each(pages)("%s calls requireAdminPage", (file) => {
    const source = readFileSync(join(new URL(".", import.meta.url).pathname, file), "utf8");
    expect(source).toMatch(/await requireAdminPage\(/);
  });
});
