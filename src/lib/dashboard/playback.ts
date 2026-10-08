// When the drill-in's recording player (src/app/portal/dashboard/[teamId]/[week]/recording-player.tsx)
// may fetch a fresh link by itself. A link lasts ten minutes (./recordings.ts), so an error a minute
// or more after the last automatic reload is a link that ran out; an error sooner than that is a
// real failure, which the listener sees, with Try again, instead of the player retrying forever.
export const AUTO_RELOAD_GAP_MS = 60_000;

export const mayAutoReload = (now: number, lastAutoReload: number | null) =>
  lastAutoReload === null || now - lastAutoReload >= AUTO_RELOAD_GAP_MS;

// Each reload asks for the stable address under a new query string, so the browser can't reuse
// the expired link it was redirected to before. The query leaves the extension Safari reads intact.
export const reloadAddress = (src: string, attempt: number) => `${src}?reload=${attempt}`;
