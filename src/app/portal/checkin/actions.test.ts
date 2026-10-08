import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_AUDIO_BYTES } from "@/lib/checkin/audio";
import { noticeVersion } from "@/lib/checkin/notice";
import { processCheckin } from "@/lib/checkin/process";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { acceptNotice, deleteDraft, prepareRecording, saveDraft, submitCheckin } from "./actions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
// Mocked whole, so their `import "server-only"` never runs.
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/checkin/process", () => ({ processCheckin: vi.fn() }));

// Thursday 8 October 2026, noon in Singapore: the week of Monday 5 October.
const NOW = new Date("2026-10-08T04:00:00Z");
const WEEK = "2026-10-05";
const USER = "5eed0000-0000-4000-8000-000000000003";
const MEMBER = "3e3b0000-0000-4000-8000-000000000003";
const OTHER = "3e3b0000-0000-4000-8000-000000000002";
const PATH = `${MEMBER}/${WEEK}-0c6f2a8e-5b1d-4c43-9a51-2f3c1d9e8b7a.webm`;
const OLD_PATH = `${MEMBER}/${WEEK}-11111111-2222-4333-8444-555555555555.webm`;
const PAGE = "/portal/checkin";

type Result = { data: unknown; error: unknown };
type Query = { table: string; columns: string; filters: [string, unknown][] };

// The user's (RLS) client: auth plus one maybeSingle() read per table.
let reads: Record<string, Result>;
let queries: Query[];
const getClaims = vi.fn();
function rlsFrom(table: string) {
  const query: Query = { table, columns: "", filters: [] };
  queries.push(query);
  const builder = {
    select(columns: string) {
      query.columns = columns;
      return builder;
    },
    eq(column: string, value: unknown) {
      query.filters.push([column, value]);
      return builder;
    },
    maybeSingle: async () => reads[table] ?? { data: null, error: null },
  };
  return builder;
}

// The service-role client: rpc, an upsert, the check-ins lookup before a delete, and Storage.
// The lookup only finds checkinsUsingPath when it filters on this member and this path.
let checkinsUsingPath: { id: string; member_id: string; audio_path: string }[];
let adminQueries: Query[];
const rpc = vi.fn();
const upsert = vi.fn();
const createSignedUploadUrl = vi.fn();
const info = vi.fn();
const remove = vi.fn();
const storageFrom = vi.fn(() => ({ createSignedUploadUrl, info, remove }));
function adminFrom(table: string) {
  const query: Query = { table, columns: "", filters: [] };
  adminQueries.push(query);
  const builder = {
    upsert,
    select(columns: string) {
      query.columns = columns;
      return builder;
    },
    eq(column: string, value: unknown) {
      query.filters.push([column, value]);
      return builder;
    },
    limit: async () => {
      if (table !== "checkins") return { data: [], error: null };
      const rows = checkinsUsingPath.filter((row) =>
        query.filters.every(([column, value]) => row[column as keyof typeof row] === value),
      );
      return { data: rows.map(({ id }) => ({ id })), error: null };
    },
  };
  return builder;
}

