import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coachRubric } from "@/lib/coach/rubric";
import { RubricError } from "@/lib/rubrics/markdown";
import { checkinQuestion } from "./opening";
import { DEFAULT_OPENING_QUESTION } from "./week";

vi.mock("@/lib/coach/rubric", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coach/rubric")>();
  return { ...actual, coachRubric: vi.fn(actual.coachRubric) };
});

const actual = await vi.importActual<typeof import("@/lib/coach/rubric")>("@/lib/coach/rubric");

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("checkinQuestion", () => {
  it.each([
    ["on", true],
    ["off", false],
  ])("asks rubrics/coach.md's opening question with live check-ins %s", (setting, live) => {
    vi.stubEnv("LIVE_CHECKIN", setting);
    expect(checkinQuestion()).toEqual({ opening: actual.coachRubric().opening, live });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("asks the file's question, not the built-in one, when the two differ", () => {
    vi.mocked(coachRubric).mockReturnValueOnce({ ...actual.coachRubric(), opening: "How was your week, all of it?" });
    expect(checkinQuestion().opening).toBe("How was your week, all of it?");
  });

  it("asks the built-in question, without follow-ups, when the file can't be used, and says so in the logs", () => {
    vi.stubEnv("LIVE_CHECKIN", "off");
    vi.mocked(coachRubric).mockImplementationOnce(() => {
      throw new RubricError("rubrics/coach.md", ['The section "## Opening question" is missing.']);
    });
    expect(checkinQuestion()).toEqual({ opening: DEFAULT_OPENING_QUESTION, live: false });
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      "checkin: rubrics/coach.md can't be used; asking the built-in opening question until it is fixed",
      { problems: ['The section "## Opening question" is missing.'] },
    );
  });

  it("doesn't hide a fault that isn't the file's", () => {
    vi.mocked(coachRubric).mockImplementationOnce(() => {
      throw new TypeError("boom");
    });
    expect(() => checkinQuestion()).toThrow("boom");
  });
});
