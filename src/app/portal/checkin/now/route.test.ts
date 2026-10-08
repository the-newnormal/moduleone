import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const NOW = new Date("2026-10-08T04:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("GET /portal/checkin/now", () => {
  it("answers with this server's clock, never cached", async () => {
    const response = GET();
    expect(await response.json()).toEqual({ now: NOW.getTime() });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
