import { describe, expect, it } from "vitest";
import { AUTO_RELOAD_GAP_MS, mayAutoReload, reloadAddress } from "./playback";

describe("mayAutoReload", () => {
  it("lets the first error fetch a fresh link", () => {
    expect(mayAutoReload(5_000, null)).toBe(true);
  });

  it("treats another error within a minute as a real failure, so reloads can't loop", () => {
    expect(mayAutoReload(10_000 + AUTO_RELOAD_GAP_MS - 1, 10_000)).toBe(false);
  });

  it("recovers again once a link could have run out since the last reload", () => {
    expect(mayAutoReload(10_000 + AUTO_RELOAD_GAP_MS, 10_000)).toBe(true);
    expect(mayAutoReload(10_000 + 11 * 60_000, 10_000)).toBe(true);
  });
});

describe("reloadAddress", () => {
  it("asks for the stable address again under a new query, keeping its extension last in the path", () => {
    const src = "/portal/dashboard/recording/0a2a0934-0640-4c5f-87b9-4d50688ef9c6.webm";
    expect(reloadAddress(src, 1)).toBe(`${src}?reload=1`);
    expect(reloadAddress(src, 2)).not.toBe(reloadAddress(src, 1));
  });
});
