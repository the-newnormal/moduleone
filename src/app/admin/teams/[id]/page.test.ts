import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@/lib/supabase/server";
import { generateMetadata } from "./page";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ID = "c0000000-0000-4000-8000-000000000001";
const getClaims = vi.fn();
const rpc = vi.fn();
const maybeSingle = vi.fn();
const query = { select: vi.fn(() => query), eq: vi.fn(() => query), maybeSingle };
const from = vi.fn(() => query);

function signedIn(admin: boolean) {
  getClaims.mockResolvedValue({ data: { claims: { sub: "b0000000-0000-4000-8000-000000000001" } }, error: null });
  rpc.mockImplementation(async (fn: string) =>
    fn === "app_has_grant" ? { data: admin, error: null } : { data: "a0000000-0000-4000-8000-000000000001", error: null },
  );
}

const titleFor = async (id: string) =>
  (await generateMetadata({ params: Promise.resolve({ id }) } as PageProps<"/admin/teams/[id]">)).title;

beforeEach(() => {
  vi.mocked(createClient).mockResolvedValue({ auth: { getClaims }, rpc, from } as never);
  from.mockClear();
  maybeSingle.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the team page's title", () => {
  it("names the team, so moving between team pages is announced", async () => {
    signedIn(true);
    maybeSingle.mockResolvedValue({ data: { name: "IP Lab 1", kind: "team" }, error: null });
    await expect(titleFor(ID)).resolves.toBe("IP Lab 1 · Admin · Module One");
    expect(query.eq).toHaveBeenCalledWith("id", ID);
  });

  it("names a division's page like any other (people can sit in one since 0005)", async () => {
    signedIn(true);
    maybeSingle.mockResolvedValue({ data: { name: "Gather" }, error: null });
    await expect(titleFor(ID)).resolves.toBe("Gather · Admin · Module One");
  });

  it("says just 'Team' for an unknown id or a failed read", async () => {
    signedIn(true);
    maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(titleFor(ID)).resolves.toBe("Team · Admin · Module One");
    maybeSingle.mockResolvedValue({ data: null, error: { code: "PGRST000", message: "down" } });
    await expect(titleFor(ID)).resolves.toBe("Team · Admin · Module One");
    expect(console.error).toHaveBeenCalledWith("team page title failed", { code: "PGRST000", status: undefined });
  });

  it("reads nothing for a malformed id or anyone who isn't an admin", async () => {
    signedIn(true);
    await expect(titleFor("not-a-uuid")).resolves.toBe("Team · Admin · Module One");
    signedIn(false);
    await expect(titleFor(ID)).resolves.toBe("Team · Admin · Module One");
    expect(from).not.toHaveBeenCalled();
  });
});
