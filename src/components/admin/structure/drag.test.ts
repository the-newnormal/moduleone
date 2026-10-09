import type { Active, ClientRect, DroppableContainer, DroppableContainers, Over, SensorContext } from "@dnd-kit/core";
import { verticalListSortingStrategy } from "@dnd-kit/sortable";
import { describe, expect, it } from "vitest";
import type { TeamRow } from "@/lib/admin/tree";
import {
  accepts,
  collisionDetection,
  containerOffered,
  dragKind,
  type DropData,
  intoData,
  intoId,
  anchorOf,
  keyboardCoordinates,
  keyboardPlaces,
  keyboardSensorOptions,
  listStrategy,
  moveFor,
  nodeData,
  nodeTakesDrops,
  placeOf,
  structureAnnouncements,
  targetOf,
} from "./drag";

function node(id: string, kind: TeamRow["kind"], parent_id: string | null, sort_order: number, extra: Partial<TeamRow> = {}): TeamRow {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    parent_id,
    kind,
    domain_type: null,
    division_type: null,
    code: null,
    sort_order,
    note: null,
    leader_title: null,
    archived_at: null,
    ...extra,
  };
}

const ROWS: TeamRow[] = [
  node("gather", "division", null, 0),
  node("culture", "division", null, 1),
  node("legacy", "domain", null, 2),
  node("ipLab", "domain", "gather", 0, { name: "IP Lab" }),
  node("barbeques", "domain", "gather", 1),
  node("atlas", "domain", "culture", 0),
  node("flagLab", "domain", "culture", 1, { name: "Flag Lab" }),
  node("ip1", "team", "ipLab", 0, { name: "IP Lab 1" }),
  node("ip2", "team", "ipLab", 1, { name: "IP Lab 2" }),
  node("gone", "domain", "culture", 2, { archived_at: "2026-09-01T00:00:00Z" }),
];
const row = (id: string) => ROWS.find((r) => r.id === id)!;

const rect = (top: number, height: number, left = 0, width = 600): ClientRect => ({
  top,
  left,
  width,
  height,
  bottom: top + height,
  right: left + width,
});

// The page as dnd-kit measures it: Gather (a division holding IP Lab, with two teams, and
// Barbeques), then the Unplaced section.
const PLACES: [id: string, data: DropData, at: ClientRect][] = [
  ["gather", nodeData(row("gather")), rect(0, 300)],
  [intoId("gather"), intoData("domain", "gather"), rect(0, 300)],
  ["ipLab", nodeData(row("ipLab")), rect(50, 130, 16, 560)],
  [intoId("ipLab"), intoData("team", "ipLab"), rect(50, 130, 16, 560)],
  ["ip1", nodeData(row("ip1")), rect(100, 40, 40, 500)],
  ["ip2", nodeData(row("ip2")), rect(140, 40, 40, 500)],
  ["barbeques", nodeData(row("barbeques")), rect(180, 40, 16, 560)],
  [intoId("barbeques"), intoData("team", "barbeques"), rect(180, 40, 16, 560)],
  [intoId(null), intoData("domain", null), rect(400, 100)],
];

const containers: DroppableContainer[] = PLACES.map(([id, data]) => ({
  id,
  key: id,
  data: { current: data },
  disabled: false,
  node: { current: null },
  rect: { current: null },
}));
const droppableRects = new Map(PLACES.map(([id, , at]) => [id, at]));

const activeFor = (id: string): Active => ({
  id,
  data: { current: nodeData(row(id)) },
  rect: { current: { initial: null, translated: null } },
});

const collide = (activeId: string, pointer: { x: number; y: number } | null, collisionRect = rect(2000, 30)) =>
  collisionDetection({
    active: activeFor(activeId),
    collisionRect,
    droppableRects,
    droppableContainers: containers,
    pointerCoordinates: pointer,
  }).map((c) => c.id);

const overOn = (id: string | null): Over | null => {
  if (id === null) return null;
  const place = PLACES.find(([placeId]) => placeId === id)!;
  return { id, rect: place[2], disabled: false, data: { current: place[1] } };
};

