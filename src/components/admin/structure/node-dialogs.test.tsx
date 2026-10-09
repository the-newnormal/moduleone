// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { TeamRow } from "@/lib/admin/tree";
import { button, choose, click, labelled, render, text } from "@/test/dom";
import type { StructureRow } from "./counts";
import { MoveDialog } from "./node-dialogs";

function node(id: string, name: string, kind: TeamRow["kind"], parent_id: string | null, sort_order: number): StructureRow {
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
  };
}

const ROWS: StructureRow[] = [
  node("gather", "Gather", "division", null, 0),
  node("culture", "Culture", "division", null, 1),
  node("ipLab", "IP Lab", "domain", "gather", 0),
  node("barbeques", "Barbeques", "domain", "gather", 1),
  node("dinners", "Dinners", "domain", "gather", 2),
  node("atlas", "Atlas", "domain", "culture", 0),
  node("flagLab", "Flag Lab", "domain", "culture", 1),
  node("ip1", "IP Lab 1", "team", "ipLab", 0),
  node("ip2", "IP Lab 2", "team", "ipLab", 1),
];
const row = (id: string) => ROWS.find((r) => r.id === id)!;

const renderMove = (id: string, onMove = vi.fn()) =>
  render(<MoveDialog open onOpenChange={() => {}} onCloseAutoFocus={() => {}} rows={ROWS} row={row(id)} onMove={onMove} />);

describe("MoveDialog", () => {
  it("starts on where the node is now, with nothing to move yet", async () => {
    await renderMove("flagLab");
    expect(text(labelled("Put it in"))).toBe("Culture (now)");
    expect(text(labelled("Position"))).toBe("After Atlas (now)");
    expect(button("Move").disabled).toBe(true);
  });

  it("puts the node last in a newly picked parent, and moves it there", async () => {
    const onMove = vi.fn();
    await renderMove("flagLab", onMove);
    await choose(labelled("Put it in"), "gather");
    expect(text(labelled("Position"))).toBe("After Dinners");
    await click(button("Move"));
    expect(onMove).toHaveBeenCalledWith({ teamId: "flagLab", parentId: "gather", index: 3 });
  });

  it("does the same for a team, and goes back to its own place when its parent is picked again", async () => {
    await renderMove("ip1");
    await choose(labelled("Domain"), "barbeques");
    expect(text(labelled("Position"))).toBe("First");
    await choose(labelled("Domain"), "ipLab");
    expect(text(labelled("Position"))).toBe("First (now)");
    expect(button("Move").disabled).toBe(true);
  });
});
