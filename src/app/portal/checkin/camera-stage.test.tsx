// @vitest-environment happy-dom
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { button, click, render } from "@/test/dom";
import { CameraButton, CameraRow, CameraStage, ON_STAGE_MAIN, ON_STAGE_TOP, VOICE_ONLY_LINE, VoiceOnlyLine } from "./camera-stage";

// The camera's button (on the stage, in its top row; in the card, in the camera's row), the line
// saying only the voice is recorded, and the stage they sit on. The button is never the main action,
// and nothing here is announced.

function cameraButton(props: Partial<Parameters<typeof CameraButton>[0]> = {}) {
  return <CameraButton on={false} onToggle={() => {}} buttonRef={createRef<HTMLButtonElement>()} {...props} />;
}
function row(props: Partial<Parameters<typeof CameraRow>[0]> = {}) {
  return <CameraRow onToggle={() => {}} buttonRef={createRef<HTMLButtonElement>()} {...props} />;
}
const line = () => [...document.querySelectorAll("p")].find((p) => p.textContent === VOICE_ONLY_LINE) ?? null;
const theButton = () => document.querySelector("button")!;
// Every class in what's rendered, on every element (the icon's included).
const classes = () => [...document.querySelectorAll("body *")].flatMap((el) => [...el.classList]);
const NOTE = "Your camera didn't come on, so you're recording without it.";

