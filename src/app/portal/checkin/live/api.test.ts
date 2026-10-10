import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askCoach, connectLive, endLive, isLiveStartReady, startLive } from "./api";
import { LIVE_COACH_PATH, LIVE_CONNECT_PATH, LIVE_END_PATH, LIVE_START_PATH, type CoachRequest } from "./contract";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// What fetch gives back for a redirect it followed, and for one it was told not to follow.
const followedRedirect = () => {
  const response = jsonResponse({ status: "off" });
  Object.defineProperty(response, "redirected", { value: true });
  return response;
};
const manualRedirect = () => ({ type: "opaqueredirect", status: 0, redirected: false, headers: new Headers() }) as Response;

const READY = {
  status: "ready",
  sessionId: "8b0e6f4a-3c1d-4e2f-9a7b-1c2d3e4f5a6b",
  sttModel: "gpt-live-transcribe",
  opening: "How was your week, and how is the team doing?",
  pacing: { showAfterSilenceMs: 1500, stoppedSilenceMs: 5000, minQuestionMs: 20000, minWordsPerQuestion: 25, firstFollowUpAfterMs: 45000 },
};

const COACH_REQUEST: CoachRequest = {
  sessionId: READY.sessionId,
  transcript: "This week I shipped the login page with Wei Ling.",
  elapsedMs: 32_000,
  shown: 0,
  skip: null,
};

const COACH_OK = {
  status: "ok",
  offer: { id: 1, kind: "question", text: "Where did your superpower come in this week?" },
  touched: { activity: true, excellence: false, morale: false },
  degraded: false,
};

const sentInit = () => fetchMock.mock.calls[0][1] as RequestInit;

describe("startLive", () => {
  it("posts same-origin JSON, never cached, without following redirects", async () => {
    fetchMock.mockResolvedValue(jsonResponse(READY));
    const signal = new AbortController().signal;
    const result = await startLive(signal);
    expect(result).toEqual(READY);
    expect(isLiveStartReady(result)).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe(LIVE_START_PATH);
    expect(sentInit()).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "manual",
      signal,
    });
  });

  it.each([
    ["off", { status: "off" }, 200],
    ["an error", { status: "error", code: "notice_required" }, 403],
    ["too many sessions", { status: "error", code: "too_many_sessions" }, 429],
  ])("passes on %s as it is", async (_label, body, status) => {
    fetchMock.mockResolvedValue(jsonResponse(body, status));
    const result = await startLive();
    expect(result).toEqual(body);
    expect(isLiveStartReady(result)).toBe(false);
  });

  it.each([
    ["the network fails", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a followed redirect (signed out)", () => Promise.resolve(followedRedirect())],
    ["a redirect it didn't follow", () => Promise.resolve(manualRedirect())],
    ["an HTML page", () => Promise.resolve(new Response("<!doctype html><p>Log in</p>", { headers: { "content-type": "text/html" } }))],
    ["broken JSON", () => Promise.resolve(new Response("{", { headers: { "content-type": "application/json" } }))],
    ["a JSON array", () => Promise.resolve(jsonResponse([READY]))],
    ["an unknown status", () => Promise.resolve(jsonResponse({ status: "maybe" }))],
    ["an error without a code", () => Promise.resolve(jsonResponse({ status: "error" }, 500))],
    ["ready without a session", () => Promise.resolve(jsonResponse({ ...READY, sessionId: "" }))],
    ["ready without the pacing", () => Promise.resolve(jsonResponse({ ...READY, pacing: undefined }))],
    ["ready with broken pacing", () => Promise.resolve(jsonResponse({ ...READY, pacing: { ...READY.pacing, minQuestionMs: "20s" } }))],
  ])("answers null for %s", async (_label, respond) => {
    fetchMock.mockImplementation(respond);
    const result = await startLive();
    expect(result).toBeNull();
    expect(isLiveStartReady(result)).toBe(false);
  });
});

describe("connectLive", () => {
  const REQUEST = { sessionId: READY.sessionId, offer: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n" };

  it("sends the offer for the session and passes on OpenAI's answer", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "connected", answer: "v=0\r\nanswer" }));
    expect(await connectLive(REQUEST)).toEqual({ status: "connected", answer: "v=0\r\nanswer" });
    expect(fetchMock.mock.calls[0][0]).toBe(LIVE_CONNECT_PATH);
    expect(JSON.parse(sentInit().body as string)).toEqual(REQUEST);
  });

  it("passes on a refusal", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "error", code: "no_session" }, 404));
    expect(await connectLive(REQUEST)).toEqual({ status: "error", code: "no_session" });
  });

  it.each([
    ["connected without an answer", { status: "connected", answer: "" }],
    ["an unknown status", { status: "maybe" }],
  ])("answers null for %s", async (_label, body) => {
    fetchMock.mockResolvedValue(jsonResponse(body));
    expect(await connectLive(REQUEST)).toBeNull();
  });
});

describe("askCoach", () => {
  it("sends the transcript and passes on the answer", async () => {
    fetchMock.mockResolvedValue(jsonResponse(COACH_OK));
    expect(await askCoach(COACH_REQUEST)).toEqual(COACH_OK);
    expect(fetchMock.mock.calls[0][0]).toBe(LIVE_COACH_PATH);
    expect(JSON.parse(sentInit().body as string)).toEqual(COACH_REQUEST);
  });

  it("takes an answer with nothing new to show, and errors", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...COACH_OK, offer: null, degraded: true }));
    expect(await askCoach(COACH_REQUEST)).toEqual({ ...COACH_OK, offer: null, degraded: true });
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "error", code: "too_soon" }, 429));
    expect(await askCoach(COACH_REQUEST)).toEqual({ status: "error", code: "too_soon" });
  });

  it.each([
    ["an offer of an unknown kind", { ...COACH_OK, offer: { ...COACH_OK.offer, kind: "lecture" } }],
    ["an offer without text", { ...COACH_OK, offer: { id: 2, kind: "question", text: "" } }],
    ["an area missing", { ...COACH_OK, touched: { activity: true, excellence: false } }],
    ["no degraded flag", { ...COACH_OK, degraded: undefined }],
  ])("answers null for %s", async (_label, body) => {
    fetchMock.mockResolvedValue(jsonResponse(body));
    expect(await askCoach(COACH_REQUEST)).toBeNull();
  });

  it("answers null when the call is cancelled", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    );
    const pending = askCoach(COACH_REQUEST, controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
  });
});

describe("endLive", () => {
  it("sends with keepalive and doesn't wait", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "ended" }));
    expect(endLive({ sessionId: READY.sessionId, recordedMs: 184_000, shown: 2 })).toBeUndefined();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe(LIVE_END_PATH);
    expect(sentInit()).toMatchObject({ method: "POST", keepalive: true, cache: "no-store", credentials: "same-origin" });
    expect(JSON.parse(sentInit().body as string)).toEqual({ sessionId: READY.sessionId, recordedMs: 184_000, shown: 2 });
  });

  it("sends shown as null when no coach offer was on screen", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "ended" }));
    endLive({ sessionId: READY.sessionId, recordedMs: 0, shown: null });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(sentInit().body as string)).toEqual({ sessionId: READY.sessionId, recordedMs: 0, shown: null });
  });

  it("swallows failures", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      endLive({ sessionId: READY.sessionId, recordedMs: 1000, shown: 0 });
      fetchMock.mockImplementationOnce(() => {
        throw new TypeError("keepalive body too large");
      });
      expect(() => endLive({ sessionId: READY.sessionId, recordedMs: 1000, shown: 0 })).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
