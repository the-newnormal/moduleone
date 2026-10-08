import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import LoginPage from "./page";

// The form's server action isn't called while rendering; keep its imports inert.
vi.mock("./actions", () => ({ sendMagicLink: vi.fn() }));

async function render(searchParams: Record<string, string | string[]>) {
  const page = await LoginPage({
    params: Promise.resolve({}),
    searchParams: Promise.resolve(searchParams),
  });
  return renderToStaticMarkup(page);
}

describe("/login notices", () => {
  it.each([
    ["link", "That sign-in link has expired"],
    ["signout", "You&#x27;re signed out on this device"],
  ])("shows the notice for ?error=%s", async (error, text) => {
    const html = await render({ error });
    expect(html).toContain('role="alert"');
    expect(html).toContain(text);
  });

  it.each(["", "nope", "constructor", "__proto__", "toString"])(
    "shows no notice for ?error=%s",
    async (error) => {
      expect(await render({ error })).not.toContain('role="alert"');
    },
  );
});
