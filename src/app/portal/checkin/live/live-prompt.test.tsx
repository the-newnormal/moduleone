// @vitest-environment happy-dom
import { act, createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { button, click, queryButton, render, text } from "@/test/dom";
import type { Touched } from "@/lib/coach/types";
import type { ShownOffer } from "./contract";
import { LivePrompt } from "./live-prompt";

// What a member sees while recording a live check-in: the question, the areas touched on (never a
// score), "Different question" for follow-ups only, and Finish.

const OPENING: ShownOffer = { id: 0, kind: "question", text: "Talk me through your week: what you worked on, what came of it, and how you're feeling about the team." };
const FOLLOW_UP: ShownOffer = { id: 2, kind: "question", text: "What came of the vendor onboarding at the Jurong site?" };
const COVERED: ShownOffer = { id: 3, kind: "covered", text: "That covers it, thank you. Add anything else you'd like, then press Finish." };
const NONE: Touched = { activity: false, excellence: false, morale: false };

function prompt(props: Partial<Parameters<typeof LivePrompt>[0]> = {}) {
  return (
    <LivePrompt
      offer={OPENING}
      touched={NONE}
      canSkip={false}
      onSkip={() => {}}
      onFinish={() => {}}
      finishRef={createRef<HTMLButtonElement>()}
      {...props}
    />
  );
}

describe("LivePrompt", () => {
  it("shows the question as the heading, with how to answer it", async () => {
    await render(prompt());
    expect(document.querySelector("h3")?.textContent).toBe(OPENING.text);
    expect(text()).toContain("Answer out loud. When you pause, a follow-up may appear.");
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
    await render(prompt({ touched: null }));
    expect(document.querySelector("h3")?.textContent).toBe(OPENING.text);
    expect(text()).not.toContain("a follow-up may appear");
    expect(document.querySelector("ul")).toBeNull();
    expect([...document.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Finish"]);
  });

  it("drops the how-to line for a closing line", async () => {
    await render(prompt({ offer: COVERED }));
    expect(document.querySelector("h3")?.textContent).toBe(COVERED.text);
    expect(text()).not.toContain("a follow-up may appear");
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
