import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ViewGroup, ViewLine } from "@/lib/checkin/view-log";
import { NoLongerInDiary, ViewedBy, viewedByLabel, viewerNames, viewLine } from "./viewed-by";

const line = (fields: Partial<ViewLine> = {}): ViewLine => ({
  name: "Jane Tan",
  role: "Leader",
  kind: "opened",
  at: "2026-10-09T06:15:00Z",
  reset: false,
  ...fields,
});
const person = (name: string, kinds: ViewLine["kind"][] = ["opened"]): ViewGroup => ({
  name,
  lines: kinds.map((kind) => line({ name, kind })),
});

describe("viewerNames", () => {
  it("names up to three people, the most recent first, then says how many more", () => {
    expect(viewerNames([person("Jane Tan")])).toBe("Jane Tan");
    expect(viewerNames([person("Jane Tan"), person("Ali Rahman")])).toBe("Jane Tan and Ali Rahman");
    expect(viewerNames(["Jane Tan", "Ali Rahman", "Wen Li"].map((n) => person(n)))).toBe("Jane Tan, Ali Rahman and Wen Li");
    expect(viewerNames(["Jane Tan", "Ali Rahman", "Wen Li", "Abe Ho"].map((n) => person(n)))).toBe(
      "Jane Tan, Ali Rahman and 2 others",
    );
  });
});

describe("viewLine", () => {
  it("says who, Leader or HQ, what they did and when, in Singapore time", () => {
    expect(viewLine(line({ role: "HQ" }), "2026")).toBe("Jane Tan · HQ — opened your check-in on Friday 9 October at 2:15 pm");
    expect(viewLine(line({ role: "HQ", kind: "played" }), "2026")).toBe(
      "Jane Tan · HQ — played your recording on Friday 9 October at 2:15 pm",
    );
  });

  it("adds the year when it isn't this one, and marks a check-in since reset", () => {
    expect(viewLine(line({ name: "Ali Rahman", at: "2025-12-23T02:00:00Z", reset: true }), "2026")).toBe(
      "Ali Rahman · Leader — opened your check-in on Tuesday 23 December 2025 at 10:00 am (an earlier check-in for this week, since reset)",
    );
  });
});

describe("viewedByLabel", () => {
  it("says opened only when each of them opened it, and played when nobody did", () => {
    expect(viewedByLabel([person("Jane Tan", ["played", "opened"]), person("Ali Rahman")])).toBe("Opened by");
    expect(viewedByLabel([person("Jane Tan", ["played"])])).toBe("Recording played by");
    expect(viewedByLabel([person("Jane Tan", ["played"]), person("Ali Rahman", ["played", "played"])])).toBe(
      "Recording played by",
    );
    expect(viewedByLabel([person("Jane Tan", ["played"]), person("Ali Rahman")])).toBe("Opened or played by");
  });
});

describe("ViewedBy and NoLongerInDiary", () => {
  it("render nothing when nobody has looked, so they never say 'nobody'", () => {
    expect(renderToStaticMarkup(<ViewedBy groups={undefined} />)).toBe("");
    expect(renderToStaticMarkup(<ViewedBy groups={[]} />)).toBe("");
    expect(renderToStaticMarkup(<NoLongerInDiary weeks={[]} />)).toBe("");
  });

  it("fold the lines under a summary that names people, never a count of views", () => {
    const jane: ViewGroup = {
      name: "Jane Tan",
      lines: [line({ role: "HQ", kind: "played", at: "2026-10-09T06:20:00Z" }), line({ role: "HQ" })],
    };
    const html = renderToStaticMarkup(<ViewedBy groups={[jane]} />);
    expect(html).toMatch(/^<details class="group"><summary[^>]*><span[^>]*>Opened by Jane Tan<\/span>/);
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).not.toMatch(/\b2 (views|times)\b/);
  });

  it("never says someone opened a check-in when they only played its recording", () => {
    const html = renderToStaticMarkup(<ViewedBy groups={[person("Jane Tan", ["played"])]} />);
    expect(html).toMatch(/<summary[^>]*><span[^>]*>Recording played by Jane Tan<\/span>/);
    expect(html).not.toContain("Opened");
    expect(html).toContain("Jane Tan · Leader — played your recording");
  });

  it("puts each line under the name and label it was noted with, not the latest", () => {
    const jane: ViewGroup = {
      name: "Jane Lim",
      lines: [
        line({ name: "Jane Lim", role: "HQ", kind: "played", at: "2026-10-09T06:20:00Z" }),
        line({ name: "Jane Tan", role: "Leader", at: "2026-10-06T06:15:00Z" }),
      ],
    };
    const html = renderToStaticMarkup(<ViewedBy groups={[jane]} />);
    expect(html).toContain("Opened by Jane Lim");
    expect(html).toContain("<li>Jane Lim · HQ — played your recording on Friday 9 October at 2:20 pm</li>");
    expect(html).toContain("<li>Jane Tan · Leader — opened your check-in on Tuesday 6 October at 2:15 pm</li>");
  });
});