describe("collisionDetection", () => {
  it("offers a dragged team the team under the pointer before the domain around it", () => {
    expect(collide("ip1", { x: 100, y: 150 })).toEqual(["ip2", intoId("ipLab")]);
  });

  it("offers a dragged team a domain's header as 'put it last there'", () => {
    expect(collide("ip1", { x: 100, y: 190 })).toEqual([intoId("barbeques")]);
  });

  it("never offers a team a division, nor anything else of the wrong kind", () => {
    expect(collide("ip1", { x: 100, y: 20 })).toEqual([]);
    expect(collide("ip1", { x: 100, y: 450 })).toEqual([]);
  });

  it("offers a dragged domain other domains and the lists that take domains, not teams", () => {
    expect(collide("barbeques", { x: 100, y: 150 })).toEqual(["ipLab", intoId("gather")]);
    expect(collide("barbeques", { x: 100, y: 450 })).toEqual([intoId(null)]);
  });

  it("offers a dragged division only divisions", () => {
    expect(collide("culture", { x: 100, y: 150 })).toEqual(["gather"]);
    expect(collide("culture", { x: 100, y: 450 })).toEqual([]);
  });

  it("falls back to what the dragged item overlaps when the pointer is over nothing it can take", () => {
    expect(collide("ip1", { x: 590, y: 20 }, rect(185, 30, 20, 200))).toEqual([intoId("barbeques")]);
  });

  it("puts a node under the pointer before the container around it, whichever is nearer", () => {
    // pointerWithin ranks this small container first; the node still wins.
    const rects = new Map(droppableRects);
    rects.set(intoId("ipLab"), rect(140, 20, 90, 20));
    rects.set("ip2", rect(100, 200, 0, 600));
    const ids = collisionDetection({
      active: activeFor("ip1"),
      collisionRect: rect(2000, 30),
      droppableRects: rects,
      droppableContainers: containers,
      pointerCoordinates: { x: 100, y: 150 },
    }).map((c) => c.id);
    expect(ids).toEqual(["ip2", intoId("ipLab")]);
  });

  it("uses the place the keyboard put the item on, which has no pointer", () => {
    expect(collide("ip1", null, rect(140, 40, 40, 500))[0]).toBe("ip2");
    // "Last in Barbeques" is found by Barbeques's bottom-left corner (anchorOf).
    expect(collide("ip2", null, rect(220, 40, 16, 560))[0]).toBe(intoId("barbeques"));
    expect(collide("atlas", null, rect(300, 40, 0, 200))[0]).toBe(intoId("gather"));
  });

  it("leaves a tall node where it is when it's picked up with the keyboard and put down at once", () => {
    // Gather is short and Culture tall; the dragged item is a small chip on Culture's top-left
    // corner. By whole rectangles Gather would be closer, and the drop would move Culture up.
    const tall: [string, DropData, ClientRect][] = [
      ["gather", nodeData(row("gather")), rect(0, 300)],
      ["culture", nodeData(row("culture")), rect(320, 500)],
    ];
    const chip = rect(320, 40, 0, 200);
    const over = collisionDetection({
      active: activeFor("culture"),
      collisionRect: chip,
      droppableRects: new Map(tall.map(([id, , at]) => [id, at])),
      droppableContainers: tall.map(([id, data]) => ({ ...containers[0], id, key: id, data: { current: data } })),
      pointerCoordinates: null,
    })[0];
    expect(over.id).toBe("culture");
    expect(moveFor(ROWS, { id: "culture" }, { id: over.id, rect: chip, disabled: false, data: { current: nodeData(row("culture")) } })).toBeNull();
  });

  it("offers nothing for something that isn't a node", () => {
    const active = { ...activeFor("ip1"), data: { current: { kind: "region" } } };
    expect(
      collisionDetection({
        active,
        collisionRect: rect(100, 40),
        droppableRects,
        droppableContainers: containers,
        pointerCoordinates: { x: 100, y: 110 },
      }),
    ).toEqual([]);
  });
});

