import { describe, expect, it } from "vitest";
import { applyEvent, emptyTranscript, transcriptText, wordCount, type LiveTranscript, type TranscriptEvent } from "./transcript";

const run = (events: TranscriptEvent[], start: LiveTranscript = emptyTranscript()) => events.reduce(applyEvent, start);

describe("applyEvent", () => {
  it("puts committed items in order and fills them in as they finish, in any order", () => {
    const t = run([
      { type: "committed", itemId: "a", previousItemId: null },
      { type: "committed", itemId: "b", previousItemId: "a" },
      { type: "committed", itemId: "c", previousItemId: "b" },
      { type: "completed", itemId: "c", transcript: "Morale is quite good lah." },
      { type: "completed", itemId: "a", transcript: "This week I shipped the login page." },
      { type: "completed", itemId: "b", transcript: "Wei Ling and I fixed the checkout bug." },
    ]);
    expect(t.order).toEqual(["a", "b", "c"]);
    expect(transcriptText(t)).toBe(
      "This week I shipped the login page. Wei Ling and I fixed the checkout bug. Morale is quite good lah.",
    );
  });

  it("shows deltas as they arrive, then replaces them with the finished text", () => {
    let t = run([
      { type: "committed", itemId: "a", previousItemId: null },
      { type: "delta", itemId: "a", delta: "This week I " },
      { type: "delta", itemId: "a", delta: "ship the logn page" },
    ]);
    expect(transcriptText(t)).toBe("This week I ship the logn page");
    expect(t.items.get("a")).toEqual({ text: "This week I ship the logn page", final: false });
    t = applyEvent(t, { type: "completed", itemId: "a", transcript: "This week I shipped the login page." });
    expect(t.items.get("a")).toEqual({ text: "This week I shipped the login page.", final: true });
    // A late delta doesn't add to finished text.
    expect(applyEvent(t, { type: "delta", itemId: "a", delta: "page" })).toBe(t);
  });

  it("takes deltas that arrive before their item is committed, and places the item when it is", () => {
    const t = run([
      { type: "committed", itemId: "a", previousItemId: null },
      { type: "delta", itemId: "c", delta: "Feeling shiok about the team." },
      { type: "committed", itemId: "b", previousItemId: "a" },
      { type: "delta", itemId: "b", delta: "Helped Arjun with the demo." },
      { type: "completed", itemId: "a", transcript: "Shipped the login page." },
      { type: "committed", itemId: "c", previousItemId: "b" },
    ]);
    expect(t.order).toEqual(["a", "b", "c"]);
    expect(transcriptText(t)).toBe("Shipped the login page. Helped Arjun with the demo. Feeling shiok about the team.");
  });

  it("moves an item placed early to where its commit says, after the previous item", () => {
    const t = run([
      { type: "delta", itemId: "b", delta: "second" },
      { type: "delta", itemId: "a", delta: "first" },
      { type: "committed", itemId: "b", previousItemId: "a" },
    ]);
    expect(t.order).toEqual(["a", "b"]);
  });

  it("puts an item with no previous item first, and one whose previous item is unknown at the end", () => {
    let t = run([
      { type: "committed", itemId: "b", previousItemId: "zzz" },
      { type: "committed", itemId: "a", previousItemId: null },
    ]);
    expect(t.order).toEqual(["a", "b"]);
    t = applyEvent(t, { type: "committed", itemId: "c", previousItemId: "lost" });
    expect(t.order).toEqual(["a", "b", "c"]);
    // Committed again: moved, not repeated.
    t = applyEvent(t, { type: "committed", itemId: "c", previousItemId: "a" });
    expect(t.order).toEqual(["a", "c", "b"]);
  });

  it("keeps what arrived before a failure, and marks the item finished", () => {
    let t = run([
      { type: "committed", itemId: "a", previousItemId: null },
      { type: "delta", itemId: "a", delta: "My superpower is " },
      { type: "failed", itemId: "a" },
    ]);
    expect(t.items.get("a")).toEqual({ text: "My superpower is ", final: true });
    expect(transcriptText(t)).toBe("My superpower is");
    t = applyEvent(t, { type: "failed", itemId: "b" });
    expect(t.order).toEqual(["a", "b"]);
    expect(transcriptText(t)).toBe("My superpower is");
  });

  it("never changes the transcript it was given", () => {
    const before = run([{ type: "committed", itemId: "a", previousItemId: null }]);
    const snapshot = { order: [...before.order], items: new Map(before.items) };
    applyEvent(before, { type: "delta", itemId: "a", delta: "hello" });
    applyEvent(before, { type: "committed", itemId: "b", previousItemId: null });
    applyEvent(before, { type: "completed", itemId: "a", transcript: "hello" });
    expect(before.order).toEqual(snapshot.order);
    expect(before.items).toEqual(snapshot.items);
    expect(emptyTranscript().order).toEqual([]);
  });
});

describe("transcriptText", () => {
  it("joins non-empty items with single spaces", () => {
    const t = run([
      { type: "completed", itemId: "a", transcript: "  Shipped the login page.  " },
      { type: "completed", itemId: "b", transcript: "   " },
      { type: "completed", itemId: "c", transcript: "Team is steady." },
    ]);
    expect(transcriptText(t)).toBe("Shipped the login page. Team is steady.");
    expect(transcriptText(emptyTranscript())).toBe("");
  });
});

describe("wordCount", () => {
  it("counts words the way the grader does", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("This week I shipped the login page, can or not?")).toBe(10);
    expect(wordCount("Wei Ling's team — 3 releases!")).toBe(5);
  });
});