describe("CameraButton", () => {
  it("turns the camera off while it's on, and on while it's off", async () => {
    const onToggle = vi.fn();
    const page = await render(cameraButton({ on: true, onToggle }));
    expect(theButton().textContent).toBe("Turn off my camera");
    await click(button("Turn off my camera"));
    expect(onToggle).toHaveBeenCalledOnce();
    await page.rerender(cameraButton({ on: false, onToggle }));
    expect(theButton().textContent).toBe("Turn on my camera");
    expect(theButton().getAttribute("aria-disabled")).not.toBe("true");
    await click(button("Turn on my camera"));
    expect(onToggle).toHaveBeenCalledTimes(2);
    // One button whose words change: not a pressed/unpressed switch.
    expect(theButton().hasAttribute("aria-pressed")).toBe(false);
  });

  it("waits, and ignores presses, while the browser asks about the camera", async () => {
    const onToggle = vi.fn();
    await render(cameraButton({ waiting: true, onToggle }));
    expect(theButton().textContent).toBe("Waiting for your camera…");
    expect(theButton().getAttribute("aria-disabled")).toBe("true");
    await click(theButton());
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("hides its icon from screen readers, a camera to turn on and a crossed-out one to turn off", async () => {
    const page = await render(cameraButton({ on: false }));
    const off = theButton().querySelector("svg");
    expect(off?.getAttribute("aria-hidden")).toBe("true");
    const offIcon = off?.innerHTML;
    await page.rerender(cameraButton({ waiting: true }));
    expect(theButton().querySelector("svg")?.innerHTML).toBe(offIcon); // still the camera while waiting
    await page.rerender(cameraButton({ on: true }));
    const on = theButton().querySelector("svg");
    expect(on?.getAttribute("aria-hidden")).toBe("true");
    expect(on?.innerHTML).not.toBe(offIcon);
  });

  it("is outlined in white on a dark ground of its own over the stage's picture, and plain in the card", async () => {
    const page = await render(cameraButton({ on: true, onStage: true }));
    for (const name of ON_STAGE_TOP.split(" ")) expect(theButton().classList).toContain(name);
    expect(theButton().classList).toContain("text-white");
    expect(theButton().classList).toContain("bg-black/55"); // readable over a bright picture, as the pills are
    expect(theButton().classList).not.toContain("bg-transparent");
    await page.rerender(cameraButton({ on: false }));
    expect(theButton().classList).not.toContain("text-white");
    expect(theButton().classList).not.toContain("bg-black/55");
  });

  it("is never the main action: no sun, and not the stage's white main button", async () => {
    for (const props of [{ on: true, onStage: true }, { on: false }, { waiting: true }, { waiting: true, onStage: true }]) {
      const page = await render(cameraButton(props));
      expect(classes().filter((name) => name.includes("sun"))).toEqual([]);
      for (const name of ON_STAGE_MAIN.split(" ").filter((name) => name !== "focus-visible:outline-white")) {
        expect(classes()).not.toContain(name);
      }
      expect(theButton().getAttribute("data-variant")).toBe("outline");
      await page.rerender(<></>);
    }
  });

  it("is described only by what it's given, and by nothing otherwise", async () => {
    const page = await render(
      <>
        <p id="said">{VOICE_ONLY_LINE}</p>
        {cameraButton({ on: true, onStage: true, describedBy: "said" })}
      </>,
    );
    expect(theButton().getAttribute("aria-describedby")).toBe("said");
    await page.rerender(cameraButton({ on: true, onStage: true }));
    expect(theButton().hasAttribute("aria-describedby")).toBe(false);
  });

  it("hands itself to the recorder, to focus", async () => {
    const buttonRef = createRef<HTMLButtonElement>();
    await render(cameraButton({ buttonRef }));
    expect(buttonRef.current).toBe(theButton());
  });
});

// In the card while recording, where the camera is off.
describe("CameraRow", () => {
  it("says only the voice is recorded, beside the button that turns the camera on", async () => {
    const onToggle = vi.fn();
    await render(row({ onToggle }));
    expect(line()?.classList).toContain("text-muted-foreground");
    expect(line()?.parentElement?.contains(button("Turn on my camera"))).toBe(true);
    await click(button("Turn on my camera"));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("waits while the browser asks, with the note under it", async () => {
    await render(row({ waiting: true, note: "You're still recording." }));
    expect(theButton().textContent).toBe("Waiting for your camera…");
    expect(theButton().getAttribute("aria-disabled")).toBe("true");
    expect([...document.querySelectorAll("p")].map((p) => p.textContent)).toEqual([VOICE_ONLY_LINE, "You're still recording."]);
  });

  // The recorder moves focus to this button at each switch mid-take, and a screen reader reads a
  // focused control's description (and reads it again when it changes): through the speakers, into
  // the microphone and the take.
  it("ties neither the line nor the note to the button, and announces nothing", async () => {
    const page = await render(row());
    expect(theButton().hasAttribute("aria-describedby")).toBe(false);
    await page.rerender(row({ note: NOTE }));
    const note = [...document.querySelectorAll("p")].find((p) => p.textContent === NOTE)!;
    expect(note.classList).toContain("text-muted-foreground");
    expect(theButton().hasAttribute("aria-describedby")).toBe(false);
    expect(document.querySelectorAll("[role]")).toHaveLength(0);
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(0);
  });

  it("hands its button to the recorder, to focus", async () => {
    const buttonRef = createRef<HTMLButtonElement>();
    await render(row({ buttonRef }));
    expect(buttonRef.current).toBe(theButton());
  });
});

describe("VoiceOnlyLine", () => {
  it("is light on the stage and muted in the card, with no role", async () => {
    const page = await render(<VoiceOnlyLine id="line" onStage />);
    expect(line()?.id).toBe("line");
    expect(line()?.classList).toContain("text-white/75");
    expect(line()?.classList).not.toContain("text-muted-foreground");
    await page.rerender(<VoiceOnlyLine />);
    expect(line()?.classList).toContain("text-muted-foreground");
    expect(line()?.classList).not.toContain("text-white/75");
    expect(document.querySelectorAll("[role], [aria-live]")).toHaveLength(0);
  });
});

// On a short phone the panel doesn't fit: it scrolls, under a top row that doesn't, so the camera's
// button there is always in view.
describe("CameraStage", () => {
  it("keeps the status and the camera's button in a top row above the panel, which alone scrolls", async () => {
    await render(
      <CameraStage
        stream={new MediaStream()}
        status={<span>Recording your voice</span>}
        control={cameraButton({ on: true, onStage: true })}
      >
        <button type="button">Finish</button>
        <VoiceOnlyLine onStage />
      </CameraStage>,
    );
    const scrolls = (el: Element) => el.closest('[class~="overflow-y-auto"]');
    const pill = [...document.querySelectorAll("span")].find((span) => span.textContent === "Recording your voice")!;
    const row = pill.parentElement!;
    expect(row.contains(button("Turn off my camera"))).toBe(true);
    expect(row.contains(button("Finish"))).toBe(false);
    expect(scrolls(row)).toBeNull();
    expect(row.classList).toContain("shrink-0");
    const panel = scrolls(button("Finish"));
    expect(panel).not.toBeNull();
    expect(panel?.contains(line()!)).toBe(true);
    // The row first, so it sits above the panel; the button at its end (the right).
    expect(row.compareDocumentPosition(panel!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button("Turn off my camera").parentElement?.classList).toContain("ml-auto");
    // Only on a very short screen (zoomed in, or a phone on its side), where the row would leave the
    // panel a sliver, does the whole layer scroll instead, row and all.
    expect(row.parentElement?.classList).toContain("[@media(max-height:30rem)]:overflow-y-auto");
    expect(row.parentElement?.classList).not.toContain("overflow-y-auto");
    expect(panel?.classList).toContain("[@media(max-height:30rem)]:overflow-y-visible");
  });

  it("has an empty top row when there's nothing to show there", async () => {
    await render(
      <CameraStage stream={new MediaStream()}>
        <p>Waiting for your microphone…</p>
      </CameraStage>,
    );
    expect(document.querySelectorAll("button")).toHaveLength(0);
    expect(document.querySelector('[class~="shrink-0"]')?.childElementCount).toBe(0);
  });
});

// The promise members are given before they record, word for word: change it only together with
// what they are told (README's "What members are told", which the onboarding form covers).
describe("VOICE_ONLY_LINE", () => {
  it("says only the voice is recorded, and the picture is never saved or sent", () => {
    expect(VOICE_ONLY_LINE).toBe(
      "Only your voice is recorded. The camera just shows you to yourself; its picture is never saved or sent.",
    );
  });
});