describe("keyboardPlaces", () => {
  it("lists a division's places: the divisions, its own row among them", () => {
    expect(keyboardPlaces(ROWS, "culture")).toEqual(["gather", "culture"]);
  });

  it("lists a domain's places in page order, each division's own list ending with 'last there'", () => {
    expect(keyboardPlaces(ROWS, "atlas")).toEqual([
      "ipLab",
      "barbeques",
      intoId("gather"),
      "atlas",
      "flagLab", // the last place in Culture, its own division: no separate "last" place
      "legacy",
      intoId(null),
    ]);
    expect(keyboardPlaces(ROWS, "legacy")).toEqual([
      "ipLab",
      "barbeques",
      intoId("gather"),
      "atlas",
      "flagLab",
      intoId("culture"),
      "legacy",
    ]);
  });

  it("lists a team's places: every domain's teams, then the domain", () => {
    expect(keyboardPlaces(ROWS, "ip2")).toEqual([
      "ip1",
      "ip2",
      intoId("barbeques"),
      intoId("atlas"),
      intoId("flagLab"),
      intoId("legacy"),
    ]);
  });

  it("gives every place a different move, so each arrow key moves one position", () => {
    // What dropping on a place means, whatever kind it takes (moveFor only reads the target).
    const overFor = (place: string): Over => ({
      id: place,
      rect: rect(0, 0),
      disabled: false,
      data: {
        current: place.startsWith("into:")
          ? intoData("domain", place === intoId(null) ? null : place.slice("into:".length))
          : nodeData(row(place)),
      },
    });
    for (const id of ["gather", "culture", "atlas", "legacy", "ipLab", "ip1", "ip2"]) {
      const moves = keyboardPlaces(ROWS, id).map((place) => JSON.stringify(moveFor(ROWS, { id }, overFor(place))));
      expect(moves.filter((m) => m === "null")).toHaveLength(1); // its own row: stay
      expect(new Set(moves).size).toBe(moves.length);
    }
  });

  it("lists nothing for an unknown or archived node", () => {
    expect(keyboardPlaces(ROWS, "nope")).toEqual([]);
    expect(keyboardPlaces(ROWS, "gone")).toEqual([]);
  });
});

