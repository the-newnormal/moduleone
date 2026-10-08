import { describe, expect, it, vi } from "vitest";
import { PAGE_SIZE, selectAll } from "./select-all";

const rows = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `id-${String(from + i).padStart(5, "0")}` }));

describe("selectAll", () => {
  it("reads past the 1,000-row cap, each batch starting after the last id", async () => {
    const all = rows(0, PAGE_SIZE * 2 + 3);
    const batch = vi.fn(async (after: string | null) => {
      const start = after === null ? 0 : all.findIndex((r) => r.id === after) + 1;
      return { data: all.slice(start, start + PAGE_SIZE), error: null };
    });
    const { data } = await selectAll(batch);
    expect(data).toEqual(all);
    expect(batch.mock.calls.map(([after]) => after)).toEqual([null, all[PAGE_SIZE - 1].id, all[PAGE_SIZE * 2 - 1].id]);
  });

  it("asks once more after an exactly full batch, then stops on the empty one", async () => {
    const batch = vi
      .fn()
      .mockResolvedValueOnce({ data: rows(0, PAGE_SIZE), error: null })
      .mockResolvedValueOnce({ data: [], error: null });
    const { data } = await selectAll(batch);
    expect(data).toHaveLength(PAGE_SIZE);
    expect(batch).toHaveBeenCalledTimes(2);
  });

  it("stops at the first short batch", async () => {
    const batch = vi.fn().mockResolvedValue({ data: rows(0, 3), error: null });
    expect((await selectAll(batch)).data).toHaveLength(3);
    expect(batch).toHaveBeenCalledOnce();
  });

  it("returns the error and nothing else when a batch fails", async () => {
    const error = { code: "42703", message: "column teams.parent_id does not exist", details: "", hint: "" };
    const batch = vi
      .fn()
      .mockResolvedValueOnce({ data: rows(0, PAGE_SIZE), error: null })
      .mockResolvedValueOnce({ data: null, error });
    expect(await selectAll(batch)).toEqual({ data: null, error });
  });
});
