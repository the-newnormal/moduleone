import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteExpiredRecordings, processPendingCheckins, removeResetRecordings } from "@/app/portal/checkin/housekeeping";
import { tidyLiveSessions } from "@/lib/checkin/live-sessions";
import { GET } from "./route";

vi.mock("@/app/portal/checkin/housekeeping", () => ({
  processPendingCheckins: vi.fn(),
  deleteExpiredRecordings: vi.fn(),
  removeResetRecordings: vi.fn(),
}));
vi.mock("@/lib/checkin/live-sessions", () => ({ tidyLiveSessions: vi.fn() }));

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
  vi.mocked(removeResetRecordings).mockReset().mockResolvedValue({ removed: 1 });
  vi.mocked(tidyLiveSessions).mockReset().mockResolvedValue({ ended: 2 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/cron/process-checkins", () => {
  it("processes the check-ins that are due, deletes expired recordings and tidies live sessions when Vercel Cron calls with the secret", async () => {
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      due: 2,
      graded: 1,
      deleted: 3,
      resetFilesRemoved: 1,
      liveSessionsEnded: 2,
    });
    expect(processPendingCheckins).toHaveBeenCalledOnce();
    expect(deleteExpiredRecordings).toHaveBeenCalledOnce();
    expect(removeResetRecordings).toHaveBeenCalledOnce();
    expect(tidyLiveSessions).toHaveBeenCalledOnce();
  });

  it("reports a failed retry of a Master Admin's file deletes, and still does the rest", async () => {
    vi.mocked(removeResetRecordings).mockResolvedValue(null);
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, due: 2, graded: 1, deleted: 3, liveSessionsEnded: 2 });
    expect(processPendingCheckins).toHaveBeenCalledOnce();
    expect(deleteExpiredRecordings).toHaveBeenCalledOnce();
    expect(tidyLiveSessions).toHaveBeenCalledOnce();
  });

  it("reports a failed tidy of live sessions, and still does the rest", async () => {
    vi.mocked(tidyLiveSessions).mockResolvedValue(null);
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, due: 2, graded: 1, deleted: 3, resetFilesRemoved: 1 });
    expect(processPendingCheckins).toHaveBeenCalledOnce();
    expect(deleteExpiredRecordings).toHaveBeenCalledOnce();
    expect(removeResetRecordings).toHaveBeenCalledOnce();
  });

  it("reports no live sessions ended as 0", async () => {
    vi.mocked(tidyLiveSessions).mockResolvedValue({ ended: 0 });
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, liveSessionsEnded: 0 });
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
    expect(tidyLiveSessions).not.toHaveBeenCalled();
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
    expect(tidyLiveSessions).toHaveBeenCalledOnce();
  });

  it("reports a failed deletion of expired recordings", async () => {
    vi.mocked(deleteExpiredRecordings).mockResolvedValue(null);
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, due: 2, graded: 1 });
  });
});
