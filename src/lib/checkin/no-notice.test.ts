import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// There is no privacy notice in Module One (the product owner's decision, 13 October 2026). Members
// are told how their recordings are used, and agree, on a separate onboarding form outside the app
// (README, "What members are told"), and the app assumes everyone with a login has. The Diary notes
// that assumption for each login (./onboarding-note.ts), and 0013 keeps takes started after it a
// year. This scans every non-test source file under src/ and fails if a notice, its Accept step or a
// gate that waits for an acceptance comes back, or if anything but the note touches
// recording_notices: a second writer could backdate a row and lengthen recordings (CLAUDE.md).

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const NOTE = "src/lib/checkin/onboarding-note.ts";

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST = /\.test\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$|\.probe\./;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return SOURCE.test(entry.name) && !TEST.test(entry.name) ? [relative(ROOT, path).split(sep).join("/")] : [];
  });
}

// Every module specifier in static and dynamic imports, re-exports and require().
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(["'`])([^"'`]+)\1/g;
const NOTICE_MODULE = /\/checkin\/notice(\.[cm]?[jt]sx?)?$|^\.\/notice-form(\.[cm]?[jt]sx?)?$/;
const RECORDING_NOTICES = /\.from\(\s*["'`]recording_notices["'`]/;

describe("no privacy notice in the app", () => {
  const files = sourceFiles(join(ROOT, "src"));
  const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

  it("finds the source files", () => {
    expect(files).toContain(NOTE);
    expect(files).toContain("src/app/portal/checkin/page.tsx");
    expect(files.length).toBeGreaterThan(20);
  });

  it("has no notice module or Accept form", () => {
    expect(existsSync(join(ROOT, "src/lib/checkin/notice.ts"))).toBe(false);
    expect(existsSync(join(ROOT, "src/app/portal/checkin/notice-form.tsx"))).toBe(false);
  });

  it("imports no notice module", () => {
    const offenders = files.filter((file) =>
      [...read(file).matchAll(SPECIFIER)].some(([, , spec]) => NOTICE_MODULE.test(spec)),
    );
    expect(offenders).toEqual([]);
  });

  it("asks nobody to accept a notice, and refuses nothing for want of one", () => {
    const offenders = files.filter((file) => /I understand, continue|notice_required/.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it("touches recording_notices only through the Diary's onboarding note", () => {
    const offenders = files.filter((file) => file !== NOTE && RECORDING_NOTICES.test(read(file)));
    expect(offenders).toEqual([]);
    expect(read(NOTE)).toMatch(RECORDING_NOTICES);
  });
});

describe("the scan's patterns", () => {
  it.each([
    'import { noticeSections } from "@/lib/checkin/notice";',
    "import { noticeVersion } from '../../lib/checkin/notice.ts';",
    'import { NoticeForm } from "./notice-form";',
    'const { acceptNotice } = await import("@/lib/checkin/notice");',
  ])("catches %j", (source) => {
    expect([...source.matchAll(SPECIFIER)].some(([, , spec]) => NOTICE_MODULE.test(spec))).toBe(true);
  });

  it.each([
    'import { noteOnboardingForm } from "@/lib/checkin/onboarding-note";',
    'import { thing } from "@/lib/checkin/notices";',
    'import { thing } from "@/components/notice-board";',
  ])("ignores %j", (source) => {
    expect([...source.matchAll(SPECIFIER)].some(([, , spec]) => NOTICE_MODULE.test(spec))).toBe(false);
  });

  it.each([
    'admin.from("recording_notices").upsert(row)',
    "supabase.from('recording_notices').select('*')",
    "supabase\n  .from(\n    `recording_notices`\n  )",
  ])("sees %j touch recording_notices", (source) => {
    expect(RECORDING_NOTICES.test(source)).toBe(true);
  });
});
