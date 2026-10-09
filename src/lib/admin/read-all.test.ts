import type { PostgrestError } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { PAGE_SIZE } from "@/lib/dashboard/select-all";
import { readAll } from "./read-all";

const rows = (n: number, start = 0) => Array.from({ length: n }, (_, i) => ({ n: start + i }));

describe("readAll", () => {
  it("reads one page when it isn't full", async () => {
    const page = vi.fn(async () => ({ data: rows(3), error: null }));
    await expect(readAll(page)).resolves.toEqual({ data: rows(3), error: null });
    expect(page).toHaveBeenCalledExactlyOnceWith(0, PAGE_SIZE - 1);
  });

  it("keeps reading while pages are full, so nothing past the row limit is dropped", async () => {
    const page = vi.fn(async (from: number) => ({
      data: from === 0 ? rows(PAGE_SIZE) : rows(2, PAGE_SIZE),
      error: null,
    }));
    const result = await readAll(page);
    expect(result.data).toHaveLength(PAGE_SIZE + 2);
    expect(result.data?.at(-1)).toEqual({ n: PAGE_SIZE + 1 });
    expect(page.mock.calls).toEqual([
      [0, PAGE_SIZE - 1],
      [PAGE_SIZE, 2 * PAGE_SIZE - 1],
    ]);
  });

  it("asks once more after an exactly full page, and stops on the empty one", async () => {
    const page = vi.fn(async (from: number) => ({ data: from === 0 ? rows(PAGE_SIZE) : [], error: null }));
    const result = await readAll(page);
    expect(result.data).toHaveLength(PAGE_SIZE);
    expect(page).toHaveBeenCalledTimes(2);
  });

  it("returns the error of any page, and no rows", async () => {
    const error = { code: "08006", message: "down", details: "", hint: "", name: "PostgrestError" } as unknown as PostgrestError;
    const page = vi.fn(async (from: number) =>
      from === 0 ? { data: rows(PAGE_SIZE), error: null } : { data: null, error },
    );
    await expect(readAll(page)).resolves.toEqual({ data: null, error });
  });

  it("treats a null page as empty", async () => {
    await expect(readAll(async () => ({ data: null, error: null }))).resolves.toEqual({ data: [], error: null });
  });
});
