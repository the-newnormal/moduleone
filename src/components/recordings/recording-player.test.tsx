// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { button, click, render, text } from "@/test/dom";
import { RecordingPlayer } from "./recording-player";

// The player the drill-in and the Diary share: the Diary has several on one page, so each says
// whose week it plays, and only one plays at a time.

const SRC = "/portal/dashboard/recording/00000000-0000-4000-8000-000000000001.webm";
const OTHER = "/portal/dashboard/recording/00000000-0000-4000-8000-000000000002.webm";

const audios = () => [...document.querySelectorAll("audio")];
// A media event as the browser fires it on the element (React listens on the element itself).
const fire = (el: HTMLAudioElement, type: string) => act(async () => void el.dispatchEvent(new Event(type)));

describe("RecordingPlayer", () => {
  it("is named for screen readers when given a label, and loads nothing until played", async () => {
    await render(
      <>
        <RecordingPlayer src={SRC} label="Your recording for the week of 5 October 2026" />
        <RecordingPlayer src={OTHER} />
      </>,
    );
    const [labelled, plain] = audios();
    expect(labelled.getAttribute("aria-label")).toBe("Your recording for the week of 5 October 2026");
    expect(labelled.getAttribute("preload")).toBe("none");
    expect(labelled.getAttribute("src")).toBe(SRC);
    expect(plain.hasAttribute("aria-label")).toBe(false); // the drill-in passes none
  });

  it("pauses every other recording on the page when one plays", async () => {
    await render(
      <>
        <RecordingPlayer src={SRC} />
        <RecordingPlayer src={OTHER} />
      </>,
    );
    const [first, second] = audios();
    const pausedFirst = vi.spyOn(first, "pause");
    const pausedSecond = vi.spyOn(second, "pause");
    await fire(first, "play");
    expect(pausedSecond).toHaveBeenCalled();
    expect(pausedFirst).not.toHaveBeenCalled(); // not the one that's playing
  });

  it("says it couldn't play, with Try again, when a fresh link fails as well", async () => {
    await render(<RecordingPlayer src={SRC} />);
    const [el] = audios();
    await fire(el, "error"); // the first: a link that ran out, so it fetches a fresh one by itself
    expect(el.getAttribute("src")).toBe(`${SRC}?reload=1`);
    expect(document.querySelector('[role="alert"]')).toBeNull();

    await fire(el, "error"); // again within a minute: a real failure
    const alert = document.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(text(alert!)).toBe("Couldn't play the recording. Try again or refresh the page.");
    expect(text(alert!)).not.toContain("sign in");

    vi.spyOn(el, "play").mockResolvedValue(undefined);
    await click(button("Try again"));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(el.getAttribute("src")).toBe(`${SRC}?reload=2`);
    expect(el.play).toHaveBeenCalled();
  });
});
