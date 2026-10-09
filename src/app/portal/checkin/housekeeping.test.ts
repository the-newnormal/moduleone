import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processCheckin } from "@/lib/checkin/process";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import {
  deleteExpiredRecordings,
  needsProcessing,
  orphanedFiles,
  processPendingCheckins,
  tidyMemberAudio,
  type ProcessingState,
} from "./housekeeping";

// Mocked whole, so their `import "server-only"` never runs.
vi.mock("@/lib/supabase/admin", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/lib/checkin/process", () => ({ processCheckin: vi.fn() }));

const NOW = new Date("2026-10-08T04:00:00Z");
const MEMBER = "3e3b0000-0000-4000-8000-000000000003";
const WEEK = "2026-10-05";
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

describe("needsProcessing", () => {
  const base: ProcessingState = {
    submitted_at: minutesAgo(30),
    graded_at: null,
    processing_started_at: null,
    processing_error: null,
    processing_attempts: 0,
  };

  it.each<[string, Partial<ProcessingState>, boolean]>([
    ["submitted and never started", {}, true],
    ["the first attempt failed a minute ago", { processing_started_at: minutesAgo(1), processing_error: "x", processing_attempts: 1 }, true],
    ["the first attempt failed seconds ago", { processing_started_at: minutesAgo(0.5), processing_error: "x", processing_attempts: 1 }, false],
    ["the third attempt failed 3 minutes ago", { processing_started_at: minutesAgo(3), processing_error: "x", processing_attempts: 3 }, false],
    ["the third attempt failed 4 minutes ago", { processing_started_at: minutesAgo(4), processing_error: "x", processing_attempts: 3 }, true],
    ["the fourth attempt failed 7 minutes ago", { processing_started_at: minutesAgo(7), processing_error: "x", processing_attempts: 4 }, false],
    ["the last attempt started over 10 minutes ago", { processing_started_at: minutesAgo(11), processing_attempts: 1 }, true],
    ["an attempt is running", { processing_started_at: minutesAgo(2), processing_attempts: 1 }, false],
    ["already graded", { graded_at: minutesAgo(5), processing_started_at: minutesAgo(6), processing_attempts: 1 }, false],
    ["out of attempts", { processing_started_at: minutesAgo(60), processing_error: "x", processing_attempts: 5 }, false],
    ["made before submitting existed", { submitted_at: null }, false],
  ])("is %s → %s", (_label, overrides, expected) => {
    expect(needsProcessing({ ...base, ...overrides }, NOW)).toBe(expected);
  });
});

describe("orphanedFiles", () => {
  const file = (name: string, minutes: number | null, id: string | null = "f1") => ({
    name,
    id,
    created_at: minutes === null ? null : minutesAgo(minutes),
  });

  it("picks old files that no draft or check-in points at", () => {
    const keep = new Set([`${MEMBER}/${WEEK}-draft.webm`, `${MEMBER}/2026-09-28-checkin.webm`]);
    const files = [
      file(`${WEEK}-draft.webm`, 500), // the current draft
      file("2026-09-28-checkin.webm", 10_000), // a check-in's recording
      file(`${WEEK}-unsaved.webm`, 181), // uploaded, never saved: an orphan
      file(`${WEEK}-recent.webm`, 179), // may still be on its way to being saved
      file("2026-09-28-old.m4a", 20_000), // an orphan
      file(".emptyFolderPlaceholder", 20_000), // not one of ours
      file("subfolder", null, null), // a folder
      file(`${WEEK}-undated.webm`, null), // no date: leave it
    ];
    expect(orphanedFiles(MEMBER, files, keep, NOW)).toEqual([
      `${MEMBER}/${WEEK}-unsaved.webm`,
      `${MEMBER}/2026-09-28-old.m4a`,
    ]);
  });
});

describe("tidyMemberAudio", () => {
  type Call = [string, ...unknown[]];
  let calls: Call[];
  let results: Record<string, { data: unknown; error: unknown }>;
  const list = vi.fn();
  const remove = vi.fn();

  // A stand-in for supabase-js's query builder: records each call, and resolves to the result for
  // "<table>.<first method>" when awaited.
  function from(table: string) {
    let key = "";
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "delete", "eq", "lt", "not"]) {
      builder[method] = (...args: unknown[]) => {
        if (!key) key = `${table}.${method}`;
        calls.push([`${table}.${method}`, ...args]);
        return builder;
      };
    }
    builder.then = (resolve: (r: unknown) => void) => resolve(results[key] ?? { data: [], error: null });
    return builder;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    calls = [];
    results = {
      "checkin_drafts.delete": { data: [{ audio_path: `${MEMBER}/2026-09-28-stale.webm` }], error: null },
      "checkin_drafts.select": { data: [{ audio_path: `${MEMBER}/${WEEK}-draft.webm` }], error: null },
      "checkins.select": { data: [{ audio_path: `${MEMBER}/2026-09-21-checkin.webm` }], error: null },
    };
    list.mockReset().mockResolvedValue({
      data: [
        { name: "2026-09-28-stale.webm", id: "a", created_at: minutesAgo(5000) },
        { name: `${WEEK}-draft.webm`, id: "b", created_at: minutesAgo(400) },
        { name: "2026-09-21-checkin.webm", id: "c", created_at: minutesAgo(20_000) },
        { name: `${WEEK}-orphan.webm`, id: "d", created_at: minutesAgo(200) },
      ],
      error: null,
    });
    remove.mockReset().mockResolvedValue({ data: [], error: null });
    vi.mocked(createServiceRoleClient)
      .mockReset()
      .mockReturnValue({ from, storage: { from: () => ({ list, remove }) } } as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("deletes drafts from earlier weeks and orphaned files, keeping drafts and check-ins", async () => {
    await tidyMemberAudio(MEMBER, WEEK);
    expect(calls.slice(0, 4)).toEqual([
      ["checkin_drafts.delete"],
      ["checkin_drafts.eq", "member_id", MEMBER],
      ["checkin_drafts.lt", "week_start", WEEK],
      ["checkin_drafts.select", "audio_path"],
    ]);
    expect(list).toHaveBeenCalledExactlyOnceWith(MEMBER, { limit: 1000 });
    expect(remove).toHaveBeenCalledExactlyOnceWith([
      `${MEMBER}/2026-09-28-stale.webm`,
      `${MEMBER}/${WEEK}-orphan.webm`,
    ]);
  });

  it("reads the drafts before the check-ins, so a file being submitted is never missed", async () => {
    await tidyMemberAudio(MEMBER, WEEK);
    const order = calls.map(([name]) => name).filter((name) => name.endsWith(".select"));
    expect(order).toEqual(["checkin_drafts.select", "checkin_drafts.select", "checkins.select"]);
  });

  it("deletes no files when it can't see every draft and check-in", async () => {
    results["checkins.select"] = { data: null, error: { code: "57014" } };
    await tidyMemberAudio(MEMBER, WEEK);
    expect(remove).not.toHaveBeenCalled();
  });

  it("deletes no files when it can't list the folder", async () => {
    list.mockResolvedValue({ data: null, error: { name: "StorageUnknownError" } });
    await tidyMemberAudio(MEMBER, WEEK);
    expect(remove).not.toHaveBeenCalled();
  });

  it("never deletes a check-in's recording, even when an old draft pointed at it", async () => {
    // Submitted just before midnight while this ran, or a draft that reused a check-in's file.
    results["checkins.select"] = {
      data: [{ audio_path: `${MEMBER}/2026-09-21-checkin.webm` }, { audio_path: `${MEMBER}/2026-09-28-stale.webm` }],
      error: null,
    };
    await tidyMemberAudio(MEMBER, WEEK);
    expect(remove).toHaveBeenCalledExactlyOnceWith([`${MEMBER}/${WEEK}-orphan.webm`]);
  });

  it("reads the check-ins after deleting the old drafts", async () => {
    await tidyMemberAudio(MEMBER, WEEK);
    const names = calls.map(([name]) => name);
    expect(names.indexOf("checkins.select")).toBeGreaterThan(names.indexOf("checkin_drafts.delete"));
  });

  it("stops if old drafts can't be deleted", async () => {
    results["checkin_drafts.delete"] = { data: null, error: { code: "42501" } };
    await tidyMemberAudio(MEMBER, WEEK);
    expect(list).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("does nothing when nothing needs deleting", async () => {
    results["checkin_drafts.delete"] = { data: [], error: null };
    list.mockResolvedValue({ data: [], error: null });
    await tidyMemberAudio(MEMBER, WEEK);
    expect(remove).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    vi.mocked(createServiceRoleClient).mockImplementation(() => {
      throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
    });
    await expect(tidyMemberAudio(MEMBER, WEEK)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith("tidyMemberAudio failed", { code: "Error" });
  });
});

describe("processPendingCheckins", () => {
  type Call = [string, ...unknown[]];
  let calls: Call[];
  let result: { data: unknown; error: unknown };

  function from(table: string) {
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "not", "is", "lt", "order", "limit"]) {
      builder[method] = (...args: unknown[]) => {
        calls.push([`${table}.${method}`, ...args]);
        return builder;
      };
    }
    builder.then = (resolve: (r: unknown) => void) => resolve(result);
    return builder;
  }

  const row = (id: string, overrides: Partial<ProcessingState> = {}) => ({
    id,
    submitted_at: minutesAgo(3000),
    graded_at: null,
    processing_started_at: minutesAgo(2990),
    processing_error: "transcription_failed: 503",
    processing_attempts: 1,
    ...overrides,
  });

  beforeEach(() => {
    calls = [];
    result = { data: [], error: null };
    vi.mocked(createServiceRoleClient).mockReset().mockReturnValue({ from } as never);
    vi.mocked(processCheckin).mockReset().mockResolvedValue("graded");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks for submitted, ungraded check-ins that still have a recording and attempts left, least recently tried first", async () => {
    await processPendingCheckins(NOW);
    expect(calls).toEqual([
      ["checkins.select", "id, submitted_at, graded_at, processing_started_at, processing_error, processing_attempts"],
      ["checkins.not", "submitted_at", "is", null],
      ["checkins.is", "graded_at", null],
      // Without a recording (deleted after 90 days) the claim skips a row forever.
      ["checkins.not", "audio_path", "is", null],
      ["checkins.lt", "processing_attempts", 5],
      ["checkins.order", "processing_started_at", { ascending: true, nullsFirst: true }],
      ["checkins.limit", 100],
    ]);
  });

  it("processes the ones due an attempt, for any member, whenever the sweep runs", async () => {
    result = {
      data: [
        row("failed-last-week"),
        row("never-started", { processing_started_at: null, processing_error: null, processing_attempts: 0 }),
        row("running", { processing_started_at: minutesAgo(2), processing_error: null }),
        row("in-its-pause", { processing_started_at: minutesAgo(1), processing_attempts: 3 }),
        row("stalled", { processing_started_at: minutesAgo(30), processing_error: null }),
      ],
      error: null,
    };
    vi.mocked(processCheckin).mockImplementation(async (id) => (id === "stalled" ? "failed" : "graded"));
    expect(await processPendingCheckins(NOW)).toEqual({ due: 3, graded: 2 });
    expect(vi.mocked(processCheckin).mock.calls.map(([id]) => id)).toEqual(["failed-last-week", "never-started", "stalled"]);
  });

  it("takes at most 20 in one run", async () => {
    result = { data: Array.from({ length: 30 }, (_, i) => row(`c${i}`)), error: null };
    expect(await processPendingCheckins(NOW)).toEqual({ due: 20, graded: 20 });
  });

  it("reports a failed read and processes nothing", async () => {
    result = { data: null, error: { code: "PGRST000" } };
    expect(await processPendingCheckins(NOW)).toBeNull();
    expect(processCheckin).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("processPendingCheckins: reading check-ins failed", { code: "PGRST000" });
  });

  it("never throws", async () => {
    vi.mocked(createServiceRoleClient).mockImplementation(() => {
      throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
    });
    await expect(processPendingCheckins(NOW)).resolves.toBeNull();
  });
});

describe("deleteExpiredRecordings", () => {
  const rpc = vi.fn();
  const remove = vi.fn();
  const storageFrom = vi.fn(() => ({ remove }));
  const files = (n: number) => Array.from({ length: n }, (_, i) => `${MEMBER}/2026-07-0${i % 7}-take-${i}.webm`);

  beforeEach(() => {
    vi.mocked(createServiceRoleClient).mockReset().mockReturnValue({ rpc, storage: { from: storageFrom } } as never);
    rpc.mockReset().mockResolvedValue({ data: files(3), error: null });
    remove.mockReset().mockResolvedValue({ data: [], error: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes the recordings the database has taken off their check-ins and drafts", async () => {
    expect(await deleteExpiredRecordings()).toEqual({ deleted: 3 });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("forget_expired_checkin_audio");
    expect(storageFrom).toHaveBeenCalledWith("checkin-audio");
    expect(remove).toHaveBeenCalledExactlyOnceWith(files(3));
  });

  it("deletes in batches of 100", async () => {
    rpc.mockResolvedValue({ data: files(250), error: null });
    expect(await deleteExpiredRecordings()).toEqual({ deleted: 250 });
    expect(remove.mock.calls.map(([batch]) => batch.length)).toEqual([100, 100, 50]);
  });

  it("does nothing when nothing has expired", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    expect(await deleteExpiredRecordings()).toEqual({ deleted: 0 });
    expect(remove).not.toHaveBeenCalled();
  });

  it("reports a failure without throwing, so the next run tries again", async () => {
    remove.mockResolvedValue({ data: null, error: { name: "StorageApiError", message: "boom" } });
    expect(await deleteExpiredRecordings()).toBeNull();
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "denied" } });
    expect(await deleteExpiredRecordings()).toBeNull();
    vi.mocked(createServiceRoleClient).mockImplementation(() => {
      throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
    });
    expect(await deleteExpiredRecordings()).toBeNull();
  });
});
