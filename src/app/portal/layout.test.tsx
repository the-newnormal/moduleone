import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadRole } from "@/lib/dashboard/load";
import { createClient } from "@/lib/supabase/server";
import PortalLayout from "./layout";

// Every portal page sits under the app bar: the logomark, the nav (only what the viewer may open,
// the page they're on marked) and Sign out. It stays at the top as the page scrolls.

let pathname = "/portal";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/dashboard/load", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard/load")>()),
  loadRole: vi.fn(),
}));
vi.mock("./actions", () => ({ signOut: vi.fn() }));

const getClaims = vi.fn();
const rpc = vi.fn(); // app_has_grant('admin')

beforeEach(() => {
  pathname = "/portal";
  vi.mocked(createClient).mockResolvedValue({ auth: { getClaims }, rpc } as never);
  getClaims.mockResolvedValue({ data: { claims: { sub: "u1" } }, error: null });
  vi.mocked(loadRole).mockResolvedValue("leader");
  rpc.mockResolvedValue({ data: true, error: null });
});

const layout = async () =>
  renderToStaticMarkup(
    await PortalLayout({ children: <main>the page</main>, params: Promise.resolve({}) } as unknown as LayoutProps<"/portal">),
  );
// The nav's tabs in order: [the page you're on], (the section a page under it belongs to).
const nav = (html: string) =>
  [...(/<nav aria-label="Main"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "").matchAll(/<a ([^>]*)>([^<]*)<\/a>/g)].map(
    ([, attrs, label]) =>
      attrs.includes('aria-current="page"') ? `[${label}]` : attrs.includes('aria-current="true"') ? `(${label})` : label,
  );

describe("PortalLayout", () => {
  it("puts the app bar, fixed to the top with a spacer in its place, above the page, with one Sign out", async () => {
    const html = await layout();
    expect(html).toMatch(/^<header class="fixed inset-x-0 top-0[^"]*">[\s\S]*<\/header><div aria-hidden="true" class="h-\(--app-bar-h\)[^"]*"><\/div><main>/);
    expect(html.indexOf("<header")).toBeLessThan(html.indexOf("the page"));
    expect(html.split(">Sign out<")).toHaveLength(2);
    expect(html).toContain('href="/portal"');
  });

  it.each([
    ["/portal", ["[Portal]", "Check-in", "Team health", "Admin"]],
    ["/portal/checkin", ["Portal", "[Check-in]", "Team health", "Admin"]],
    ["/portal/dashboard", ["Portal", "Check-in", "[Team health]", "Admin"]],
    ["/portal/dashboard/trend", ["Portal", "Check-in", "(Team health)", "Admin"]],
  ])("marks the page it's on: %s", async (path, items) => {
    pathname = path;
    expect(nav(await layout())).toEqual(items);
  });

  it("offers a member only the portal and their check-in", async () => {
    vi.mocked(loadRole).mockResolvedValue("member");
    rpc.mockResolvedValue({ data: false, error: null });
    expect(nav(await layout())).toEqual(["[Portal]", "Check-in"]);
  });

  it("leaves the bar out for a signed-out visitor; the page sends them to sign in", async () => {
    getClaims.mockResolvedValue({ data: null, error: null });
    const html = await layout();
    expect(html).not.toContain("<header");
    expect(html).toBe("<main>the page</main>");
    expect(loadRole).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});
