// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noticeSections } from "@/lib/checkin/notice";
import { QUESTIONS } from "@/lib/checkin/week";
import { coachRubric } from "@/lib/coach/rubric";
import { RubricError } from "@/lib/rubrics/markdown";
import { text } from "@/test/dom";
import { QuestionsTile } from "./questions-tile";

// The home page's questions tile: the three fixed questions, or with the live check-in on, the
// opening question from rubrics/coach.md; and the privacy notice to read again either way.

vi.mock("@/lib/coach/rubric", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coach/rubric")>();
  return { ...actual, coachRubric: vi.fn(actual.coachRubric) };
});

// The opening question as rubrics/coach.md has it now: people edit that file, so it isn't copied here.
const actual = await vi.importActual<typeof import("@/lib/coach/rubric")>("@/lib/coach/rubric");
const OPENING = actual.coachRubric().opening;

function render() {
  document.body.innerHTML = renderToStaticMarkup(<QuestionsTile />);
  return document.querySelector<HTMLElement>('section[aria-labelledby="questions-title"]')!;
}

const items = (tile: HTMLElement) => [...tile.querySelectorAll("li")].map((li) => text(li));
const notice = (tile: HTMLElement) => text(tile.querySelector("details")!);

beforeEach(() => {
  vi.stubEnv("LIVE_CHECKIN", "off");
  vi.mocked(coachRubric).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the questions tile", () => {
  it("lists the three questions when the live check-in is off", () => {
    const tile = render();
    expect(text(tile.querySelector("h2")!)).toBe("This week's questions");
    expect(items(tile)).toEqual(QUESTIONS.map((q, i) => `${i + 1}${q.text}`));
    expect(text(tile)).toContain("The recorder shows them one at a time.");
    expect(text(tile)).not.toContain("follow-up question");
    expect(coachRubric).not.toHaveBeenCalled();
  });

  it("shows the opening question from rubrics/coach.md when the live check-in is on", () => {
    vi.stubEnv("LIVE_CHECKIN", "on");
    const tile = render();
    expect(text(tile.querySelector("h2")!)).toBe("This week's questions");
    expect(text(tile)).toContain(OPENING);
    expect(text(tile)).toContain(
      "As you talk, a follow-up question may appear when you pause. The topics are what you did, where you or your team were at your best, and how you feel about the team.",
    );
    expect(tile.querySelector("ol")).toBeNull();
    expect(text(tile)).not.toContain("The recorder shows them one at a time.");
  });

  it("falls back to the three questions when rubrics/coach.md can't be used", () => {
    vi.stubEnv("LIVE_CHECKIN", "on");
    vi.mocked(coachRubric).mockImplementationOnce(() => {
      throw new RubricError("rubrics/coach.md", ['The section "## Opening question" is missing.']);
    });
    const tile = render();
    expect(items(tile)).toEqual(QUESTIONS.map((q, i) => `${i + 1}${q.text}`));
    expect(text(tile)).toContain("The recorder shows them one at a time.");
    expect(text(tile)).not.toContain(OPENING);
  });

  it("doesn't hide a fault that isn't the rubric file's", () => {
    vi.stubEnv("LIVE_CHECKIN", "on");
    vi.mocked(coachRubric).mockImplementationOnce(() => {
      throw new TypeError("boom");
    });
    expect(() => render()).toThrow("boom");
  });

  it.each([["off"], ["on"]])("keeps the privacy notice to read again, as it reads with LIVE_CHECKIN=%s", (value) => {
    vi.stubEnv("LIVE_CHECKIN", value);
    const tile = render();
    const details = tile.querySelector("details")!;
    expect(details.hasAttribute("open")).toBe(false);
    expect(text(details.querySelector("summary")!)).toBe("How your recording is used");
    for (const { heading, body } of noticeSections()) {
      expect(notice(tile)).toContain(heading);
      expect(notice(tile)).toContain(body);
    }
  });

  it("names OpenAI for the live audio in the notice when the live check-in is on", () => {
    vi.stubEnv("LIVE_CHECKIN", "on");
    vi.stubEnv("STT_PROVIDER", "local");
    vi.stubEnv("STT_FALLBACK", "none");
    expect(notice(render())).toContain("While you record, your voice is streamed to OpenAI, in the United States");
  });
});
