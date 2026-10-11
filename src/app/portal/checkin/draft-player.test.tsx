// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "@/test/dom";
import { DraftPlayer } from "./draft-player";

// The draft's player shares the page with the Diary's recordings: one plays at a time, and screen
// readers can tell it from them.

const SRC = "http://127.0.0.1:54321/storage/v1/object/sign/checkin-audio/draft.webm?token=play";
const LABEL = "Your draft for the week of 5 October 2026";

// A media event as the browser fires it on the element (React listens on the element itself).
const fire = (el: HTMLAudioElement, type: string) => act(async () => void el.dispatchEvent(new Event(type)));

describe("DraftPlayer", () => {
  it("is named for screen readers", async () => {
    await render(<DraftPlayer src={SRC} label={LABEL} />);
    const draft = document.querySelector("audio")!;
    expect(draft.getAttribute("aria-label")).toBe(LABEL);
    expect(draft.getAttribute("src")).toBe(SRC);
  });

  it("pauses the Diary's recordings when it plays, and not itself", async () => {
    await render(<DraftPlayer src={SRC} label={LABEL} />);
    const draft = document.querySelector("audio")!;
    const entry = document.createElement("audio"); // a diary entry's player, further down the page
    document.body.append(entry);
    const pausedEntry = vi.spyOn(entry, "pause");
    const pausedDraft = vi.spyOn(draft, "pause");
    await fire(draft, "play");
    expect(pausedEntry).toHaveBeenCalled();
    expect(pausedDraft).not.toHaveBeenCalled();
  });
});
