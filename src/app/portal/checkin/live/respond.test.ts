import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noticeAccepted, sessionMember, type Session } from "@/lib/checkin/session";
import type { LiveErrorCode } from "./contract";
import { json, liveMember, readJson, refuse } from "./respond";

vi.mock("@/lib/checkin/session", () => ({ sessionMember: vi.fn(), noticeAccepted: vi.fn() }));

const URL_ = "https://moduleone.newnormal.sg/portal/checkin/live/coach";
const HOST = "moduleone.newnormal.sg";
const BODY = { sessionId: "1f5e0000-0000-4000-8000-000000000001", recordedMs: 95_000 };

function post(headers: Record<string, string>, body: string = JSON.stringify(BODY)): Request {
  return new Request(URL_, { method: "POST", headers, body });
}
const sameOrigin = (extra: Record<string, string> = {}) => ({
  origin: `https://${HOST}`,
  host: HOST,
  "content-type": "application/json",
  ...extra,
});

const SESSION = {
  supabase: {},
  authUserId: "5eed0000-0000-4000-8000-000000000003",
  member: { id: "3e3b0000-0000-4000-8000-000000000003", team_id: null },
} as unknown as Session;

beforeEach(() => {
  vi.mocked(sessionMember).mockReset().mockResolvedValue(SESSION);
  vi.mocked(noticeAccepted).mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readJson", () => {
  it("reads same-origin JSON", async () => {
    expect(await readJson(post(sameOrigin()))).toEqual(BODY);
  });

  it("takes a JSON content type with a charset", async () => {
    expect(await readJson(post(sameOrigin({ "content-type": "Application/JSON; charset=utf-8" })))).toEqual(BODY);
  });

  // Behind Vercel's proxy the site's own host arrives as x-forwarded-host.
  it("compares the Origin with x-forwarded-host when there is one", async () => {
    expect(await readJson(post(sameOrigin({ host: "internal.vercel.app", "x-forwarded-host": HOST })))).toEqual(BODY);
    expect(await readJson(post(sameOrigin({ "x-forwarded-host": "internal.vercel.app" })))).toBeUndefined();
  });

  it("takes the first of several forwarded hosts", async () => {
    expect(await readJson(post(sameOrigin({ "x-forwarded-host": `${HOST}, proxy.internal` })))).toEqual(BODY);
  });

  it("keeps the port in the comparison", async () => {
    const local = { origin: "http://localhost:3000", host: "localhost:3000", "content-type": "application/json" };
    expect(await readJson(post(local))).toEqual(BODY);
    expect(await readJson(post({ ...local, origin: "http://localhost:4000" }))).toBeUndefined();
  });

  it.each([
    ["another site's Origin", { origin: "https://evil.example" }],
    ["a look-alike Origin", { origin: `https://${HOST}.evil.example` }],
    ["an Origin of null", { origin: "null" }],
    ["no Origin", { origin: "" }],
  ])("refuses %s", async (_label, headers) => {
    const request = post(Object.fromEntries(Object.entries(sameOrigin(headers)).filter(([, v]) => v !== "")));
    expect(await readJson(request)).toBeUndefined();
  });

  it("refuses a request with no host to compare with", async () => {
    const request = new Request(URL_, {
      method: "POST",
      headers: { origin: `https://${HOST}`, "content-type": "application/json" },
      body: JSON.stringify(BODY),
    });
    expect(await readJson(request)).toBeUndefined();
  });

  it.each([
    ["text/plain", { "content-type": "text/plain" }],
    ["a form", { "content-type": "application/x-www-form-urlencoded" }],
    ["multipart", { "content-type": "multipart/form-data; boundary=x" }],
  ])("refuses a body sent as %s", async (_label, headers) => {
    expect(await readJson(post(sameOrigin(headers)))).toBeUndefined();
  });

  it("refuses a body with no content type", async () => {
    const request = new Request(URL_, {
      method: "POST",
      headers: { origin: `https://${HOST}`, host: HOST },
      body: new Blob([JSON.stringify(BODY)]),
    });
    expect(await readJson(request)).toBeUndefined();
  });

  it("refuses a body declared over 128 KiB before reading it", async () => {
    const request = post(sameOrigin({ "content-length": String(128 * 1024 + 1) }));
    const text = vi.spyOn(request, "text");
    expect(await readJson(request)).toBeUndefined();
    expect(text).not.toHaveBeenCalled();
  });

  it("refuses a body over 128 KiB that doesn't say how long it is", async () => {
    const big = JSON.stringify({ transcript: "ok lah ".repeat(20_000) });
    expect(big.length).toBeGreaterThan(128 * 1024);
    expect(await readJson(post(sameOrigin(), big))).toBeUndefined();
  });

  it("reads a body just under the limit", async () => {
    const body = { transcript: "a".repeat(100_000) };
    expect(await readJson(post(sameOrigin(), JSON.stringify(body)))).toEqual(body);
  });

  it.each([["{"], ["sessionId=1"], [""]])("refuses %j, which isn't JSON", async (body) => {
    expect(await readJson(post(sameOrigin(), body))).toBeUndefined();
  });
});

describe("json", () => {
  it("answers JSON that is never cached, 200 by default", async () => {
    const response = json({ status: "ended" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await response.json()).toEqual({ status: "ended" });
  });
});

describe("refuse", () => {
  it.each<[LiveErrorCode, number]>([
    ["bad_request", 400],
    ["signed_out", 401],
    ["no_member", 403],
    ["notice_required", 403],
    ["no_session", 404],
    ["submitted", 409],
    ["session_over", 410],
    ["too_many_sessions", 429],
    ["too_many_calls", 429],
    ["too_soon", 429],
    ["unavailable", 503],
  ])("answers %s with %i, uncached, and only the code", async (code, status) => {
    const response = refuse(code);
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "error", code });
  });
});

describe("liveMember", () => {
  it("is the session's member, without checking the notice when it isn't asked to", async () => {
    expect(await liveMember({ notice: false })).toBe(SESSION);
    expect(noticeAccepted).not.toHaveBeenCalled();
  });

  it("is the session's member when they have accepted the current notice", async () => {
    expect(await liveMember({ notice: true })).toBe(SESSION);
    expect(noticeAccepted).toHaveBeenCalledExactlyOnceWith(SESSION);
  });

  it.each([
    ["signed_out", "signed_out"],
    ["no_member", "no_member"],
    ["failed", "unavailable"],
  ] as const)("turns a session that is %s into %s", async (problem, code) => {
    vi.mocked(sessionMember).mockResolvedValue(problem);
    expect(await liveMember({ notice: true })).toBe(code);
    expect(noticeAccepted).not.toHaveBeenCalled();
  });

  it("asks for the notice when they haven't accepted it", async () => {
    vi.mocked(noticeAccepted).mockResolvedValue(false);
    expect(await liveMember({ notice: true })).toBe("notice_required");
  });

  it("is unavailable when the notice can't be read", async () => {
    vi.mocked(noticeAccepted).mockResolvedValue("failed");
    expect(await liveMember({ notice: true })).toBe("unavailable");
  });
});
