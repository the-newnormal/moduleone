// The live transcript, assembled from OpenAI's realtime transcription events (transport.ts maps
// them). Each turn the recorder commits becomes one item; its text arrives as deltas and is then
// replaced by the finished transcript. Items can finish out of order, and a delta can arrive before
// the item is committed, so the order comes only from the commits. Pure: no browser APIs.

export type TranscriptEvent =
  | { type: "committed"; itemId: string; previousItemId: string | null }
  | { type: "delta"; itemId: string; delta: string }
  | { type: "completed"; itemId: string; transcript: string }
  | { type: "failed"; itemId: string };

type Item = { readonly text: string; readonly final: boolean };

// Never changed in place: applyEvent returns a new transcript (or the same one when nothing changed),
// so it can live in React state.
export type LiveTranscript = {
  readonly order: readonly string[];
  readonly items: ReadonlyMap<string, Item>;
};

const EMPTY: LiveTranscript = { order: [], items: new Map() };

export function emptyTranscript(): LiveTranscript {
  return EMPTY;
}

function withItem(t: LiveTranscript, itemId: string, item: Item, order: readonly string[] = t.order): LiveTranscript {
  const items = new Map(t.items);
  items.set(itemId, item);
  return { order, items };
}

// Items not yet placed by a commit go at the end, where speech still coming in belongs.
function appended(t: LiveTranscript, itemId: string): readonly string[] {
  return t.order.includes(itemId) ? t.order : [...t.order, itemId];
}

export function applyEvent(t: LiveTranscript, event: TranscriptEvent): LiveTranscript {
  const current = t.items.get(event.itemId);
  switch (event.type) {
    case "committed": {
      // Right after the item before it; first when there is none; at the end when that item is
      // unknown (its events were lost).
      const rest = t.order.filter((id) => id !== event.itemId);
      const after = event.previousItemId === null ? -1 : rest.indexOf(event.previousItemId);
      const at = event.previousItemId === null ? 0 : after === -1 ? rest.length : after + 1;
      const order = [...rest.slice(0, at), event.itemId, ...rest.slice(at)];
      return withItem(t, event.itemId, current ?? { text: "", final: false }, order);
    }
    case "delta": {
      // A finished item already has its full text; a late delta would only repeat part of it.
      if (current?.final || (current && event.delta === "")) return t;
      return withItem(t, event.itemId, { text: (current?.text ?? "") + event.delta, final: false }, appended(t, event.itemId));
    }
    case "completed":
      return withItem(t, event.itemId, { text: event.transcript, final: true }, appended(t, event.itemId));
    case "failed":
      // Whatever arrived before it failed is still what they said.
      return withItem(t, event.itemId, { text: current?.text ?? "", final: true }, appended(t, event.itemId));
  }
}

// Everything heard so far, in order, as one line.
export function transcriptText(t: LiveTranscript): string {
  const parts: string[] = [];
  for (const id of t.order) {
    const text = t.items.get(id)?.text.trim();
    if (text) parts.push(text);
  }
  return parts.join(" ").trim();
}

// Words as the grader counts them (countWords in src/lib/grader/prompt.ts, which can't be imported
// here: its module reads the rubric file on the server). The segmenter is made once; browsers
// without one count runs of letters and digits.
let segmenter: Intl.Segmenter | null | undefined;

export function wordCount(text: string): number {
  if (segmenter === undefined) {
    segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("en", { granularity: "word" }) : null;
  }
  if (!segmenter) return text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  let words = 0;
  for (const segment of segmenter.segment(text)) {
    if (segment.isWordLike) words++;
  }
  return words;
}
