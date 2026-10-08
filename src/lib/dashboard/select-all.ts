import type { PostgrestError } from "@supabase/supabase-js";

// PostgREST returns at most 1,000 rows per request (max_rows in supabase/config.toml, the same as
// hosted Supabase), so any query that could grow past that is read in batches of this size.
export const PAGE_SIZE = 1000;

type Batch<T> = { data: T[] | null; error: PostgrestError | null };

// Every row of a query. `batch(after)` returns the next PAGE_SIZE rows ordered by id, starting
// after `after` (from the first row when it's null). Batches are keyed on id rather than an
// offset, so a row written between two requests can't be read twice or push another row out.
export async function selectAll<T extends { id: string }>(
  batch: (after: string | null) => PromiseLike<Batch<T>>,
): Promise<{ data: T[]; error: null } | { data: null; error: PostgrestError }> {
  const rows: T[] = [];
  for (let after: string | null = null; ; ) {
    const { data, error } = await batch(after);
    if (error) return { data: null, error };
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return { data: rows, error: null };
    after = data[data.length - 1].id;
  }
}
