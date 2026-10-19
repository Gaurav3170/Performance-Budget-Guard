/**
 * Script identity across builds. Bundlers put content hashes and numeric chunk ids in
 * file names, so the same logical script has a different URL in base and head. The key
 * replaces those generated tokens with "*" so the two builds' scripts can be matched.
 */

const DELIMITERS = /([/.\-_~])/;

/** Hash-like (≥ 8 alphanumerics with a digit) or a numeric chunk id (≥ 3 digits). */
function isGeneratedToken(token: string): boolean {
  if (/^\d{3,}$/.test(token)) return true;
  return /^[A-Za-z0-9]{8,}$/.test(token) && /\d/.test(token);
}

function normalizePath(pathname: string): string {
  return pathname
    .split(DELIMITERS)
    .map((part) => (isGeneratedToken(part) ? "*" : part))
    .join("");
}

/**
 * Same-origin scripts become their path ("/assets/index-*.js"); cross-origin ones keep
 * the host so a CDN script never collides with a local one ("cdn.example.com/lib.js").
 * Query strings and hashes are dropped because they usually carry cache busters.
 */
export function normalizeScriptKey(url: string, pageOrigin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url, pageOrigin);
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    // data:/blob: URLs have no stable name; group them by scheme and media type.
    return `${parsed.protocol}${parsed.pathname.split(/[;,]/)[0] ?? ""}`;
  }
  const path = normalizePath(parsed.pathname);
  return parsed.origin === pageOrigin ? path : `${parsed.host}${path}`;
}
