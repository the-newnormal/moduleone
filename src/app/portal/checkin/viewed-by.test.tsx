import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ViewGroup } from "@/lib/checkin/view-log";
import { NoLongerInDiary, ViewedBy, viewerNames, viewLine } from "./viewed-by";

const person = (name: string, role: ViewGroup["role"] = "Leader"): ViewGroup => ({
  name,
  role,
  lines: [{ kind: "opened", at: "2026-10-09T06:15:00Z", reset: false }],
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
    const jane = person("Jane Tan", "HQ");
    expect(viewLine(jane, { kind: "opened", at: "2026-10-09T06:15:00Z", reset: false }, "2026")).toBe(
      "Jane Tan · HQ — opened your check-in on Friday 9 October at 2:15 pm",
    );
    expect(viewLine(jane, { kind: "played", at: "2026-10-09T06:15:00Z", reset: false }, "2026")).toBe(
      "Jane Tan · HQ — played your recording on Friday 9 October at 2:15 pm",
    );
  });

  it("adds the year when it isn't this one, and marks a check-in since reset", () => {
    expect(viewLine(person("Ali Rahman"), { kind: "opened", at: "2025-12-23T02:00:00Z", reset: true }, "2026")).toBe(
      "Ali Rahman · Leader — opened your check-in on Tuesday 23 December 2025 at 10:00 am (an earlier check-in for this week, since reset)",
    );
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
      role: "HQ",
      lines: [
        { kind: "played", at: "2026-10-09T06:20:00Z", reset: false },
        { kind: "opened", at: "2026-10-09T06:15:00Z", reset: false },
      ],
    };
    const html = renderToStaticMarkup(<ViewedBy groups={[jane]} />);
    expect(html).toMatch(/^<details class="group"><summary[^>]*><span[^>]*>Opened by Jane Tan<\/span>/);
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).not.toMatch(/\b2 (views|times)\b/);
  });
});
