import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Reading a business's public website, safely.
 *
 * The URL comes from the owner, so this is a server-side fetch of a URL a
 * user chose — the textbook SSRF. Every hop is checked: the scheme, the port,
 * and every address the hostname resolves to, so a site cannot redirect us
 * into the metadata service or the database's private network.
 */

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export class UnsafeUrlError extends Error {}

export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower);
  }
  return true;
}

/** Normalises what an owner types ("snekker.no") into a URL we may fetch. */
export function normalizeWebsiteUrl(input: string): URL {
  const trimmed = input.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new UnsafeUrlError("Not a URL");
  }
  assertPublicShape(url);
  url.hash = "";
  return url;
}

function assertPublicShape(url: URL): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeUrlError("Only http and https");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("No credentials in URLs");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new UnsafeUrlError("Only standard ports");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isPrivateAddress(host)) {
    throw new UnsafeUrlError("Private address");
  }
  if (!isIP(host) && (!host.includes(".") || host.endsWith(".local") || host.endsWith(".internal"))) {
    throw new UnsafeUrlError("Not a public hostname");
  }
}

async function assertPublicHost(url: URL): Promise<void> {
  assertPublicShape(url);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return;
  const addresses = await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new UnsafeUrlError("Resolves to a private address");
  }
}

export type FetchedPage = { url: string; html: string };

/** One page, following at most three redirects, each re-checked. */
export async function fetchPublicPage(start: URL): Promise<FetchedPage> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(current);
    const response = await fetch(current, {
      redirect: "manual",
      headers: {
        "user-agent": "HumanframeBot/1.0 (+https://humanframe.app)",
        accept: "text/html,application/xhtml+xml",
        "accept-language": "nb-NO,nb;q=0.9,no;q=0.8,en;q=0.5",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect without location from ${current}`);
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${current.hostname}`);
    }
    const type = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(type)) {
      throw new Error(`Not HTML: ${type}`);
    }
    return { url: current.toString(), html: await readCapped(response) };
  }
  throw new Error("Too many redirects");
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks).subarray(0, MAX_BYTES));
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  aring: "å",
  Aring: "Å",
  aelig: "æ",
  AElig: "Æ",
  oslash: "ø",
  Oslash: "Ø",
  ndash: "–",
  mdash: "—",
  hellip: "…",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const value = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : match;
    }
    return ENTITIES[code] ?? match;
  });
}

/**
 * Visible text, roughly as a reader sees it. Scripts, styles and SVG go;
 * block elements become line breaks so opening hours stay on their lines.
 */
export function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const description =
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ??
    /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(html)?.[1] ??
    "";
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|header|footer|table|ul|ol|dt|dd)>/gi, "\n")
    .replace(/<(td|th)[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  const text = decodeEntities([title, description, body].join("\n"))
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .filter((line) => line.length > 0);

  // Menus repeat on every page; keep the first occurrence of each line.
  const seen = new Set<string>();
  return text
    .filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    })
    .join("\n");
}

/** Pages on the same site that are likely to hold contact, prices or hours. */
export function pickSubpages(html: string, base: string, limit = 5): string[] {
  const origin = new URL(base);
  const scored = new Map<string, number>();
  const pattern = /<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(pattern)) {
    let url: URL;
    try {
      url = new URL(match[1], origin);
    } catch {
      continue;
    }
    if (url.hostname.replace(/^www\./, "") !== origin.hostname.replace(/^www\./, "")) continue;
    if (!/^https?:$/.test(url.protocol)) continue;
    if (/\.(pdf|jpe?g|png|gif|webp|zip|docx?|xlsx?)$/i.test(url.pathname)) continue;
    url.hash = "";
    url.search = "";
    const key = url.toString();
    if (key === origin.toString() || key === `${origin.origin}/`) continue;

    const label = `${url.pathname} ${match[2].replace(/<[^>]+>/g, " ")}`.toLowerCase();
    let score = 0;
    for (const [word, weight] of SUBPAGE_WORDS) {
      if (label.includes(word)) score += weight;
    }
    if (score > 0) scored.set(key, Math.max(score, scored.get(key) ?? 0));
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([url]) => url);
}

const SUBPAGE_WORDS: [string, number][] = [
  ["kontakt", 5],
  ["contact", 5],
  ["pris", 5],
  ["price", 5],
  ["åpningstid", 5],
  ["apningstid", 5],
  ["tjenester", 4],
  ["tjeneste", 4],
  ["services", 4],
  ["behandling", 4],
  ["om-oss", 3],
  ["om oss", 3],
  ["about", 3],
  ["faq", 3],
  ["spørsmål", 3],
  ["booking", 2],
  ["bestill", 2],
  ["timebestilling", 3],
];

export type CrawlResult = { pages: { url: string; text: string }[] };

/** The homepage plus the few subpages most likely to matter. */
export async function crawlBusinessSite(input: string, maxPages = 5): Promise<CrawlResult> {
  const start = normalizeWebsiteUrl(input);
  const home = await fetchPublicPage(start);
  const pages = [{ url: home.url, text: htmlToText(home.html) }];

  const subpages = pickSubpages(home.html, home.url, maxPages - 1);
  const results = await Promise.allSettled(
    subpages.map((url) => fetchPublicPage(new URL(url)))
  );
  for (const result of results) {
    if (result.status === "fulfilled") {
      pages.push({ url: result.value.url, text: htmlToText(result.value.html) });
    }
  }
  return { pages };
}
