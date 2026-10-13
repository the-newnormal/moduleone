import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  buildDiary,
  DIARY_COLUMNS,
  type DiaryEntry,
  type DiaryRow,
  keptUntilDay,
  loadDiaryRows,
  sgtDay,
  type Spot,
} from "./diary";

// The Diary is the member's own page. RLS hands a member their own scores, theme, review and
// transcript (and a leader or hq other people's rows), so the Diary must ask only for its own
// columns of the member's own rows, and drop anything else a row carries.

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const MEMBER = "3e3b0000-0000-4000-8000-000000000003";
// Thursday 8 October 2026, noon in Singapore: the week of Monday 5 October.
const NOW = new Date("2026-10-08T04:00:00Z");
const WEEK = "2026-10-05";

// Anything that would hand a member part of their grade or what they said, or every column at once.
const GRADE_COLUMNS = /\*|score|category|review|transcript|grader|rubric|mention|team/;
const SECRETS = ["SECRET", "wellbeing", "burnt out", "exhausted", "rough"];
const ENTRY_KEYS = ["durationMs", "gone", "id", "keepDays", "keptUntil", "playsIn", "src", "submittedAt", "week"];

// Each row as RLS would hand it back if asked for everything: grades included.
const POISON = {
  activity_score: 4,
  morale_score: 1,
  category: "wellbeing",
  rubric_review: "SECRET REVIEW burnt out",
  transcript: "SECRET TRANSCRIPT rough exhausted",
};

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
    ...POISON,
    ...fields,
  };
}
const take = (week: string, ext = "webm") => `${MEMBER}/${week}-0c6f2a8e-5b1d-4c43-9a51-2f3c1d9e8b7a.${ext}`;

// The weeks the page test uses: this week's, three earlier recordings (one past its deadline), and
// weeks with nothing to play on either side of a new year.
const THIS_WEEK = row(WEEK, {
  audio_path: take(WEEK),
  audio_duration_ms: 192_000,
  audio_keep_days: 365,
  audio_delete_after: "2027-10-07T06:14:30Z",
  submitted_at: "2026-10-07T06:15:00Z",
});
const SEP_28 = row("2026-09-28", {
  audio_path: take("2026-09-28"),
  audio_duration_ms: 220_000,
  audio_keep_days: 365,
  audio_delete_after: "2027-10-01T02:00:00Z",
  submitted_at: "2026-10-01T03:00:00Z",
});
const JUL_20 = row("2026-07-20", {
  audio_path: take("2026-07-20"),
  audio_delete_after: "2026-10-08T10:00:00Z", // today in Singapore
  submitted_at: "2026-07-23T03:00:00Z",
});
const JUL_13 = row("2026-07-13", {
  audio_path: take("2026-07-13", "m4a"),
  audio_duration_ms: 125_000,
  audio_delete_after: "2026-10-12T02:00:00Z",
  submitted_at: "2026-07-17T03:00:00Z",
});
const JUL_06 = row("2026-07-06", { submitted_at: "2026-07-09T03:00:00Z" });
const JAN_05 = row("2026-01-05");
const DEC_29 = row("2025-12-29", { submitted_at: "2026-01-02T03:00:00Z" });
const DEC_22 = row("2025-12-22");
const ROWS = [THIS_WEEK, SEP_28, JUL_20, JUL_13, JUL_06, JAN_05, DEC_29, DEC_22];
// Before this week's check-in: what the page has in the record or draft state.
const EARLIER = ROWS.filter((r) => r !== THIS_WEEK);

const build = (rows: readonly DiaryRow[], cardShowsThisWeek: boolean, now = NOW) =>
  buildDiary(rows, { weekStart: WEEK, cardShowsThisWeek, now });

function allEntries(diary: ReturnType<typeof buildDiary>): DiaryEntry[] {
  return [
    ...(diary.card ? [diary.card] : []),
    ...(diary.thenAndNow ? [diary.thenAndNow.then, diary.thenAndNow.now] : []),
    ...diary.years.flatMap((y) => y.entries),
  ];
}
const byId = (diary: ReturnType<typeof buildDiary>, r: DiaryRow) => allEntries(diary).find((e) => e.id === r.id);
const playsIn = (diary: ReturnType<typeof buildDiary>) =>
  Object.fromEntries(diary.years.flatMap((y) => y.entries).map((e) => [e.week, e.playsIn]));

