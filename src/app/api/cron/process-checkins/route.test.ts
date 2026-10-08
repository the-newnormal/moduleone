import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteExpiredRecordings, processPendingCheckins } from "@/app/portal/checkin/housekeeping";
import { GET } from "./route";

vi.mock("@/app/portal/checkin/housekeeping", () => ({ processPendingCheckins: vi.fn(), deleteExpiredRecordings: vi.fn() }));

const SECRET = "cron-secret-for-tests";
const call = (authorization?: string) =>
  GET(
    new NextRequest("http://localhost/api/cron/process-checkins", {
      headers: authorization === undefined ? {} : { authorization },
    }),
  );

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.mocked(processPendingCheckins).mockReset().mockResolvedValue({ due: 2, graded: 1 });
  vi.mocked(deleteExpiredRecordings).mockReset().mockResolvedValue({ deleted: 3 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/cron/process-checkins", () => {
  it("processes the check-ins that are due and deletes expired recordings when Vercel Cron calls with the secret", async () => {
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, due: 2, graded: 1, deleted: 3 });
    expect(processPendingCheckins).toHaveBeenCalledOnce();
    expect(deleteExpiredRecordings).toHaveBeenCalledOnce();
  });

  it.each([
    ["no Authorization header", undefined],
    ["a wrong secret", "Bearer not-the-secret"],
    ["the secret without Bearer", SECRET],
    ["an empty bearer", "Bearer "],
  ])("refuses a call with %s", async (_label, authorization) => {
    const response = await call(authorization);
    expect(response.status).toBe(401);
    expect(processPendingCheckins).not.toHaveBeenCalled();
    expect(deleteExpiredRecordings).not.toHaveBeenCalled();
  });

  it("refuses every call when CRON_SECRET isn't set", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call("Bearer ")).status).toBe(401);
    expect((await call("Bearer undefined")).status).toBe(401);
    expect(processPendingCheckins).not.toHaveBeenCalled();
  });

  it("reports a sweep that couldn't read the check-ins, and still deletes expired recordings", async () => {
    vi.mocked(processPendingCheckins).mockResolvedValue(null);
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(500);
    expect(deleteExpiredRecordings).toHaveBeenCalledOnce();
  });

  it("reports a failed deletion of expired recordings", async () => {
    vi.mocked(deleteExpiredRecordings).mockResolvedValue(null);
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, due: 2, graded: 1 });
  });
});