describe("keyboardCoordinates", () => {
  const getter = keyboardCoordinates(ROWS);
  const droppables = new Map(
    PLACES.map(([id, data, at]) => [id, { id, key: id, data: { current: data }, disabled: false, node: { current: null }, rect: { current: at } }]),
  ) as unknown as DroppableContainers;
  const press = (code: string, active: string, over: string | null, options: { disabled?: string } = {}) => {
    const event = {
      code,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    const context = {
      droppableRects,
      droppableContainers: new Map(
        [...droppables].map(([id, c]) => [id, { ...c, disabled: id === options.disabled }]),
      ) as unknown as DroppableContainers,
      over: over === null ? null : overOn(over),
    } as unknown as SensorContext;
    const at = getter(event as unknown as KeyboardEvent, { active, currentCoordinates: { x: 0, y: 0 }, context });
    return { at, prevented: event.defaultPrevented };
  };

  it("moves the item's top-left corner onto the next or previous place", () => {
    // ip1's places: ip1, ip2, Barbeques (last there, so its bottom-left corner). From ip1 itself:
    expect(press("ArrowDown", "ip1", "ip1")).toEqual({ at: { x: 40, y: 140 }, prevented: true });
    expect(press("ArrowDown", "ip1", "ip2").at).toEqual({ x: 16, y: 220 });
    expect(press("ArrowUp", "ip1", intoId("barbeques")).at).toEqual({ x: 40, y: 140 });
  });

  it("puts 'last there' below the container's last row, so Down never moves the item up", () => {
    // Atlas (in Culture) going Down through Gather: IP Lab, Barbeques, then last in Gather.
    // Gather's top-left corner is above Barbeques: Down to it would be a move up, which dnd-kit's
    // keyboard sensor turns into scrolling the page up (on a phone, back to Gather's first place).
    const last = press("ArrowDown", "atlas", "barbeques").at!;
    expect(last).toEqual({ x: 0, y: 300 });
    expect(last.y).toBeGreaterThan(droppableRects.get("barbeques")!.bottom);
    expect(press("ArrowUp", "atlas", intoId("gather")).at).toEqual({ x: 16, y: 180 });
  });

  it("walks Down through every place in page order, each one lower on the page than the last", () => {
    // What the sensor does with each key: put the item's corner where the getter says, then find
    // the place it's on (collisionDetection, with no pointer). Then the next key, from there.
    const walk = (id: string) => {
      const steps: { over: string; y: number }[] = [];
      let over: string | null = null;
      for (let at = press("ArrowDown", id, over).at; at; at = press("ArrowDown", id, over).at) {
        over = String(collide(id, null, rect(at.y, 30, at.x, 200))[0]);
        steps.push({ over, y: at.y });
        if (steps.length > 20) break;
      }
      for (let i = 1; i < steps.length; i++) expect(steps[i].y).toBeGreaterThan(steps[i - 1].y);
      return steps.map((s) => s.over);
    };
    // Only these places are measured here (see PLACES).
    expect(walk("atlas")).toEqual(["ipLab", "barbeques", intoId("gather"), intoId(null)]);
    expect(walk("legacy")).toEqual(["ipLab", "barbeques", intoId("gather")]);
    expect(walk("ip1")).toEqual(["ip2", intoId("barbeques")]);
  });

  it("scrolls the page at once, not smoothly, so the next key starts from the place just chosen", () => {
    const options = keyboardSensorOptions(ROWS);
    expect(options.scrollBehavior).toBe("auto");
    expect(options.coordinateGetter).toBeTypeOf("function");
  });

  it("anchors a node at its top-left corner and a container at its bottom-left corner", () => {
    expect(anchorOf("ip1", rect(100, 40, 40, 500))).toEqual({ x: 40, y: 100 });
    expect(anchorOf(intoId("ipLab"), rect(50, 130, 16, 560))).toEqual({ x: 16, y: 180 });
    expect(anchorOf(intoId(null), rect(400, 100))).toEqual({ x: 0, y: 500 });
  });

  it("starts from the item's own row when it isn't over a place yet", () => {
    expect(press("ArrowDown", "ip1", null).at).toEqual({ x: 40, y: 140 });
  });

  it("stays put at either end", () => {
    expect(press("ArrowUp", "ip1", "ip1").at).toBeUndefined();
    expect(press("ArrowDown", "ip1", intoId("barbeques")).at).toBeUndefined();
  });

  it("skips places that aren't offered or aren't on the page", () => {
    expect(press("ArrowDown", "ip1", "ip1", { disabled: "ip2" }).at).toEqual({ x: 16, y: 220 });
    // Barbeques's places run on to Culture's rows and Unplaced; only Unplaced is measured here.
    expect(press("ArrowDown", "barbeques", "barbeques").at).toEqual({ x: 0, y: 500 });
  });

  it("does nothing for left, right and other keys", () => {
    expect(press("ArrowLeft", "ip1", "ip1")).toEqual({ at: undefined, prevented: true });
    expect(press("KeyA", "ip1", "ip1")).toEqual({ at: undefined, prevented: false });
  });
});

describe("listStrategy", () => {
  const rects = [rect(0, 40), rect(40, 40), rect(80, 40)];

  it("shifts nothing when the pointer is over another list", () => {
    for (const index of [0, 1, 2]) {
      expect(listStrategy({ activeIndex: 2, activeNodeRect: rects[2], index, rects, overIndex: -1 })).toBeNull();
    }
  });

  it("sorts like verticalListSortingStrategy within the list", () => {
    for (const index of [0, 1, 2]) {
      const args = { activeIndex: 2, activeNodeRect: rects[2], index, rects, overIndex: 0 };
      expect(listStrategy(args)).toEqual(verticalListSortingStrategy(args));
    }
    expect(listStrategy({ activeIndex: 2, activeNodeRect: rects[2], index: 0, rects, overIndex: 0 })).toMatchObject({ y: 40 });
  });
});

describe("what's offered while dragging", () => {
  it("lets a row take drops only from its own kind while something is dragged", () => {
    expect(nodeTakesDrops(null, "team")).toBe(true);
    expect(nodeTakesDrops({ kind: "team", parentId: "ipLab" }, "team")).toBe(true);
    expect(nodeTakesDrops({ kind: "team", parentId: "ipLab" }, "domain")).toBe(false);
    expect(nodeTakesDrops({ kind: "domain", parentId: "gather" }, "division")).toBe(false);
  });

  it("offers a container only to the kind it takes, and not to the dragged node's own parent", () => {
    expect(containerOffered(null, "gather", "domain")).toBe(false);
    expect(containerOffered({ kind: "domain", parentId: "culture" }, "gather", "domain")).toBe(true);
    expect(containerOffered({ kind: "domain", parentId: "gather" }, "gather", "domain")).toBe(false);
    expect(containerOffered({ kind: "domain", parentId: "gather" }, null, "domain")).toBe(true);
    expect(containerOffered({ kind: "team", parentId: "ipLab" }, "gather", "domain")).toBe(false);
    expect(containerOffered({ kind: "division", parentId: null }, null, "domain")).toBe(false);
  });
});

describe("drag data", () => {
  it("reads the dragged kind and the drop target", () => {
    expect(dragKind(activeFor("atlas"))).toBe("domain");
    expect(dragKind(null)).toBeNull();
    expect(dragKind({ data: { current: { kind: "hq" } } })).toBeNull();
    expect(targetOf(overOn("ip2"))).toEqual({ type: "onto", id: "ip2" });
    expect(targetOf(overOn(intoId(null)))).toEqual({ type: "into", parentId: null });
    expect(targetOf(null)).toBeNull();
    expect(targetOf({ data: { current: { target: { type: "into", parentId: 3 } } } })).toBeNull();
    expect(targetOf({ data: { current: undefined } })).toBeNull();
  });

  it("says which kind each place takes", () => {
    expect(accepts(overOn(intoId("ipLab")), "team")).toBe(true);
    expect(accepts(overOn(intoId("ipLab")), "domain")).toBe(false);
    expect(accepts(overOn("ipLab"), "domain")).toBe(true);
    expect(accepts(overOn("ipLab"), null)).toBe(false);
  });

  it("turns a drop into admin_move_team's arguments", () => {
    expect(moveFor(ROWS, { id: "ip2" }, overOn(intoId("barbeques")))).toEqual({ teamId: "ip2", parentId: "barbeques", index: 0 });
    expect(moveFor(ROWS, { id: "ip2" }, overOn("ip1"))).toEqual({ teamId: "ip2", parentId: "ipLab", index: 0 });
    expect(moveFor(ROWS, { id: "ip2" }, overOn("ip2"))).toBeNull();
    expect(moveFor(ROWS, { id: "ip2" }, null)).toBeNull();
  });
});

describe("placeOf", () => {
  it("names the parent and counts among the nodes shown with it", () => {
    expect(placeOf(ROWS, "flagLab")).toEqual({ name: "Culture", position: 2, of: 2 });
    expect(placeOf(ROWS, "culture")).toEqual({ name: "the top level", position: 2, of: 2 });
    expect(placeOf(ROWS, "legacy")).toEqual({ name: "Unplaced", position: 1, of: 1 });
    expect(placeOf(ROWS, "gone")).toBeNull();
    expect(placeOf(ROWS, "nope")).toBeNull();
  });
});

describe("structureAnnouncements", () => {
  const say = structureAnnouncements(ROWS);
  const active = activeFor("atlas");

  it("says what was picked up and where it is", () => {
    expect(say.onDragStart({ active })).toBe("Picked up domain Atlas, in Culture, position 1 of 2.");
    expect(say.onDragStart({ active: activeFor("gather") })).toBe(
      "Picked up division Gather, at the top level, position 1 of 2.",
    );
    expect(say.onDragStart({ active: activeFor("legacy") })).toBe("Picked up domain Legacy, in Unplaced, position 1 of 1.");
  });

  it("says where it would go while dragging", () => {
    expect(say.onDragOver({ active, over: overOn(intoId("gather")) })).toBe("Atlas would move to Gather, position 3 of 3.");
    expect(say.onDragOver({ active, over: overOn("ipLab") })).toBe("Atlas would move to Gather, position 1 of 3.");
    expect(say.onDragOver({ active, over: overOn(intoId(null)) })).toBe("Atlas would move to Unplaced, position 2 of 2.");
    expect(say.onDragOver({ active: activeFor("ip1"), over: overOn("ip2") })).toBe(
      "IP Lab 1 would move to IP Lab, position 2 of 2.",
    );
    expect(say.onDragOver({ active, over: { ...overOn("ipLab")!, id: "atlas", data: { current: nodeData(row("atlas")) } } })).toBe(
      "Atlas would stay where it is, in Culture, position 1 of 2.",
    );
    expect(say.onDragOver({ active, over: null })).toBe("Atlas isn't over a place it can go.");
  });

  it("says what happened on drop, in moveAnnouncement's words", () => {
    expect(say.onDragEnd({ active, over: overOn(intoId("gather")) })).toBe("Moved Atlas to Gather, position 3.");
    expect(say.onDragEnd({ active, over: null })).toBe("Atlas wasn't moved.");
  });

  it("says a cancelled drag left it where it was", () => {
    expect(say.onDragCancel({ active, over: overOn("ipLab") })).toBe(
      "Moving Atlas was cancelled. It's still in Culture, position 1 of 2.",
    );
  });
});
