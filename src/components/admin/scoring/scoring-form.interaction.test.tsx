// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FORM } from "@/lib/admin/scoring";
import { button, click, render, text } from "@/test/dom";
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
