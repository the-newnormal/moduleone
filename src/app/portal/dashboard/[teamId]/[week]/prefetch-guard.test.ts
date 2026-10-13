import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Opening a team's week notes, in each listed person's Diary, that the viewer opened their check-in
// (0015). That note must be made exactly when the page is rendered for someone, never ahead of time:
// a prefetch, a cached render or a render after the response would note views nobody made, or hand
// content over unnoted. Next renders a dynamic page like this one only on a real navigation today,
// but that rests on Next's internals; these checks keep the things that would change it out.

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const PAGE = join(SRC, "app/portal/dashboard/[teamId]/[week]/page.tsx");

// Every source file under src, tests left out (they may spell out what they look for).
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

// The code without its comments (which may well say what never to do).
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
// A "use cache" directive, in any of its forms ("use cache: private", …).
const USE_CACHE = /["']use cache\b/;

const FILES = sources(SRC).map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, "utf8") }));

describe("the drill-in is never prefetched or cached", () => {
  it("runs with no partial prerendering or cache components", () => {
    const config = readFileSync(join(ROOT, "next.config.ts"), "utf8");
    for (const flag of ["cacheComponents", "ppr", "dynamicIO"]) expect(config, flag).not.toMatch(new RegExp(`\\b${flag}\\b`));
  });

  it("is never prefetched on purpose from anywhere", () => {
    const offenders = FILES.filter(({ text }) => /router\.prefetch\(|prefetch=\{\s*true\s*\}/.test(text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("turns prefetching off on every link into it", () => {
    let links = 0;
    for (const { path, text } of FILES) {
      // Each <Link …>…, up to the next one: its attributes come first.
      for (const chunk of text.split(/<Link\b/).slice(1)) {
        const tag = chunk.split(/<\/Link>/)[0];
        if (!/href=\{[^}]*?(drillIn\(|\/portal\/dashboard\/\$\{)/.test(tag)) continue;
        links += 1;
        expect(tag, `a link into the drill-in in ${path}`).toMatch(/prefetch=\{false\}/);
      }
    }
    // The org chart's boxes and bars, the trend grid's cells, and the portal's two tiles.
    expect(links).toBeGreaterThanOrEqual(5);
  });

  it("notes the views inline, while rendering, and is never cached", () => {
    const page = code(readFileSync(PAGE, "utf8"));
    expect(page).toMatch(/await logCheckinViews\(supabase, checkins\.map\(\(c\) => c\.id\), "opened"\);/);
    expect(page).not.toMatch(USE_CACHE);
    expect(page).not.toMatch(/\bafter\s*\(/);
    // Before the page returns anything.
    expect(page.indexOf("await logCheckinViews(")).toBeLessThan(page.indexOf("  return (\n    <main"));
    for (const path of ["src/lib/checkin/view-log.ts", "src/lib/dashboard/load.ts"]) {
      expect(code(readFileSync(join(ROOT, path), "utf8")), path).not.toMatch(USE_CACHE);
    }
  });
});
