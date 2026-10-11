// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildDiary, type Diary, type DiaryRow } from "@/lib/checkin/diary";
import { text } from "@/test/dom";
import { Entries } from "./entries";
import { ThenAndNow } from "./then-and-now";

// The Diary's Then and now tile and its timeline, as the page renders them (page.test.ts covers
// which rows reach them). Every recording has one named player, every state is said in words as
// well as shown, and everything that links or opens is big enough to tap.

const MEMBER = "3e3b0000-0000-4000-8000-000000000003";
const NOW = new Date("2026-10-08T04:00:00Z"); // Thursday noon in Singapore
const WEEK = "2026-10-05";

let n = 0;
function row(week_start: string, fields: Partial<DiaryRow> = {}): DiaryRow {
  n += 1;
  return {
    id: `c1000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    week_start,
    submitted_at: null,
    audio_path: null,
    audio_duration_ms: null,
    audio_keep_days: 90,
    audio_delete_after: null,
    ...fields,
  };
}
const take = (week: string) => `${MEMBER}/${week}-0c6f2a8e-5b1d-4c43-9a51-2f3c1d9e8b7a.webm`;
const recorded = (week: string, deleteAfter: string, keep = 365) =>
  row(week, {
    audio_path: take(week),
    audio_duration_ms: 125_000,
    audio_keep_days: keep,
    audio_delete_after: deleteAfter,
    submitted_at: `${week}T03:00:00Z`,
  });

const THIS_WEEK = recorded(WEEK, "2027-10-07T06:14:30Z");
const ROWS = [
  THIS_WEEK,
  recorded("2026-09-28", "2027-10-01T02:00:00Z"),
  recorded("2026-09-21", "2027-09-24T02:00:00Z"),
  recorded("2026-07-13", "2026-10-12T02:00:00Z", 90),
  row("2026-07-06", { submitted_at: "2026-07-09T03:00:00Z" }), // its recording has gone
  row("2025-12-29", { submitted_at: "2026-01-02T03:00:00Z" }),
  row("2025-12-22"), // never had one
];

const build = (rows: readonly DiaryRow[], cardShowsThisWeek: boolean) =>
  buildDiary(rows, { weekStart: WEEK, cardShowsThisWeek, now: NOW });

// Both sections, as the page lays them out.
function render(diary: Diary | "failed") {
  const tile = diary !== "failed" && diary.thenAndNow && <ThenAndNow {...diary.thenAndNow} />;
  document.body.innerHTML = renderToStaticMarkup(
    <>
      {tile}
      <Entries diary={diary} />
    </>,
  );
}
const entriesSection = () => document.querySelector<HTMLElement>('section[aria-labelledby="entries-title"]')!;
const tile = () => document.querySelector<HTMLElement>('section[aria-labelledby="then-and-now-title"]');
const items = () => [...entriesSection().querySelectorAll("li")];
const item = (week: string) => items().find((li) => text(li.querySelector("h4")!).startsWith(`Week of ${week}`))!;
// Links on the page, not the download link inside each <audio> (for browsers that can't play it).
const links = (el: ParentNode) => [...el.querySelectorAll("a")].filter((a) => !a.closest("audio"));
const dot = (li: Element) => li.querySelector<HTMLElement>(":scope > span[aria-hidden]")!;

describe("the Diary's sections", () => {
  it.each([
    ["before this week's is submitted", false],
    ["once it is, with this week's in the card", true],
  ])("names every player %s, by its week and year", (_label, cardShowsThisWeek) => {
    render(build(ROWS, cardShowsThisWeek));
    const labels = [...document.querySelectorAll("audio")].map((audio) => audio.getAttribute("aria-label"));
    // The card's isn't rendered here; every other playable recording has one player.
    expect(labels).toHaveLength(cardShowsThisWeek ? 3 : 4);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label).toMatch(/^Your recording for the week of \d{1,2} \w+ \d{4}$/);
    expect(labels).toContain("Your recording for the week of 13 July 2026");
  });

  it("shows whether an entry can be played by the dot's shape, and says so in words", () => {
    render(build(ROWS, false));
    const playable = item("21 September");
    expect(dot(playable).className).toContain("bg-foreground");
    expect(dot(playable).className).not.toContain("border");
    expect(playable.querySelector("audio")).not.toBeNull();
    expect(text(playable)).toContain("Kept until 23 September 2027");

    for (const [week, words] of [
      ["6 July", "Recording no longer kept"],
      ["22 December", "No recording to play"],
    ]) {
      const gone = item(week);
      expect(dot(gone).className).toContain("border border-line-strong bg-background");
      expect(dot(gone).className).not.toContain("bg-foreground");
      expect(text(gone)).toContain(words);
      expect(gone.querySelector("audio")).toBeNull();
    }
    for (const li of items()) expect(dot(li).getAttribute("aria-hidden")).toBe("true");
  });

  it("links up to where a recording plays, with targets big enough to tap", () => {
    render(build(ROWS, true));
    // Now is this week's, which plays in the card.
    const now = tile()!.querySelector<HTMLElement>('article[aria-labelledby="then-and-now-now"]')!;
    expect(text(now.querySelector("h3")!)).toBe("Now Week of 5 October 2026");
    expect(now.querySelector("audio")).toBeNull();
    const [up] = links(now);
    expect(up.getAttribute("href")).toBe("#this-week");
    expect(text(up)).toBe("Play it in this week's entry, above");
    // Then plays in the tile; its entry links up to it.
    const then = tile()!.querySelector<HTMLElement>('article[aria-labelledby="then-and-now-then"]')!;
    expect(text(then.querySelector("h3")!)).toBe("Then Week of 13 July 2026");
    expect(text(then)).toContain("2 min 5 s · Kept until 11 October 2026");
    expect(then.querySelector("audio")).not.toBeNull();
    const timeline = links(entriesSection());
    expect(timeline.map((a) => [a.getAttribute("href"), text(a)])).toEqual([
      ["#then-and-now-title", "Play it in Then and now, above"],
    ]);
    expect(text(item("13 July"))).toContain("Play it in Then and now, above");

    const targets = [...links(document), ...document.querySelectorAll("summary")];
    expect(targets.length).toBeGreaterThanOrEqual(3);
    for (const target of targets) expect(target.className).toContain("min-h-10");
  });

  it("keeps each length on one line, and starts Then and now's blocks at the top", () => {
    render(build(ROWS, true));
    // At 320px, "3 min 5 s" broke after the 3.
    const lengths = [...document.querySelectorAll("span.font-mono")].filter((el) => /^\d+ (min|s)/.test(text(el)));
    // Then and Now, and the three entries with a recording under Entries.
    expect(lengths.map((el) => text(el))).toEqual(Array(5).fill("2 min 5 s"));
    for (const el of lengths) expect(el.className).toContain("whitespace-nowrap");
    // Now links up to the card, so its block is shorter than Then's: stretched rows put its lines
    // below Then's when they sit side by side.
    const blocks = [...tile()!.querySelectorAll("article")];
    expect(blocks).toHaveLength(2);
    for (const block of blocks) expect(block.className).toContain("content-start");
  });

  it("links both of Then and now's entries up to the tile before this week's is submitted", () => {
    render(build(ROWS, false));
    const now = tile()!.querySelector<HTMLElement>('article[aria-labelledby="then-and-now-now"]')!;
    expect(now.querySelector("audio")?.getAttribute("aria-label")).toBe("Your recording for the week of 5 October 2026");
    expect(links(entriesSection()).map((a) => a.getAttribute("href"))).toEqual([
      "#then-and-now-title",
      "#then-and-now-title",
    ]);
    expect(text(item("5 October"))).toContain("Play it in Then and now, above");
  });

  it("folds a year with nothing to play, and keeps its heading outside", () => {
    render(build(ROWS, true));
    const year = entriesSection().querySelector<HTMLElement>('section[aria-labelledby="entries-2025"]')!;
    expect(text(year.querySelector("h3")!)).toBe("2025");
    expect(year.querySelector("h3")!.closest("details")).toBeNull();
    const summary = year.querySelector("details > summary")!;
    expect(text(summary)).toBe("2 entries, no recordings to play");
    expect(entriesSection().querySelector('section[aria-labelledby="entries-2026"] details')).toBeNull();
    // The year it was submitted in, when that isn't the week's.
    expect(text(item("29 December"))).toContain("Submitted Friday 2 January 2026");
    expect(item("29 December").querySelector("h4 .sr-only")?.textContent).toBe(" 2025");

    render(build([row("2025-12-22")], false));
    expect(text(entriesSection())).toContain("1 entry, no recording to play");
  });

  it("says what the timeline is for when it is empty", () => {
    for (const rows of [[], [THIS_WEEK]]) {
      render(build(rows, true));
      const [heading, ...rest] = entriesSection().children;
      expect(text(heading)).toBe("Entries");
      expect(rest.map((el) => [el.tagName, text(el)])).toEqual([
        ["P", "Each week you submit a check-in, it becomes an entry here that you can listen back to."],
      ]);
      expect(tile()).toBeNull();
    }
  });

  it("says when the entries couldn't load, and nothing else", () => {
    render("failed");
    const [heading, ...rest] = entriesSection().children;
    expect(text(heading)).toBe("Entries");
    expect(rest.map((el) => [el.getAttribute("role"), text(el)])).toEqual([
      ["alert", "Couldn't load your entries. Refresh the page to try again."],
    ]);
    expect(tile()).toBeNull();
  });

  it("explains 90-day recordings only when one can still be played", () => {
    const NOTE = "Recordings you made under the earlier privacy notice are kept for 90 days, as it said.";
    render(build(ROWS, false));
    expect(text(entriesSection())).toContain(NOTE);
    expect(text(entriesSection())).toContain("Your first entry was the week of 22 December 2025.");
    render(build(ROWS.filter((r) => r.audio_keep_days === 365 || r.audio_path === null), false));
    expect(text(entriesSection())).not.toContain(NOTE);
  });
});
