import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TeamRow } from "@/lib/admin/tree";
import type { StructureRow } from "./counts";
import { StructureEditor } from "./structure-editor";

function node(
  id: string,
  name: string,
  kind: TeamRow["kind"],
  parent_id: string | null,
  sort_order: number,
  extra: Partial<StructureRow> = {},
): StructureRow {
  return {
    id,
    name,
    parent_id,
    kind,
    domain_type: null,
    division_type: null,
    code: null,
    sort_order,
    note: null,
    archived_at: null,
    members: 0,
    leads: 0,
    ...extra,
  };
}

const ROWS: StructureRow[] = [
  node("d-gather", "Gather", "division", null, 0, { division_type: "strategy" }),
  node("d-culture", "Culture", "division", null, 1, { note: "The three work as a cycle." }),
  node("d-hq", "HQ", "division", null, 2, { division_type: "support_development" }),
  node("legacy", "Legacy", "domain", null, 3, { members: 1 }),
  node("ip-x", "IP Lab", "domain", "d-gather", 0, { domain_type: "lab", code: "IP.X" }),
  node("ip-1", "IP Lab 1", "team", "ip-x", 0, { code: "IP.1", members: 2, leads: 1 }),
  node("ip-2", "IP Lab 2", "team", "ip-x", 1, { code: "IP.2", leads: 1 }),
  node("bq-x", "Barbeques", "domain", "d-gather", 1, { domain_type: "ip", code: "BQ.X" }),
  node("at-x", "Atlas", "domain", "d-culture", 0, { domain_type: "development", members: 1 }),
  node("old", "Old Lab", "domain", "d-gather", 2, { archived_at: "2026-10-01T02:00:00Z", code: "OL.X" }),
  node("old-1", "Old Lab 1", "team", "old", 0, { archived_at: "2026-10-02T02:00:00Z" }),
];

const fail = vi.fn(async () => ({ ok: false as const, error: "no" }));
const ACTIONS = { moveNode: fail, createNode: fail, updateNode: fail, archiveNode: fail, restoreNode: fail };

const render = (rows = ROWS) => renderToStaticMarkup(<StructureEditor rows={rows} actions={ACTIONS} />);
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");
const all = (html: string, pattern: RegExp) => [...html.matchAll(pattern)].map((m) => m[1]);

describe("StructureEditor", () => {
  const html = render();

  it("shows each division as a section, in order, with its domains and their teams", () => {
    expect(all(html, /<h2 id="division-[^"]+"[^>]*><a [^>]*>([^<]+)<\/a><\/h2>/g)).toEqual(["Gather", "Culture", "HQ"]);
    expect(all(html, /<h3[^>]*><a [^>]*>([^<]+)<\/a><\/h3>/g)).toEqual(["IP Lab", "Barbeques", "Atlas", "Legacy"]);
    expect(all(html, /<ul aria-label="([^"]+)"/g)).toEqual([
      "Domains in Gather",
      "Teams in IP Lab",
      "Domains in Culture",
      "Unplaced domains",
    ]);
    const words = text(html);
    expect(words.indexOf("IP Lab 1")).toBeLessThan(words.indexOf("IP Lab 2"));
    expect(words.indexOf("IP Lab 2")).toBeLessThan(words.indexOf("Barbeques"));
    expect(words).toContain("No domains yet.");
  });

  it("links divisions, domains and teams to their team page (people can sit in a division since 0005)", () => {
    expect(all(html, /<a [^>]*href="([^"]+)"/g)).toEqual([
      "/admin/teams/d-gather",
      "/admin/teams/ip-x",
      "/admin/teams/ip-1",
      "/admin/teams/ip-2",
      "/admin/teams/bq-x",
      "/admin/teams/d-culture",
      "/admin/teams/at-x",
      "/admin/teams/d-hq",
      "/admin/teams/legacy",
    ]);
  });

  it("gives every active row a drag handle, Move to… and a menu", () => {
    const active = ROWS.filter((r) => r.archived_at === null);
    expect(all(html, /data-node-move="([^"]+)"/g).sort()).toEqual(active.map((r) => r.id).sort());
    expect(all(html, /data-node-menu="([^"]+)"/g).sort()).toEqual(active.map((r) => r.id).sort());
    expect(all(html, /aria-label="(Drag [^"]+)"/g)).toEqual([
      "Drag division Gather",
      "Drag domain IP Lab",
      "Drag team IP Lab 1",
      "Drag team IP Lab 2",
      "Drag domain Barbeques",
      "Drag division Culture",
      "Drag domain Atlas",
      "Drag division HQ",
      "Drag domain Legacy",
    ]);
    // dnd-kit's instructions for keyboard and screen-reader users are attached to each handle.
    expect(html).toMatch(/aria-roledescription="sortable" aria-describedby="[^"]+" aria-label="Drag domain Atlas"/);
    expect(text(html)).toContain("Atlas: Move to…");
  });

  it("shows codes, type badges, counts and notes", () => {
    const words = text(html);
    expect(words).toContain("IP Lab IP.X Lab 0 people");
    expect(words).toContain("IP Lab 1 IP.1 2 people · 1 lead");
    expect(words).toContain("IP Lab 2 IP.2 0 people · 1 lead");
    expect(words).toContain("Atlas Development domain 1 person");
    expect(words).toContain("Gather Strategy division");
    expect(words).toContain("HQ Support and development division");
    expect(words).toContain("The three work as a cycle.");
  });

  it("lists archived nodes apart, collapsed, with where they were and Restore", () => {
    expect(html).toMatch(/<details[^>]*><summary id="archived-summary"/);
    expect(html).not.toMatch(/<details[^>]* open/);
    const archived = text(html.slice(html.indexOf("<details")));
    expect(archived).toContain("Archived (2)");
    expect(archived).toContain("Old Lab OL.X Domain Was in Gather. Archived 1 Oct 2026.");
    expect(archived).toContain("Old Lab 1 Team Was in Gather › Old Lab (archived). Archived 2 Oct 2026.");
    expect(all(html, /Restore<span class="sr-only"> ([^<]+)<\/span>/g)).toEqual(["Old Lab", "Old Lab 1"]);
    // Archived nodes aren't in the tree.
    expect(all(html, /data-node-move="(old[^"]*)"/g)).toEqual([]);
  });

  it("offers adding a division and an unplaced domain", () => {
    expect(html).toMatch(/<button [^>]*data-add="division"[^>]*>.*Add a division<\/button>/);
    expect(html).toMatch(/<button [^>]*data-add="unplaced"[^>]*>.*Add a domain<\/button>/);
  });

  it("never shows a role", () => {
    expect(text(html)).not.toMatch(/\bhq\b|Master Admin/);
  });

  it("says when there's nothing yet", () => {
    const empty = text(render([]));
    expect(empty).toContain("No divisions yet.");
    expect(empty).toContain("Unplaced");
    expect(empty).toContain("None.");
    expect(empty).toContain("Archived (0)");
    expect(empty).toContain("Nothing is archived.");
  });

  it("lists nodes the tree can't place instead of losing them", () => {
    const stray = text(render([...ROWS, node("lost", "Lost Team", "team", "d-gather", 9)]));
    expect(stray).toContain("Not in the tree");
    expect(stray).toContain("Lost Team");
  });
});
