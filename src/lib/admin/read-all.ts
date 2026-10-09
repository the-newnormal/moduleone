import type { PostgrestError } from "@supabase/supabase-js";
import { PAGE_SIZE } from "@/lib/dashboard/select-all";

type Page<T> = { data: T[] | null; error: PostgrestError | null };

// Every row of a query, for admin pages that read whole tables (every team, member, lead or
// grant). PostgREST returns at most PAGE_SIZE rows per request, so a plain select would silently
// drop the rest once the organisation grows past it. `page(from, to)` returns rows from..to
// (inclusive) and must order by a unique key (e.g. .order("team_id").order("member_id")) so pages
// don't overlap. Unlike selectAll (src/lib/dashboard), this works for tables without an id column.
export async function readAll<T>(
  page: (from: number, to: number) => PromiseLike<Page<T>>,
): Promise<{ data: T[]; error: null } | { data: null; error: PostgrestError }> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) return { data: null, error };
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return { data: rows, error: null };
  }
}
