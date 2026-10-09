import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

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
  it("shows the admin nav around the page for an admin", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "app_has_grant" ? { data: true, error: null } : { data: "a0000000-0000-4000-8000-000000000001", error: null },
    );
    const html = renderToStaticMarkup(await layout());
    expect(html).toContain('<nav aria-label="Admin"');
    expect(html).toContain("<main");
    expect(html).toContain("the page");
  });

  it("doesn't throw when the admin check fails, so the page's throw reaches admin/error.tsx", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST000", message: "down" } });
    const html = renderToStaticMarkup(await layout());
    expect(html).not.toContain('aria-label="Admin"');
    expect(html).toContain("the page");
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
    expect(pages.sort()).toEqual(["costs/page.tsx", "page.tsx", "scoring/page.tsx", "structure/page.tsx", "teams/[id]/page.tsx"]);
  });

  it.each(pages)("%s calls requireAdminPage", (file) => {
    const source = readFileSync(join(new URL(".", import.meta.url).pathname, file), "utf8");
    expect(source).toMatch(/await requireAdminPage\(/);
  });
});
