// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { button, render } from "@/test/dom";
import type { SaveOutcome } from "./checkin/take";

// Sign out sits in the app bar on every page, the check-in page included, so it can be pressed
// while a take is still being recorded or saved. It must never end the session before the take is
// saved: the save needs it.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("./actions", () => ({ signOut: vi.fn() }));

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// The modules keep their state for the life of the page, so each test loads fresh copies.
async function load() {
  vi.resetModules();
  const saves = await import("./checkin/pending-save");
  const { signOut } = await import("./actions");
  const { SignOutButton } = await import("./sign-out-button");
  return { ...saves, signOut: vi.mocked(signOut), SignOutButton };
}

// Pressing Sign out: the form's submit, as the button sends it.
const press = () =>
  act(async () => {
    document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

// Sign out sends the form again once the save has settled.
let resent: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resent = vi.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(() => {});
});
afterEach(() => {
  resent.mockRestore();
});

describe("Sign out", () => {
  it("pressed while recording, finishes the recording and waits for its save before signing out", async () => {
    const { SignOutButton, holdRecording, trackSave, signOut } = await load();
    const save = deferred<SaveOutcome | null>();
    const finish = vi.fn(() => void trackSave(save.promise));
    holdRecording(finish);
    await render(<SignOutButton />);

    await press();
    expect(finish).toHaveBeenCalledTimes(1);
    expect(button("Saving your check-in…").disabled).toBe(true);
    expect(signOut).not.toHaveBeenCalled();
    expect(resent).not.toHaveBeenCalled();

    await act(async () => save.resolve({ step: "saved" }));
    expect(resent).toHaveBeenCalledTimes(1); // now nothing is held, so it signs out as usual
  });

  it("signs out at once when nothing is recording or saving", async () => {
    const { SignOutButton, signOut } = await load();
    await render(<SignOutButton />);
    await press();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(resent).not.toHaveBeenCalled();
  });
});