const uploaded = (overrides: Record<string, unknown> = {}) => ({
  data: { size: 120_000, contentType: "audio/webm", createdAt: "2026-10-08T03:55:00Z", metadata: {}, ...overrides },
  error: null,
});
const raised = (message: string) => ({ data: null, error: { code: "P0001", message, details: null, hint: null } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  reads = {
    members: { data: { id: MEMBER, team_id: "7ea30000-0000-4000-8000-000000000001" }, error: null },
    recording_notices: { data: { member_id: MEMBER }, error: null },
    checkins: { data: null, error: null },
  };
  queries = [];
  adminQueries = [];
  checkinsUsingPath = [];
  vi.mocked(createClient).mockResolvedValue({ auth: { getClaims }, from: rlsFrom } as never);
  vi.mocked(createAdminClient).mockReset().mockReturnValue({ rpc, from: adminFrom, storage: { from: storageFrom } } as never);
  getClaims.mockReset().mockResolvedValue({ data: { claims: { sub: USER } }, error: null });
  rpc.mockReset().mockResolvedValue({ data: null, error: null });
  upsert.mockReset().mockResolvedValue({ data: null, error: null });
  createSignedUploadUrl.mockReset().mockImplementation(async (path: string) => ({
    data: { path, token: "tok", signedUrl: `http://127.0.0.1:54321/storage/v1/object/upload/sign/checkin-audio/${path}?token=tok` },
    error: null,
  }));
  info.mockReset().mockResolvedValue(uploaded());
  remove.mockReset().mockResolvedValue({ data: [], error: null });
  storageFrom.mockClear();
  vi.mocked(revalidatePath).mockClear();
  vi.mocked(after).mockReset();
  vi.mocked(processCheckin).mockReset().mockResolvedValue("graded");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ACTIONS = [
  ["acceptNotice", () => acceptNotice(noticeVersion())],
  ["prepareRecording", () => prepareRecording("audio/webm")],
  ["saveDraft", () => saveDraft({ path: PATH, durationMs: 1000 })],
  ["deleteDraft", () => deleteDraft()],
  ["submitCheckin", () => submitCheckin()],
] as const;

describe("every check-in action", () => {
  it.each(ACTIONS)("%s refuses a signed-out caller", async (_name, action) => {
    getClaims.mockResolvedValue({ data: null, error: null });
    expect(await action()).toEqual({
      status: "error",
      code: "signed_out",
      message: "Your session has ended. Sign in again.",
    });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it.each(ACTIONS)("%s refuses a signed-in user with no members row", async (_name, action) => {
    reads.members = { data: null, error: null };
    expect(await action()).toMatchObject({ status: "error", code: "no_member" });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it.each(ACTIONS)("%s takes the member from the session's user id", async (_name, action) => {
    await action();
    expect(queries[0]).toEqual({ table: "members", columns: "id, team_id", filters: [["auth_user_id", USER]] });
  });

  it.each(ACTIONS)("%s says so, without details, when the member can't be read", async (_name, action) => {
    reads.members = { data: null, error: { code: "PGRST000", message: "connection refused" } };
    expect(await action()).toMatchObject({ status: "error", code: "failed" });
    expect(console.error).toHaveBeenCalledWith("checkin: reading the member failed", { code: "PGRST000" });
  });
});

describe("acceptNotice", () => {
  it("records the current notice version for the session's member, once", async () => {
    expect(await acceptNotice(noticeVersion())).toEqual({ status: "accepted" });
    expect(upsert).toHaveBeenCalledExactlyOnceWith(
      { member_id: MEMBER, notice_version: noticeVersion() },
      { onConflict: "member_id,notice_version", ignoreDuplicates: true },
    );
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith(PAGE);
  });

  it("reports a failed write", async () => {
    upsert.mockResolvedValue({ data: null, error: { code: "42501", message: "denied" } });
    expect(await acceptNotice(noticeVersion())).toMatchObject({ status: "error", code: "failed" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("records nothing for a notice that has changed since the member read it, and shows the new one", async () => {
    expect(await acceptNotice("2026-10-01.local")).toMatchObject({ status: "error", code: "notice_required" });
    expect(upsert).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith(PAGE);
  });
});

describe("prepareRecording", () => {
  it("signs an upload, upsert off, for a new take in the member's folder for this week", async () => {
    const result = await prepareRecording("audio/webm;codecs=opus");
    expect(storageFrom).toHaveBeenCalledWith("checkin-audio");
    expect(createSignedUploadUrl).toHaveBeenCalledOnce();
    const [path, options] = createSignedUploadUrl.mock.calls[0];
    expect(path).toMatch(new RegExp(`^${MEMBER}/${WEEK}-[0-9a-f-]{36}\\.webm$`));
    expect(options).toEqual({ upsert: false });
    expect(result).toEqual({ status: "ready", path, token: "tok", contentType: "audio/webm" });
  });

  it("names Safari's MP4 audio .m4a", async () => {
    const result = await prepareRecording("audio/mp4");
    expect(result).toMatchObject({ status: "ready", contentType: "audio/mp4", path: expect.stringMatching(/\.m4a$/) });
  });

  it("checks the current notice version", async () => {
    await prepareRecording("audio/webm");
    expect(queries.find((q) => q.table === "recording_notices")?.filters).toEqual([
      ["member_id", MEMBER],
      ["notice_version", noticeVersion()],
    ]);
  });

  it("asks for the privacy notice first", async () => {
    reads.recording_notices = { data: null, error: null };
    expect(await prepareRecording("audio/webm")).toEqual({
      status: "error",
      code: "notice_required",
      message: "Read the privacy notice first.",
    });
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith(PAGE); // so the page shows the notice
  });

  it("refuses once this week's check-in is in", async () => {
    reads.checkins = { data: { id: "d1000000-0000-4000-8000-000000000001" }, error: null };
    expect(await prepareRecording("audio/webm")).toEqual({ status: "submitted" });
    expect(queries.find((q) => q.table === "checkins")?.filters).toEqual([
      ["member_id", MEMBER],
      ["week_start", WEEK],
    ]);
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith(PAGE);
  });

  it.each(["video/webm", "audio/wav", "text/plain", "", "audio/webm/../../x", "a".repeat(200), 42])(
    "refuses the recording type %s",
    async (mimeType) => {
      expect(await prepareRecording(mimeType as string)).toMatchObject({ status: "error", code: "unsupported_audio" });
      expect(createSignedUploadUrl).not.toHaveBeenCalled();
    },
  );

  it("reports a signing failure", async () => {
    createSignedUploadUrl.mockResolvedValue({ data: null, error: { name: "StorageApiError", message: "boom" } });
    expect(await prepareRecording("audio/webm")).toMatchObject({ status: "error", code: "failed" });
    expect(console.error).toHaveBeenCalledWith("prepareRecording: signing the upload failed", { code: "StorageApiError" });
  });
});

describe("saveDraft", () => {
  it("checks the upload, then saves it as this week's draft", async () => {
    expect(await saveDraft({ path: PATH, durationMs: 95_000 })).toEqual({ status: "saved" });
    expect(info).toHaveBeenCalledExactlyOnceWith(PATH);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("save_checkin_draft", {
      p_member_id: MEMBER,
      p_audio_path: PATH,
      p_mime_type: "audio/webm",
      p_duration_ms: 95_000,
    });
    expect(remove).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith(PAGE);
  });

  it.each([
    ["another member's folder", `${OTHER}/${WEEK}-0c6f2a8e-5b1d-4c43-9a51-2f3c1d9e8b7a.webm`],
    ["another week", `${MEMBER}/2026-09-28-0c6f2a8e-5b1d-4c43-9a51-2f3c1d9e8b7a.webm`],
    ["a '..' traversal", `${MEMBER}/../${OTHER}/${WEEK}-x.webm`],
    ["a '..' in the name", `${MEMBER}/${WEEK}-..webm`],
    ["an encoded '%2e%2e'", `${MEMBER}/%2e%2e/${OTHER}/${WEEK}-x.webm`],
    ["an encoded name", `${MEMBER}/${WEEK}-%2e%2e.webm`],
    ["a nested folder", `${MEMBER}/${WEEK}-x/y.webm`],
    ["a leading slash", `/${MEMBER}/${WEEK}-x.webm`],
    ["an empty path", ""],
    ["a path that isn't a string", 42],
  ])("refuses %s", async (_label, path) => {
    expect(await saveDraft({ path: path as string, durationMs: 1000 })).toEqual({
      status: "error",
      code: "bad_path",
      message: "That recording can't be saved. Record it again.",
    });
    expect(info).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("refuses a missing input", async () => {
    expect(await saveDraft(null as never)).toMatchObject({ code: "bad_path" });
  });

  it("refuses a take that never arrived", async () => {
    info.mockResolvedValue({
      data: null,
      error: { name: "StorageApiError", message: "Object not found", status: 400, statusCode: "404" },
    });
    expect(await saveDraft({ path: PATH })).toMatchObject({ status: "error", code: "upload_missing" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses an empty file", async () => {
    info.mockResolvedValue(uploaded({ size: 0 }));
    expect(await saveDraft({ path: PATH })).toMatchObject({ code: "upload_missing" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("deletes and refuses a file over the size limit", async () => {
    info.mockResolvedValue(uploaded({ size: MAX_AUDIO_BYTES + 1 }));
    expect(await saveDraft({ path: PATH })).toMatchObject({ status: "error", code: "upload_too_big" });
    expect(remove).toHaveBeenCalledExactlyOnceWith([PATH]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["isn't audio", "text/plain"],
    ["is audio of a type the recorder never makes", "audio/wav"],
    ["is another allowed type than its name says (.webm, mp4 inside)", "audio/mp4"],
  ])("deletes and refuses a file that %s", async (_label, contentType) => {
    info.mockResolvedValue(uploaded({ contentType }));
    expect(await saveDraft({ path: PATH })).toMatchObject({ status: "error", code: "upload_not_audio" });
    expect(remove).toHaveBeenCalledExactlyOnceWith([PATH]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("falls back to the file's metadata for size and type", async () => {
    info.mockResolvedValue(uploaded({ size: undefined, contentType: undefined, metadata: { size: 10, mimetype: "audio/mp4" } }));
    expect(await saveDraft({ path: PATH.replace(/\.webm$/, ".m4a") })).toEqual({ status: "saved" });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_mime_type: "audio/mp4" });
  });

  it("refuses a take uploaded more than 2 hours ago (housekeeping may be deleting it)", async () => {
    info.mockResolvedValue(uploaded({ createdAt: "2026-10-08T01:59:00Z" }));
    expect(await saveDraft({ path: PATH })).toMatchObject({ status: "error", code: "upload_expired" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    [-5, 0],
    [1.6, 2],
    [5_000_000, 3_600_000],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    ["90", null],
    [undefined, null],
  ])("stores a duration of %s as %s", async (durationMs, stored) => {
    await saveDraft({ path: PATH, durationMs: durationMs as number });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_duration_ms: stored });
  });

  it("deletes the take it replaced", async () => {
    rpc.mockResolvedValue({ data: OLD_PATH, error: null });
    expect(await saveDraft({ path: PATH })).toEqual({ status: "saved" });
    expect(remove).toHaveBeenCalledExactlyOnceWith([OLD_PATH]);
  });

  it("never deletes the take it has just saved", async () => {
    rpc.mockResolvedValue({ data: PATH, error: null });
    await saveDraft({ path: PATH });
    expect(remove).not.toHaveBeenCalled();
  });

  it("still saves when deleting the replaced take fails", async () => {
    rpc.mockResolvedValue({ data: OLD_PATH, error: null });
    remove.mockResolvedValue({ data: null, error: { name: "StorageUnknownError", message: "boom" } });
    expect(await saveDraft({ path: PATH })).toEqual({ status: "saved" });
    expect(console.error).toHaveBeenCalledWith("checkin: removing a file failed", { code: "StorageUnknownError" });
  });

  it("deletes the new take and shows the check-in when the week was already submitted", async () => {
    rpc.mockResolvedValue(raised("already_submitted"));
    expect(await saveDraft({ path: PATH })).toEqual({ status: "submitted" });
    expect(remove).toHaveBeenCalledExactlyOnceWith([PATH]);
    expect(revalidatePath).toHaveBeenCalledWith(PAGE);
  });

  it("never deletes a submitted check-in's recording", async () => {
    rpc.mockResolvedValue(raised("already_submitted"));
    checkinsUsingPath = [{ id: "d1000000-0000-4000-8000-000000000001", member_id: MEMBER, audio_path: PATH }];
    expect(await saveDraft({ path: PATH })).toEqual({ status: "submitted" });
    expect(adminQueries.find((q) => q.table === "checkins")?.filters).toEqual([
      ["member_id", MEMBER],
      ["audio_path", PATH],
    ]);
    expect(remove).not.toHaveBeenCalled();
  });

  it("refuses, and keeps the file, when the database says the take isn't this week's", async () => {
    rpc.mockResolvedValue(raised("bad_path"));
    expect(await saveDraft({ path: PATH })).toEqual({
      status: "error",
      code: "bad_path",
      message: "That recording can't be saved. Record it again.",
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it("reports other database errors, logging only the code", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "23514", message: `violates check for ${PATH}` } });
    expect(await saveDraft({ path: PATH })).toMatchObject({ status: "error", code: "failed" });
    expect(console.error).toHaveBeenCalledWith("saveDraft: save_checkin_draft failed", { code: "23514" });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(MEMBER);
  });
});

describe("deleteDraft", () => {
  it("deletes this week's draft and its file", async () => {
    rpc.mockResolvedValue({ data: PATH, error: null });
    expect(await deleteDraft()).toEqual({ status: "deleted" });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("delete_checkin_draft", { p_member_id: MEMBER });
    expect(remove).toHaveBeenCalledExactlyOnceWith([PATH]);
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith(PAGE);
  });

  it("is fine when there was no draft", async () => {
    expect(await deleteDraft()).toEqual({ status: "deleted" });
    expect(remove).not.toHaveBeenCalled();
  });

  it("only ever deletes files in the member's own folder", async () => {
    rpc.mockResolvedValue({ data: `${OTHER}/${WEEK}-x.webm`, error: null });
    await deleteDraft();
    expect(remove).not.toHaveBeenCalled();
  });

  it("reports a database error", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "timeout" } });
    expect(await deleteDraft()).toMatchObject({ status: "error", code: "failed" });
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("submitCheckin", () => {
  const ID = "d1000000-0000-4000-8000-000000000009";

  it("submits the draft and schedules processing once, for the new check-in", async () => {
    rpc.mockResolvedValue({ data: ID, error: null });
    expect(await submitCheckin()).toEqual({ status: "submitted" });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("submit_checkin_draft", { p_member_id: MEMBER });
    expect(after).toHaveBeenCalledOnce();
    expect(processCheckin).not.toHaveBeenCalled(); // not before the response is sent

    const task = vi.mocked(after).mock.calls[0][0] as () => Promise<unknown>;
    await task();
    expect(processCheckin).toHaveBeenCalledExactlyOnceWith(ID);
    expect(revalidatePath).toHaveBeenCalledWith(PAGE);
  });

  it("asks for a recording when there's no draft", async () => {
    rpc.mockResolvedValue(raised("no_draft"));
    expect(await submitCheckin()).toEqual({
      status: "error",
      code: "no_draft",
      message: "Record your answers before you submit.",
    });
    expect(after).not.toHaveBeenCalled();
  });

  it("shows the check-in when it was already submitted (another tab)", async () => {
    rpc.mockResolvedValue(raised("already_submitted"));
    expect(await submitCheckin()).toEqual({ status: "submitted" });
    expect(after).not.toHaveBeenCalled();
  });

  it("asks for the current privacy notice before sending the recording on", async () => {
    reads.recording_notices = { data: null, error: null };
    expect(await submitCheckin()).toMatchObject({ status: "error", code: "notice_required" });
    expect(rpc).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith(PAGE);
  });

  it("reports other errors and schedules nothing", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "40001", message: "serialization failure" } });
    expect(await submitCheckin()).toMatchObject({ status: "error", code: "failed" });
    expect(after).not.toHaveBeenCalled();
  });
});
