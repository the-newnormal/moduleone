// Where to send someone whose sign-in has run out: the login page, then back to this exact page,
// query included (the week picked, the trend range, the week a bar was opened from). The proxy
// does the same for most requests (src/lib/supabase/proxy.ts); this covers the pages' own check.
export function signInAgain(path: string, params: Record<string, string | string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const v of [value].flat()) if (v !== undefined) query.append(key, v);
  }
  const here = query.size > 0 ? `${path}?${query}` : path;
  return `/login?next=${encodeURIComponent(here)}`;
}
