export const DEFAULT_AFTER_LOGIN = "/portal";

const BASE = "http://moduleone.invalid";

// Where to send the user after sign-in. Only same-site paths are allowed, so a crafted
// link like /login?next=https://evil.example (or //evil.example, /\evil.example) can't
// bounce a freshly signed-in user to another site.
export function safeNextPath(
  raw: string | null | undefined,
  fallback: string = DEFAULT_AFTER_LOGIN,
): string {
  if (!raw || !raw.startsWith("/")) return fallback;

  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE) return fallback;

  // Dot segments can collapse to a protocol-relative path: "/.//evil.example" parses to "//evil.example".
  const path = url.pathname + url.search + url.hash;
  return path.startsWith("//") ? fallback : path;
}