describe("what the Diary asks for", () => {
  it("reads only its seven columns", () => {
    expect(DIARY_COLUMNS).toBe(
      "id, week_start, submitted_at, audio_path, audio_duration_ms, audio_keep_days, audio_delete_after",
    );
    expect(DIARY_COLUMNS).not.toMatch(GRADE_COLUMNS);
  });

  it("asks for the member's own check-ins, newest first, with no limit", async () => {
    const queries: { table: string; columns: string | null; calls: unknown[][] }[] = [];
    const from = (table: string) => {
      const query = { table, columns: null as string | null, calls: [] as unknown[][] };
      queries.push(query);
      const record =
        (method: string) =>
        (...args: unknown[]) => {
          query.calls.push([method, ...args]);
          return builder;
        };
      const builder = {
        select(columns: string) {
          query.columns = columns;
          return builder;
        },
        eq: record("eq"),
        order: record("order"),
        limit: record("limit"),
        overrideTypes: record("overrideTypes"),
        then: (resolve: (r: unknown) => unknown) => resolve({ data: [], error: null }),
      };
      return builder;
    };
    expect(await loadDiaryRows({ from } as never, MEMBER)).toEqual({ data: [], error: null });
    expect(queries).toEqual([
      {
        table: "checkins",
        columns: DIARY_COLUMNS,
        calls: [["eq", "member_id", MEMBER], ["order", "week_start", { ascending: false }], ["overrideTypes"]],
      },
    ]);
  });

  // Their string literals: the columns and copy they ask for or show. (Comments may name what is
  // left out.)
  const SCANNED = [
    "src/lib/checkin/diary.ts",
    "src/app/portal/checkin/page.tsx",
    "src/app/portal/checkin/then-and-now.tsx",
    "src/app/portal/checkin/entries.tsx",
  ];
  it.each(SCANNED)("%s never names a grade or the transcript in a string", (file) => {
    const source = ts.createSourceFile(file, readFileSync(join(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true);
    const strings: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) strings.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(strings.length).toBeGreaterThan(0);
    for (const text of strings) expect(text).not.toMatch(/transcript|category|rubric_review|_score|grader_/);
  });
});

describe("buildDiary", () => {
  it("keeps only the named fields, whatever else a row carries", () => {
    for (const cardShowsThisWeek of [true, false]) {
      const diary = build(ROWS, cardShowsThisWeek);
      const json = JSON.stringify(diary);
      for (const secret of SECRETS) expect(json).not.toContain(secret);
      expect(json).not.toMatch(/score|category|rubric|transcript/);
      const entries = allEntries(diary);
      expect(entries).toHaveLength(10); // seven or eight listed, Then and now, and the card
      for (const entry of entries) {
        expect(Object.keys(entry).sort()).toEqual(ENTRY_KEYS);
        // The address, never the file's place in Storage.
        expect(entry.src ?? "").not.toContain(MEMBER);
      }
    }
  });

  it("plays a recording through the recording route, with its own extension, until its deadline", () => {
    const diary = build(ROWS, true);
    expect(byId(diary, THIS_WEEK)).toEqual({
      id: THIS_WEEK.id,
      week: WEEK,
      submittedAt: "2026-10-07T06:15:00Z",
      durationMs: 192_000,
      src: `/portal/dashboard/recording/${THIS_WEEK.id}.webm`,
      keptUntil: "2027-10-06",
      keepDays: 365,
      gone: null,
      playsIn: "card",
    });
    expect(byId(diary, JUL_13)).toMatchObject({
      src: `/portal/dashboard/recording/${JUL_13.id}.m4a`,
      keptUntil: "2026-10-11",
      keepDays: 90,
      gone: null,
    });
  });

  it("says whether a recording is no longer kept or there never was one", () => {
    const diary = build(ROWS, false);
    // Its file is still there until the daily job runs, but its deadline is today.
    expect(byId(diary, JUL_20)).toMatchObject({ src: null, keptUntil: null, gone: "no_longer_kept", playsIn: null });
    expect(byId(diary, JUL_06)).toMatchObject({ src: null, keptUntil: null, gone: "no_longer_kept", playsIn: null });
    expect(byId(diary, DEC_29)).toMatchObject({ src: null, gone: "no_longer_kept" });
    expect(byId(diary, JAN_05)).toMatchObject({ src: null, keptUntil: null, gone: "none", playsIn: null });
    expect(byId(diary, DEC_22)).toMatchObject({ src: null, gone: "none" });
  });

  it("gives this week's submitted recording to the card, and lists it nowhere else", () => {
    const diary = build(ROWS, true);
    expect(diary.card?.id).toBe(THIS_WEEK.id);
    expect(diary.card?.playsIn).toBe("card");
    expect(diary.thenAndNow?.then.id).toBe(JUL_13.id);
    expect(diary.thenAndNow?.then.playsIn).toBe("then-and-now");
    // Now is this week's: it plays in the card, and Then and now links up to it.
    expect(diary.thenAndNow?.now).toBe(diary.card);
    expect(diary.years.flatMap((y) => y.entries).map((e) => e.week)).not.toContain(WEEK);
    expect(playsIn(diary)).toEqual({
      "2026-09-28": "entries",
      "2026-07-20": null,
      "2026-07-13": "then-and-now",
      "2026-07-06": null,
      "2026-01-05": null,
      "2025-12-29": null,
      "2025-12-22": null,
    });
  });

  it("before this week's check-in, plays the oldest and the newest in Then and now and the rest in Entries", () => {
    const diary = build(EARLIER, false);
    expect(diary.card).toBeNull();
    expect(diary.thenAndNow?.then.id).toBe(JUL_13.id);
    expect(diary.thenAndNow?.now.id).toBe(SEP_28.id);
    expect(playsIn(diary)).toMatchObject({ "2026-09-28": "then-and-now", "2026-07-13": "then-and-now" });
  });

  // The card doesn't show this week's entry (the unavailable state, say), so it heads its year.
  it("lists this week's entry under its year when the card doesn't show it", () => {
    const diary = build(ROWS, false);
    expect(diary.card).toBeNull();
    expect(diary.years[0].entries[0].id).toBe(THIS_WEEK.id);
    expect(diary.thenAndNow?.now.id).toBe(THIS_WEEK.id);
    expect(playsIn(diary)).toMatchObject({
      [WEEK]: "then-and-now",
      "2026-09-28": "entries",
      "2026-07-13": "then-and-now",
    });
  });

  it("gives every recording one player, in the first place on the page that shows it", () => {
    for (const [rows, cardShowsThisWeek] of [
      [ROWS, true],
      [ROWS, false],
      [EARLIER, false],
    ] as const) {
      const diary = build(rows, cardShowsThisWeek);
      // Where each entry is shown, in page order.
      const shown = new Map<string, Spot[]>();
      const show = (entry: DiaryEntry, spot: Spot) => shown.set(entry.id, [...(shown.get(entry.id) ?? []), spot]);
      if (diary.card) show(diary.card, "card");
      if (diary.thenAndNow) for (const e of [diary.thenAndNow.then, diary.thenAndNow.now]) show(e, "then-and-now");
      for (const e of diary.years.flatMap((y) => y.entries)) show(e, "entries");

      for (const entry of allEntries(diary)) {
        expect(entry.playsIn).toBe(entry.src === null ? null : shown.get(entry.id)?.[0]);
      }
      const playing = new Set(allEntries(diary).flatMap((e) => (e.src === null ? [] : [e.id])));
      expect(playing).toEqual(new Set(rows.filter((r) => [THIS_WEEK, SEP_28, JUL_13].includes(r)).map((r) => r.id)));
    }
  });

  it("has no Then and now with fewer than two recordings to play", () => {
    expect(build([SEP_28, JUL_20, JUL_06], false).thenAndNow).toBeNull();
    expect(build([JUL_06, JAN_05], false).thenAndNow).toBeNull();
    expect(build([], false).thenAndNow).toBeNull();
    // This week's counts.
    expect(build([THIS_WEEK, SEP_28], true).thenAndNow).toMatchObject({
      then: { id: SEP_28.id, playsIn: "then-and-now" },
      now: { id: THIS_WEEK.id, playsIn: "card" },
    });
    const one = build([SEP_28, JUL_06], false);
    expect(one.years[0].entries[0].playsIn).toBe("entries");
  });

  it("groups the rest by the year of its Monday, newest first, folding years with nothing to play", () => {
    const diary = build(ROWS, true);
    expect(diary.years.map((y) => [y.year, y.folded, y.entries.map((e) => e.week)])).toEqual([
      ["2026", false, ["2026-09-28", "2026-07-20", "2026-07-13", "2026-07-06", "2026-01-05"]],
      // The week of 29 December 2025 is 2025's, though it was submitted in 2026.
      ["2025", true, ["2025-12-29", "2025-12-22"]],
    ]);
  });

  it("doesn't rely on the rows' order", () => {
    expect(build([...ROWS].reverse(), true)).toEqual(build(ROWS, true));
  });

  it("names the first entry's week, the card's included", () => {
    expect(build(ROWS, true).firstWeek).toBe("2025-12-22");
    expect(build([THIS_WEEK], true).firstWeek).toBe(WEEK);
    expect(build([], true)).toEqual({ card: null, thenAndNow: null, years: [], firstWeek: null, ninetyDayNote: false });
  });

  it("explains 90-day recordings only when one can still be played", () => {
    expect(build(ROWS, true).ninetyDayNote).toBe(true); // 13 July
    // 20 July is a 90-day one too, but past its deadline.
    expect(build([THIS_WEEK, SEP_28, JUL_20, JUL_06], true).ninetyDayNote).toBe(false);
  });

  it("stops offering a recording from the start of its deadline's Singapore day", () => {
    // 13 July's deadline is 12 October, 10:00 in Singapore, which starts at 16:00 UTC on 11 October.
    const before = build([JUL_13], false, new Date("2026-10-11T15:59:59.999Z"));
    expect(before.years[0].entries[0]).toMatchObject({ keptUntil: "2026-10-11", gone: null, playsIn: "entries" });
    const from = build([JUL_13], false, new Date("2026-10-11T16:00:00Z"));
    expect(from.years[0].entries[0]).toMatchObject({ src: null, keptUntil: null, gone: "no_longer_kept" });
    expect(from.years[0].folded).toBe(true);
  });

  it("plays a recording with no deadline, showing no date", () => {
    const unstamped = row("2026-06-29", { audio_path: take("2026-06-29"), submitted_at: "2026-07-01T03:00:00Z" });
    expect(build([unstamped], false).years[0].entries[0]).toMatchObject({
      src: `/portal/dashboard/recording/${unstamped.id}.webm`,
      keptUntil: null,
      gone: null,
    });
  });

  it("has no card when this week has no row", () => {
    expect(build(EARLIER, true).card).toBeNull();
  });
});

describe("Singapore days", () => {
  it("names the Singapore calendar day of an instant", () => {
    expect(sgtDay("2026-10-07T15:59:59.999Z")).toBe("2026-10-07");
    expect(sgtDay("2026-10-07T16:00:00Z")).toBe("2026-10-08");
    expect(sgtDay(new Date("2026-10-08T04:00:00Z"))).toBe("2026-10-08");
  });

  it("keeps until the day before the deadline's, whatever its time", () => {
    expect(keptUntilDay("2027-10-08T16:00:00Z")).toBe("2027-10-08"); // 9 October, 00:00 in Singapore
    expect(keptUntilDay("2027-10-08T18:00:00Z")).toBe("2027-10-08"); // 02:00
    expect(keptUntilDay("2027-10-09T06:00:00Z")).toBe("2027-10-08"); // 14:00
    expect(keptUntilDay("2027-10-09T15:59:59Z")).toBe("2027-10-08"); // 23:59
  });

  it("crosses a new year in Singapore time", () => {
    expect(keptUntilDay("2026-12-31T16:30:00Z")).toBe("2026-12-31"); // 1 January, 00:30 in Singapore
    expect(keptUntilDay("2026-12-31T15:30:00Z")).toBe("2026-12-30"); // still 31 December
  });

  it("crosses 29 February", () => {
    expect(keptUntilDay("2028-03-01T06:00:00Z")).toBe("2028-02-29");
    // A year (365 days) from 1 March 2027, 14:00 in Singapore, is 29 February 2028: shown as the
    // 28th, a day short of a calendar year, never more.
    expect(keptUntilDay(new Date(Date.parse("2027-03-01T06:00:00Z") + 365 * 86_400_000).toISOString())).toBe(
      "2028-02-28",
    );
  });
});
