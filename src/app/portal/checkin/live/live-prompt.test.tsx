// @vitest-environment happy-dom
import { act, createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { button, click, queryButton, render, text } from "@/test/dom";
import type { Touched } from "@/lib/coach/types";
import type { ShownOffer } from "./contract";
import { FOLLOW_UP_COPY, LAST_FOLLOW_UP, LivePrompt } from "./live-prompt";
import type { FollowUpStatus } from "./pacing";

// What a member sees while recording a live check-in: the question, a line saying what is coming,
// the areas touched on (never a score), "Different question" for follow-ups only, and Finish.

const OPENING: ShownOffer = {
  id: 0,
  kind: "question",
  text: "Talk me through your week: what you worked on and what came of it, a moment you or your team were at your best, and how you're feeling about the team.",
};
const FOLLOW_UP: ShownOffer = { id: 2, kind: "question", text: "What came of the vendor onboarding at the Jurong site?" };
const COVERED: ShownOffer = { id: 3, kind: "covered", text: "That covers it, thank you. Add anything else you'd like, then press Finish." };
const NONE: Touched = { activity: false, excellence: false, morale: false };
const STATUSES: FollowUpStatus[] = ["starting", "listening", "checking", "ready", "no_more"];

// The line under the question, and its dots.
const statusLine = () => document.querySelector<HTMLParagraphElement>("h3 + p");
const dots = () => [...(statusLine()?.querySelectorAll("span > span") ?? [])];
// Every class on the line and inside it.
const lineClasses = () =>
  [statusLine(), ...(statusLine()?.querySelectorAll("*") ?? [])].flatMap((el) => [...(el?.classList ?? [])]);

function prompt(props: Partial<Parameters<typeof LivePrompt>[0]> = {}) {
  return (
    <LivePrompt
      offer={OPENING}
      touched={NONE}
      status="listening"
      canSkip={false}
      onSkip={() => {}}
      onFinish={() => {}}
      finishRef={createRef<HTMLButtonElement>()}
      {...props}
    />
  );
}

describe("LivePrompt", () => {
  it("shows the question as the heading, with what is coming under it", async () => {
    await render(prompt());
    expect(document.querySelector("h3")?.textContent).toBe(OPENING.text);
    expect(statusLine()?.textContent).toBe("Listening…");
    expect(text()).not.toContain("a follow-up may appear");
    expect(button("Finish")).toBeTruthy();
    expect(queryButton("Different question")).toBeNull();
  });

  it("marks the areas touched on, in words, never as a score", async () => {
    await render(prompt({ touched: { activity: true, excellence: false, morale: true } }));
    const items = [...document.querySelectorAll("li")].map((li) => text(li));
    expect(items).toEqual(["Touched on: What you did", "Not yet: At your best", "Touched on: The team"]);
    expect(text()).not.toMatch(/\d/);
  });

  it("offers a different question for a follow-up, and Finish always", async () => {
    const onSkip = vi.fn();
    const onFinish = vi.fn();
    await render(prompt({ offer: FOLLOW_UP, canSkip: true, onSkip, onFinish }));
    await click(button("Different question"));
    expect(onSkip).toHaveBeenCalledOnce();
    await click(button("Finish"));
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it("reads light on dark when laid over the member's camera", async () => {
    await render(prompt({ offer: FOLLOW_UP, canSkip: true, touched: { activity: true, excellence: false, morale: false }, onStage: true }));
    expect(button("Finish").className).toContain("bg-white");
    expect(button("Different question").className).toContain("text-white");
    expect(document.querySelectorAll("li")[1].firstElementChild?.className).toContain("text-white/80"); // "Not yet"
    expect(document.querySelector("p")?.className).toContain("text-white/75");
  });

  it("shows only the question and Finish when no follow-ups are coming", async () => {
    await render(prompt({ touched: null, status: null }));
    expect(document.querySelector("h3")?.textContent).toBe(OPENING.text);
    expect(document.querySelector("p")).toBeNull();
    for (const copy of [...Object.values(FOLLOW_UP_COPY), LAST_FOLLOW_UP]) expect(text()).not.toContain(copy);
    expect(document.querySelector("ul")).toBeNull();
    expect([...document.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Finish"]);
  });

  it("says no more follow-ups are coming under a closing line", async () => {
    await render(prompt({ offer: COVERED, status: "no_more" }));
    expect(document.querySelector("h3")?.textContent).toBe(COVERED.text);
    expect(statusLine()?.textContent).toBe("No more follow-ups.");
  });

  describe("the line saying what is coming", () => {
    it.each([
      ["starting", "Starting follow-ups…"],
      ["listening", "Listening…"],
      ["checking", "Checking for a follow-up…"],
      ["ready", "A follow-up will show when you pause."],
      ["no_more", "No more follow-ups."],
    ] as const)("says %s in words, between the question and the areas", async (status, copy) => {
      await render(prompt({ status }));
      expect(FOLLOW_UP_COPY[status]).toBe(copy);
      expect(statusLine()?.textContent).toBe(copy);
      expect(statusLine()?.nextElementSibling?.tagName).toBe("UL");
    });

    // Only ready says one is coming; checking may bring one, a closing line, or nothing new.
    it("promises a follow-up only once one is ready", () => {
      for (const status of STATUSES) expect(/will show|is coming|on its way/.test(FOLLOW_UP_COPY[status])).toBe(status === "ready");
      expect(FOLLOW_UP_COPY.checking).not.toMatch(/preparing/i);
    });

    it("says none come after a follow-up question, which Different question can still swap", async () => {
      const page = await render(prompt({ offer: FOLLOW_UP, canSkip: true, status: "no_more" }));
      expect(statusLine()?.textContent).toBe("No more follow-ups after this one.");
      expect(LAST_FOLLOW_UP).toBe("No more follow-ups after this one.");
      expect(button("Different question")).toBeTruthy();
      // Under the opening question, none have come: no "this one" to speak of.
      await page.rerender(prompt({ offer: OPENING, status: "no_more" }));
      expect(statusLine()?.textContent).toBe("No more follow-ups.");
    });

    it.each([
      ["listening", 1],
      ["starting", 3],
      ["checking", 3],
      ["ready", 3],
      ["no_more", 0],
    ] as const)("shows %s with %i dots", async (status, count) => {
      await render(prompt({ status }));
      expect(dots()).toHaveLength(count);
      // With no dots, no slot either: the words sit flush.
      expect(statusLine()?.querySelector("span") === null).toBe(count === 0);
    });

    it.each(STATUSES)("moves its dots only where the device allows motion, and only while something is on its way (%s)", async (status) => {
      await render(prompt({ status }));
      const motion = lineClasses().filter((name) => name.includes("animate") || name.includes("animation"));
      for (const name of motion) expect(name.startsWith("motion-safe:")).toBe(true);
      // Ready waits on them, so its dots are still.
      if (status === "starting" || status === "checking") {
        expect(dots().map((dot) => dot.className.includes("motion-safe:animate-follow-up"))).toEqual([true, true, true]);
        // Staggered, so the three fade in turn.
        expect(motion.filter((name) => name.includes("animation-delay"))).toEqual([
          "motion-safe:[animation-delay:200ms]",
          "motion-safe:[animation-delay:400ms]",
        ]);
      } else {
        expect(motion).toEqual([]);
      }
    });

    it.each(STATUSES)("isn't a live region, and hides its dots from screen readers (%s)", async (status) => {
      await render(prompt({ status }));
      const line = statusLine()!;
      expect(line.hasAttribute("aria-live")).toBe(false);
      expect(line.hasAttribute("role")).toBe(false);
      for (const slot of line.querySelectorAll(":scope > span")) expect(slot.getAttribute("aria-hidden")).toBe("true");
      expect(text(line)).toBe(FOLLOW_UP_COPY[status]); // only the words are read
    });

    it.each(STATUSES)("takes the text's own colour, never sun (%s)", async (status) => {
      for (const onStage of [false, true]) {
        const page = await render(prompt({ status, onStage }));
        expect(lineClasses().some((name) => name.includes("sun"))).toBe(false);
        expect(statusLine()?.classList.contains(onStage ? "text-white/75" : "text-muted-foreground")).toBe(true);
        for (const dot of dots()) expect(dot.classList.contains("bg-current")).toBe(true);
        await page.rerender(null);
      }
    });

    it("holds the words in place between states, so they don't shift", async () => {
      const page = await render(prompt({ status: "listening" }));
      expect(statusLine()?.querySelector("span")?.classList.contains("w-6.5")).toBe(true);
      await page.rerender(prompt({ status: "checking" }));
      expect(statusLine()?.querySelector("span")?.classList.contains("w-6.5")).toBe(true);
    });
  });

  it("moves focus to Finish when a closing line replaces the question they asked to change", async () => {
    const finishRef = createRef<HTMLButtonElement>();
    const page = await render(prompt({ offer: FOLLOW_UP, canSkip: true, finishRef }));
    const skip = button("Different question");
    skip.focus();
    await click(skip);
    await page.rerender(prompt({ offer: COVERED, canSkip: false, finishRef }));
    expect(queryButton("Different question")).toBeNull();
    expect(document.activeElement).toBe(button("Finish"));
  });

  it("moves focus to Finish when a closing line arrives while they have tabbed to Different question", async () => {
    const onSkip = vi.fn();
    const finishRef = createRef<HTMLButtonElement>();
    const page = await render(prompt({ offer: FOLLOW_UP, canSkip: true, onSkip, finishRef }));
    await act(async () => button("Different question").focus());
    await page.rerender(prompt({ offer: COVERED, canSkip: false, onSkip, finishRef }));
    expect(queryButton("Different question")).toBeNull();
    expect(document.activeElement).toBe(button("Finish"));
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("doesn't pull focus to Finish once they have moved off Different question", async () => {
    const finishRef = createRef<HTMLButtonElement>();
    const withHelp = (props: Partial<Parameters<typeof LivePrompt>[0]>) => (
      <>
        {prompt({ finishRef, ...props })}
        <a href="#help">Help</a>
      </>
    );
    const page = await render(withHelp({ offer: FOLLOW_UP, canSkip: true }));
    const help = document.querySelector<HTMLAnchorElement>('a[href="#help"]')!;
    await act(async () => button("Different question").focus());
    await act(async () => help.focus());
    // Then off the controls altogether (a click on the page, say).
    await act(async () => help.blur());
    expect(document.activeElement).toBe(document.body);
    await page.rerender(withHelp({ offer: COVERED, canSkip: false }));
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves focus alone when a new question simply replaces the last", async () => {
    const finishRef = createRef<HTMLButtonElement>();
    const page = await render(prompt({ offer: FOLLOW_UP, canSkip: true, finishRef }));
    const skip = button("Different question");
    skip.focus();
    await click(skip);
    await page.rerender(prompt({ offer: { ...FOLLOW_UP, id: 4, text: "How is the team finding the new review process?" }, canSkip: true, finishRef }));
    expect(document.activeElement).toBe(button("Different question"));
  });
});
