import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { checkScoringForm, DEFAULT_FORM, type ScoringForm as Form } from "@/lib/admin/scoring";
import { ScoringForm } from "./scoring-form";
import { ScoringPreview } from "./scoring-preview";

const save = vi.fn();
const render = (saved: Partial<Form> = {}) =>
  renderToStaticMarkup(<ScoringForm saved={{ ...DEFAULT_FORM, ...saved }} save={save} />);
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");
const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;

describe("ScoringForm", () => {
  it("shows the 17 values with labels, nothing to save yet, and the preview", () => {
    const html = render();
    expect(count(html, /<input /g)).toBe(17);
    expect(count(html, /<label /g)).toBe(17);
    expect(text(html)).toContain("Activity grade 1");
    expect(text(html)).toContain("Morale grade 5");
    expect(text(html)).toContain("Green at or above");
    expect(html).toMatch(/<button [^>]*type="submit" disabled=""[^>]*>Save settings<\/button>/);
    expect(text(html)).toContain("Reset to defaults");
    expect(count(html, /<table/g)).toBe(5);
    expect(html).not.toContain('aria-invalid="true"');
  });

  it("marks an unusable value and holds the preview back", () => {
    const html = render({ activity_2: "1e3" });
    expect(count(html, /aria-invalid="true"/g)).toBe(1);
    expect(text(html)).toContain("Enter a plain number, like 1.25.");
    expect(html).toMatch(/aria-describedby="[^"]+-activity_2-error"/);
    expect(text(html)).toContain("The preview shows once every value is a number.");
    expect(count(html, /<table/g)).toBe(0);
  });

  it("lists what the database would refuse", () => {
    const html = render({ yellow_threshold: "12" });
    expect(text(html)).toContain("These settings can't be saved yet:");
    expect(text(html)).toContain("The yellow threshold (12) must be below the green one (12).");
  });
});

describe("ScoringPreview", () => {
  const config = (changes: Partial<Form> = {}) => {
    const check = checkScoringForm({ ...DEFAULT_FORM, ...changes });
    if (!check.ok) throw new Error("unusable");
    return check.config;
  };

  it("counts the colours and gives every cell a word as well as a colour", () => {
    const html = renderToStaticMarkup(<ScoringPreview config={config()} />);
    const words = text(html);
    expect(words).toMatch(/35 green.*35 yellow.*55 red/);
    expect(count(html, /<td class/g)).toBe(125);
    expect(count(html, /<span class="sr-only">, (Green|Yellow|Red)<\/span>/g)).toBe(125);
    expect(words).toContain("Morale 1 (weight 0.6)");
    expect(words).toContain("Excellence 5");
    expect(words).toContain("Activity 5");
  });

  it("shows each score with formatScore, so a red 5.96 never reads 6.0", () => {
    const html = renderToStaticMarkup(
      <ScoringPreview config={config({ morale_3: "1.49", morale_4: "1.49", morale_5: "1.5" })} />,
    );
    expect(text(html)).toContain("5.96 , Red");
    expect(text(html)).not.toMatch(/6\.0 , Red/);
  });
});
