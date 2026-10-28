/**
 * Where to send a user after sign-in. Only a path on our own origin.
 *
 * Checking for a leading "/" and rejecting "//" is not enough: browsers and
 * the URL parser treat "/\evil.com" (and tab or newline variants) as
 * protocol-relative, so the value is resolved against our origin and the
 * result must still be our origin.
 */
export function safeNextPath(raw: string | null | undefined, fallback = "/"): string {
  if (!raw || !raw.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(raw)) return fallback;
  try {
    const base = "https://humanframe.invalid";
    const url = new URL(raw, base);
    if (url.origin !== base) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
