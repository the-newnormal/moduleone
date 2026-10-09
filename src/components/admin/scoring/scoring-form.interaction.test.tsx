// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FORM } from "@/lib/admin/scoring";
import type { ActionResult } from "@/lib/admin/errors";
import { button, click, deferred, labelled, render, settle, text, type } from "@/test/dom";
import { ScoringForm } from "./scoring-form";

const save = vi.fn(async () => ({ ok: true as const, value: null }));
const status = () => text(document.querySelector('form p[role="status"]')!);

describe("ScoringForm's Reset to defaults", () => {
  it("asks for a save when the saved settings differ from the defaults", async () => {
    await render(<ScoringForm saved={{ ...DEFAULT_FORM, morale_1: "0.5" }} save={save} />);
    await click(button("Reset to defaults"));
    expect(status()).toBe("Filled in the defaults. Save to use them.");
    expect(button("Save settings").disabled).toBe(false);
  });

  it("says so when the defaults are what's saved, since there's nothing to save", async () => {
    await render(<ScoringForm saved={{ ...DEFAULT_FORM, morale_1: "0.60" }} save={save} />);
    await click(button("Reset to defaults"));
    expect(status()).toBe("These are the defaults, and they're already saved.");
    expect(button("Save settings").disabled).toBe(true);
  });
});

describe("ScoringForm while saving", () => {
  it("keeps every value read-only until the save finishes, so what's shown is what was saved", async () => {
    const pending = deferred<ActionResult>();
    const slowSave = vi.fn(() => pending.promise);
    await render(<ScoringForm saved={DEFAULT_FORM} save={slowSave} />);
    const green = labelled<HTMLInputElement>("Green at or above");
    await type(green, "13");
    await click(button("Save settings"));

    expect(slowSave).toHaveBeenCalledExactlyOnceWith({ ...DEFAULT_FORM, green_threshold: "13" });
    const inputs = [...document.querySelectorAll<HTMLInputElement>("form input")];
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every((input) => input.disabled)).toBe(true);

    pending.resolve({ ok: true, value: null });
    await settle();
    expect(inputs.every((input) => !input.disabled)).toBe(true);
    expect(status()).toBe("Saved. The heat-map uses these settings now, for past weeks too.");
  });
});
