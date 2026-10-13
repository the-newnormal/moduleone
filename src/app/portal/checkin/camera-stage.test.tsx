// @vitest-environment happy-dom
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { noticeSections } from "@/lib/checkin/notice";
import { button, click, render } from "@/test/dom";
import { CameraRow, ON_STAGE_OUTLINE, VOICE_ONLY_LINE } from "./camera-stage";

// The camera's own row, on the stage and in the card: what is recorded (only the voice), and the
// button that turns the camera on or off. Never the main action, and never announced.

function row(props: Partial<Parameters<typeof CameraRow>[0]> = {}) {
  return <CameraRow on={false} onToggle={() => {}} buttonRef={createRef<HTMLButtonElement>()} {...props} />;
}
const line = () => [...document.querySelectorAll("p")].find((p) => p.textContent === VOICE_ONLY_LINE) ?? null;
const theButton = () => document.querySelector("button")!;
// Every class in the row, on every element (the icon's included).
const classes = () => [...document.querySelectorAll("body *")].flatMap((el) => [...el.classList]);

describe("CameraRow", () => {
  it("turns the camera off while it's on, and on while it's off", async () => {
    const onToggle = vi.fn();
    const page = await render(row({ on: true, onToggle }));
    expect(theButton().textContent).toBe("Turn off my camera");
    await click(button("Turn off my camera"));
    expect(onToggle).toHaveBeenCalledOnce();
    await page.rerender(row({ on: false, onToggle }));
    expect(theButton().textContent).toBe("Turn on my camera");
    expect(theButton().getAttribute("aria-disabled")).not.toBe("true");
    await click(button("Turn on my camera"));
    expect(onToggle).toHaveBeenCalledTimes(2);
    // One button whose words change: not a pressed/unpressed switch.
    expect(theButton().hasAttribute("aria-pressed")).toBe(false);
  });

  it("waits, and ignores presses, while the browser asks about the camera", async () => {
    const onToggle = vi.fn();
    await render(row({ waiting: true, onToggle }));
    expect(theButton().textContent).toBe("Waiting for your camera…");
    expect(theButton().getAttribute("aria-disabled")).toBe("true");
    await click(theButton());
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("hides its icon from screen readers, a camera to turn on and a crossed-out one to turn off", async () => {
    const page = await render(row({ on: false }));
    const off = theButton().querySelector("svg");
    expect(off?.getAttribute("aria-hidden")).toBe("true");
    const offIcon = off?.innerHTML;
    await page.rerender(row({ waiting: true }));
    expect(theButton().querySelector("svg")?.innerHTML).toBe(offIcon); // still the camera while waiting
    await page.rerender(row({ on: true }));
    const on = theButton().querySelector("svg");
    expect(on?.getAttribute("aria-hidden")).toBe("true");
    expect(on?.innerHTML).not.toBe(offIcon);
  });

  it("is light on dark over the stage, and muted in the card", async () => {
    const page = await render(row({ on: true, onStage: true }));
    for (const name of ON_STAGE_OUTLINE.split(" ")) expect(theButton().classList).toContain(name);
    expect(theButton().classList).toContain("text-white");
    expect(line()?.classList).toContain("text-white/75");
    expect(line()?.classList).not.toContain("text-muted-foreground");
    await page.rerender(row({ on: false }));
    expect(line()?.classList).toContain("text-muted-foreground");
    expect(line()?.classList).not.toContain("text-white/75");
    expect(theButton().classList).not.toContain("text-white");
  });

  it("is never the main action: no sun, and not the stage's white main button", async () => {
    for (const props of [{ on: true, onStage: true }, { on: false }, { waiting: true }]) {
      const page = await render(row(props));
      expect(classes().filter((name) => name.includes("sun"))).toEqual([]);
      expect(classes()).not.toContain("bg-white"); // ON_STAGE_MAIN
      expect(classes()).not.toContain("text-black");
      expect(theButton().getAttribute("data-variant")).toBe("outline");
      await page.rerender(<></>);
    }
  });

  it("says only the voice is recorded, and announces nothing", async () => {
    await render(row({ on: true, note: "Your camera didn't come on, so you're recording without it." }));
    expect(line()?.textContent).toBe(VOICE_ONLY_LINE);
    expect(document.querySelectorAll("[role]")).toHaveLength(0);
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(0);
  });

  it("ties the line, and the note when there is one, to the button", async () => {
    const page = await render(row());
    expect(theButton().getAttribute("aria-describedby")).toBe(line()?.id);
    expect(line()?.id).toBeTruthy();
    const NOTE = "Your camera didn't come on, so you're recording without it.";
    await page.rerender(row({ note: NOTE }));
    const note = [...document.querySelectorAll("p")].find((p) => p.textContent === NOTE)!;
    expect(note.id).toBeTruthy();
    expect(theButton().getAttribute("aria-describedby")?.split(" ")).toEqual([line()?.id, note.id]);
    expect(note.classList).toContain("text-muted-foreground");
  });

  it("hands its button to the recorder, to focus", async () => {
    const buttonRef = createRef<HTMLButtonElement>();
    await render(row({ buttonRef }));
    expect(buttonRef.current).toBe(theButton());
  });
});

// The screen says, in short, what the privacy notice says: never more.
describe("VOICE_ONLY_LINE", () => {
  it("agrees with the privacy notice's What we record, with live check-ins on or off", () => {
    for (const env of [{}, { LIVE_CHECKIN: "on" }]) {
      const body = noticeSections(env).find((section) => section.heading === "What we record")?.body;
      expect(body).toContain("Only your voice is recorded.");
      expect(body).toContain("never saved or sent");
    }
    expect(VOICE_ONLY_LINE.startsWith("Only your voice is recorded.")).toBe(true);
    expect(VOICE_ONLY_LINE).toContain("never saved or sent");
  });
});
