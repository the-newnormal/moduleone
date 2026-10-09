import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServiceRoleClient, MISSING_SERVICE_KEY_MESSAGE, MissingServiceKeyError } from "./admin";

vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({ fake: "client" })) }));

beforeEach(() => {
  vi.mocked(createClient).mockClear();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createServiceRoleClient", () => {
  it("makes a client with the service key that keeps no session", () => {
    expect(createServiceRoleClient()).toEqual({ fake: "client" });
    expect(createClient).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:54321", "sb_secret_test", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  it.each(["", undefined])("throws MissingServiceKeyError when the key is %j", (key) => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", key);
    expect(() => createServiceRoleClient()).toThrow(MissingServiceKeyError);
    expect(() => createServiceRoleClient()).toThrow(MISSING_SERVICE_KEY_MESSAGE);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("says what the action should tell the admin", () => {
    expect(new MissingServiceKeyError().message).toBe(
      "Logins can't be given from this server yet (SUPABASE_SERVICE_ROLE_KEY is not set).",
    );
    expect(new MissingServiceKeyError().name).toBe("MissingServiceKeyError");
  });

  it("throws a plain error without the project URL", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    expect(() => createServiceRoleClient()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("reads the environment when called, not when imported", () => {
    // This file imported ./admin before any env was stubbed for a test, and nothing threw.
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_later");
    createServiceRoleClient();
    expect(vi.mocked(createClient).mock.calls[0][1]).toBe("sb_secret_later");
  });

  it("is marked server-only", () => {
    const source = readFileSync(new URL("./admin.ts", import.meta.url), "utf8");
    expect(source.trimStart().startsWith('import "server-only";')).toBe(true);
  });
});
