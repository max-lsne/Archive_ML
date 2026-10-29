/**
 * Fetches the documentation behind a user-supplied link: the page itself, any
 * assembly-manual PDFs it links to, and a couple of product photos. Everything
 * here is best-effort — a product page with no PDF still yields usable context.
 */
import * as cheerio from "cheerio";
import { extractText } from "unpdf";
import dns from "node:dns/promises";
import dnsCallback from "node:dns";
import net from "node:net";
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { config } from "./config.js";
import { log } from "./logger.js";
import type { SourceDoc } from "../../shared/project.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 BuildGuide/0.1";

export interface PdfDoc {
  url: string;
  title: string;
  bytes: Buffer;
  pages: number;
  text: string;
}

export interface ImageDoc {
  url: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  bytes: Buffer;
}

export interface Gathered {
  url: string;
  finalUrl: string;
  pageTitle: string;
  pageDescription: string;
  pageText: string;
  pdfs: PdfDoc[];
  images: ImageDoc[];
  imageUrl?: string;
  sources: SourceDoc[];
  warnings: string[];
}

export class FetchError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "FetchError";
  }
}

// ---------------------------------------------------------------------------

export function normalizeUrl(input: string): URL {
  let s = input.trim();
  // A leading "scheme:" (but not "host:port") that isn't http(s) is rejected outright.
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s) && !/^https?:/i.test(s)) {
    throw new FetchError("Only http(s) links are supported.");
  }
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new FetchError("That doesn't look like a valid link.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchError("Only http(s) links are supported.");
  }
  return url;
}

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = ip.toLowerCase();
  // IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:7f00:1): judge the embedded IPv4.
  const mapped = v6.match(/^(?:0*:)*ffff:(.+)$/);
  if (mapped) {
    const tail = mapped[1];
    if (net.isIPv4(tail)) return isPrivateAddress(tail);
    const hex = tail.split(":");
    if (hex.length === 2 && hex.every((h) => /^[0-9a-f]{1,4}$/.test(h))) {
      const n = (parseInt(hex[0], 16) << 16) | parseInt(hex[1], 16);
      return isPrivateAddress(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
    }
    return true;
  }
  // ::1 loopback, :: unspecified, fc00::/7 unique-local, fe80::/10 link-local.
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || /^fe[89ab]/.test(v6);
}

/**
 * Pure part of the SSRF check: is this hostname a literal address (IPv4, or a
 * bracketed/unbracketed IPv6) in a private range, or an obviously local name?
 * Returns `true` for private, `false` for public literals, `null` when the
 * host is a DNS name that still needs resolving.
 */
export function hostIsPrivateLiteral(hostname: string): boolean | null {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (net.isIP(host)) return isPrivateAddress(host);
  return null;
}

/** Basic SSRF hygiene: refuse to fetch loopback/private hosts (unless explicitly allowed for local testing). */
async function assertPublicHost(url: URL): Promise<void> {
  if (config.allowPrivateUrls) return;
  const literal = hostIsPrivateLiteral(url.hostname);
  if (literal === true) throw new FetchError("Links to local or private network addresses are not allowed.");
  if (literal === false) return;
  try {
    const addrs = await dns.lookup(url.hostname, { all: true });
    if (addrs.some((a) => isPrivateAddress(a.address))) {
      throw new FetchError("Links to private network addresses are not allowed.");
    }
  } catch (e) {
    if (e instanceof FetchError) throw e;
    // DNS resolution can legitimately fail behind proxies; let fetch decide.
  }
}

interface Fetched {
  finalUrl: string;
  contentType: string;
  bytes: Buffer;
}

const MAX_REDIRECTS = 5;

/**
 * DNS resolution that refuses private addresses at connect time. assertPublicHost
 * checks the name first, but a rebinding host can answer public there and private
 * for the actual connection; pinning the check into the dialer closes that gap.
 */
function proxyEnv(): string | undefined {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
}

/** Hostnames of the configured proxies: connections to them are ours, not the user's link, so they skip the guard. */
function proxyHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const v of [process.env.HTTPS_PROXY, process.env.https_proxy, process.env.HTTP_PROXY, process.env.http_proxy]) {
    if (!v) continue;
    try {
      hosts.add(new URL(v).hostname.replace(/^\[|\]$/g, "").toLowerCase());
    } catch {
      /* unparsable proxy value: ignore */
    }
  }
  return hosts;
}

const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dnsCallback.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err, address, family);
    const addresses = Array.isArray(address) ? address.map((a) => a.address) : [address];
    const isProxy = proxyHosts().has(hostname.toLowerCase());
    if (!config.allowPrivateUrls && !isProxy && addresses.some((a) => typeof a === "string" && isPrivateAddress(a))) {
      const refused: NodeJS.ErrnoException = new Error(`${hostname} resolves to a private network address`);
      refused.code = "EPRIVATEADDR";
      return callback(refused, address, family);
    }
    callback(null, address, family);
  });
};

let dispatcher: Dispatcher | undefined;
function getDispatcher(): Dispatcher {
  if (dispatcher) return dispatcher;
  // Honouring HTTPS_PROXY here removes the need for NODE_USE_ENV_PROXY. The proxy
  // agent still dials NO_PROXY hosts directly, so the guarded lookup goes on both
  // (connections to the proxy itself are exempted inside guardedLookup).
  dispatcher = proxyEnv()
    ? new EnvHttpProxyAgent({ connect: { lookup: guardedLookup } })
    : new Agent({ connect: { lookup: guardedLookup } });
  return dispatcher;
}

/**
 * Fetch with manual redirect handling so every hop goes through the
 * private-host check (a public URL may 30x to an internal address).
 */
/** Raised when the caller's signal (project deleted) cancels a fetch. */
export class FetchCancelled extends FetchError {
  constructor() {
    super("Cancelled.");
    this.name = "FetchCancelled";
  }
}

async function fetchBytes(url: string, maxBytes: number, accept = "*/*", signal?: AbortSignal): Promise<Fetched> {
  if (signal?.aborted) throw new FetchCancelled();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.fetchTimeoutMs);
  // The per-request timeout and the caller's cancellation both abort the fetch.
  const combined = signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal;
  let current = new URL(url);
  try {
    for (let hop = 0; ; hop++) {
      await assertPublicHost(current);
      const res = await undiciFetch(current, {
        dispatcher: getDispatcher(),
        redirect: "manual",
        signal: combined,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: accept,
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!location) throw new FetchError(`The site answered ${res.status} without a redirect target.`, res.status);
        if (hop >= MAX_REDIRECTS) throw new FetchError("Too many redirects.");
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new FetchError("The site redirected to an invalid address.");
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          throw new FetchError("The site redirected to a non-http(s) address.");
        }
        current = next;
        continue;
      }
      if (!res.ok) {
        throw new FetchError(`The site answered ${res.status} ${res.statusText || ""}`.trim(), res.status);
      }
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len && len > maxBytes) throw new FetchError(`File is too large (${(len / 1e6).toFixed(1)} MB).`);
      if (!res.body) throw new FetchError("Empty response.");
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          reader.cancel().catch(() => {});
          throw new FetchError(`File is too large (over ${(maxBytes / 1e6).toFixed(0)} MB).`);
        }
        chunks.push(value);
      }
      return {
        finalUrl: current.toString(),
        contentType: (res.headers.get("content-type") ?? "").toLowerCase(),
        bytes: Buffer.concat(chunks),
      };
    }
  } catch (e) {
    if (e instanceof FetchError) throw e;
    if (signal?.aborted) throw new FetchCancelled();
    const msg = e instanceof Error ? e.message : String(e);
    if (/abort/i.test(msg)) throw new FetchError("Timed out fetching the link.");
    // undici wraps network errors in a bare "fetch failed"; surface the real cause.
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code === "EPRIVATEADDR") throw new FetchError("Links to private network addresses are not allowed.");
    const detail = cause?.code || cause?.message;
    throw new FetchError(`Could not fetch the link (${detail ? `${msg}: ${detail}` : msg}).${detail === "ENOTFOUND" ? " Check the address and your network/proxy settings." : ""}`);
  } finally {
    clearTimeout(timer);
  }
}

function isPdf(contentType: string, bytes: Buffer, url: string): boolean {
  if (contentType.includes("application/pdf")) return true;
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return true;
  return looksLikePdfUrl(url) && !contentType.includes("text/html");
}

// ---------------------------------------------------------------------------
// HTML parsing

export interface PdfCandidate {
  url: string;
  text: string;
  score: number;
}

const POSITIVE = /assembl|instruction|manual|montage|montering|aufbau|anleitung|notice|mode d'emploi|guide|setup|set-up|pitch|install|how to|build|user guide|bedienung|istruzioni|instrucciones|handleiding/i;
const NEGATIVE = /warranty|guarantee|catalog|catalogue|brochure|spec sheet|safety data|sds|price|invoice|terms|privacy|return|care instruction|cleaning|declaration|conformity|certificate|energy label|flyer|lookbook/i;

export function scorePdfCandidate(url: string, anchorText: string): number {
  let score = 0;
  const u = url.toLowerCase();
  const t = anchorText.toLowerCase();
  if (looksLikePdfUrl(u)) score += 2;
  if (POSITIVE.test(t)) score += 5;
  if (POSITIVE.test(u)) score += 4;
  if (/assembly[_-]?instructions|\/aa-\d{5,}|aa-\d{5,}/.test(u)) score += 6; // IKEA style
  if (NEGATIVE.test(t)) score -= 4;
  if (NEGATIVE.test(u)) score -= 3;
  return score;
}

export function looksLikePdfUrl(url: string): boolean {
  return /\.pdf(\?|#|$)/i.test(url);
}

/** Real .pdf links first (they are what we can actually use), then by score. */
export function rankPdfCandidates(candidates: PdfCandidate[]): PdfCandidate[] {
  return [...candidates].sort((a, b) => {
    const pa = looksLikePdfUrl(a.url) ? 1 : 0;
    const pb = looksLikePdfUrl(b.url) ? 1 : 0;
    return pb - pa || b.score - a.score;
  });
}

export interface ParsedPage {
  title: string;
  description: string;
  text: string;
  pdfCandidates: PdfCandidate[];
  imageCandidates: string[];
  ogImage?: string;
}

export function parseHtml(html: string, baseUrl: string): ParsedPage {
  const $ = cheerio.load(html);
  const abs = (href: string | undefined): string | null => {
    if (!href) return null;
    try {
      const u = new URL(href.trim(), baseUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      u.hash = "";
      return u.toString();
    } catch {
      return null;
    }
  };

  const title = ($('meta[property="og:title"]').attr("content") || $("title").first().text() || "").trim();
  const description = (
    $('meta[name="description"]').attr("content") ||
    $('meta[property="og:description"]').attr("content") ||
    ""
  ).trim();
  const ogImage = abs($('meta[property="og:image"]').attr("content") || $('meta[name="twitter:image"]').attr("content")) ?? undefined;

  // PDF candidates from anchors. In-page anchors (#tab) and links back to the
  // page itself are never manuals, however promising their text looks.
  const selfUrl = abs(baseUrl);
  const candidates = new Map<string, PdfCandidate>();
  const addCandidate = (url: string | null, text: string) => {
    if (!url || url === selfUrl) return;
    const score = scorePdfCandidate(url, text);
    const prev = candidates.get(url);
    if (!prev || prev.score < score) candidates.set(url, { url, text: text.slice(0, 120), score });
  };
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.trim().startsWith("#")) return;
    const text = $(el).text().replace(/\s+/g, " ").trim() || $(el).attr("aria-label") || $(el).attr("title") || "";
    const url = abs(href);
    if (!url) return;
    if (looksLikePdfUrl(url) || POSITIVE.test(text)) addCandidate(url, text);
  });
  // ... and from anywhere in the raw markup (embedded JSON, data attributes)
  const rawRe = /https?:\\?\/\\?\/[^\s"'<>)]+?\.pdf(?:\?[^\s"'<>)]*)?/gi;
  for (const m of html.matchAll(rawRe)) {
    const url = abs(m[0].replace(/\\\//g, "/").replace(/\\u002f/gi, "/"));
    if (url && !candidates.has(url)) addCandidate(url, "");
  }
  const relRe = /["'](\/[^\s"'<>]+?\.pdf(?:\?[^\s"'<>]*)?)["']/gi;
  for (const m of html.matchAll(relRe)) {
    const url = abs(m[1]);
    if (url && !candidates.has(url)) addCandidate(url, "");
  }
  const pdfCandidates = rankPdfCandidates([...candidates.values()].filter((c) => looksLikePdfUrl(c.url) || c.score >= 5));

  // Product images (skip icons/logos/sprites)
  const imgs: string[] = [];
  $("img[src], img[data-src], source[srcset]").each((_, el) => {
    const raw = $(el).attr("src") || $(el).attr("data-src") || ($(el).attr("srcset") || "").split(",")[0]?.trim().split(" ")[0];
    const url = abs(raw);
    if (!url) return;
    if (/\.(svg|gif)(\?|$)/i.test(url) || /logo|icon|sprite|flag|badge|avatar|pixel|tracking|placeholder/i.test(url)) return;
    const w = Number($(el).attr("width") || 0);
    if (w && w < 200) return;
    if (!imgs.includes(url)) imgs.push(url);
  });

  // Readable text
  $("script, style, noscript, svg, nav, footer, header, iframe, form, button, [aria-hidden='true']").remove();
  // Keep block boundaries as line breaks so headings and paragraphs don't run together.
  $("p, h1, h2, h3, h4, h5, h6, li, tr, dd, dt, div, section, article, td, th, br").after("\n");
  const text = ($("main").text() || $("body").text() || "")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, description, text, pdfCandidates, imageCandidates: imgs.slice(0, 12), ogImage };
}

// ---------------------------------------------------------------------------

async function loadPdf(url: string, bytes: Buffer, title: string, warnings: string[]): Promise<PdfDoc> {
  let pages = 0;
  let text = "";
  try {
    const result = await extractText(new Uint8Array(bytes), { mergePages: true });
    pages = result.totalPages;
    text = (result.text || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  } catch (e) {
    warnings.push(`Could not read text from ${title}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (text.length > config.maxPdfTextChars) text = text.slice(0, config.maxPdfTextChars) + "\n…[truncated]";
  return { url, title, bytes, pages, text };
}

function fileNameFromUrl(url: string): string {
  try {
    const p = decodeURIComponent(new URL(url).pathname);
    return p.split("/").filter(Boolean).pop() || url;
  } catch {
    return url;
  }
}

async function fetchImage(url: string, signal?: AbortSignal): Promise<ImageDoc | null> {
  try {
    const f = await fetchBytes(url, 6 * 1024 * 1024, "image/*", signal);
    const ct = f.contentType.split(";")[0].trim();
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
    const mediaType = (allowed as readonly string[]).includes(ct)
      ? (ct as ImageDoc["mediaType"])
      : /\.(jpe?g)(\?|$)/i.test(url)
        ? "image/jpeg"
        : /\.png(\?|$)/i.test(url)
          ? "image/png"
          : /\.webp(\?|$)/i.test(url)
            ? "image/webp"
            : null;
    if (!mediaType || f.bytes.length < 2000) return null;
    return { url, mediaType, bytes: f.bytes };
  } catch (e) {
    if (e instanceof FetchCancelled) throw e;
    return null;
  }
}

/**
 * Gather everything we can about the product behind `input`.
 */
export async function gatherDocumentation(
  input: string,
  onProgress: (message: string) => void,
  signal?: AbortSignal,
): Promise<Gathered> {
  const url = normalizeUrl(input);
  const warnings: string[] = [];
  const sources: SourceDoc[] = [];
  const pdfs: PdfDoc[] = [];
  const images: ImageDoc[] = [];

  onProgress(`Fetching ${url.hostname}…`);
  const main = await fetchBytes(url.toString(), config.maxPdfBytes + 2 * 1024 * 1024, "text/html,application/pdf,*/*", signal);

  let pageTitle = "";
  let pageDescription = "";
  let pageText = "";
  let imageUrl: string | undefined;

  if (isPdf(main.contentType, main.bytes, main.finalUrl)) {
    onProgress("Reading the manual PDF…");
    const pdf = await loadPdf(main.finalUrl, main.bytes, fileNameFromUrl(main.finalUrl), warnings);
    pdfs.push(pdf);
    pageTitle = pdf.title;
    sources.push({ kind: "pdf", url: main.finalUrl, title: pdf.title, size: pdf.bytes.length, pages: pdf.pages });
  } else if (main.contentType.includes("html") || main.bytes.subarray(0, 512).toString("utf8").toLowerCase().includes("<html")) {
    onProgress("Reading the product page…");
    const page = parseHtml(main.bytes.toString("utf8"), main.finalUrl);
    pageTitle = page.title;
    pageDescription = page.description;
    pageText = page.text.length > config.maxPageTextChars ? page.text.slice(0, config.maxPageTextChars) + "\n…[truncated]" : page.text;
    imageUrl = page.ogImage;
    sources.push({ kind: "html", url: main.finalUrl, title: page.title || main.finalUrl, size: page.text.length });

    // Download the most promising manuals in rank order (parseHtml already
    // filtered and ranked them), stopping as soon as two real PDFs are in hand
    // so nothing that would be discarded is ever buffered.
    const MAX_ATTEMPTS = 4;
    const MAX_PDFS = 2;
    const attempts = page.pdfCandidates.slice(0, MAX_ATTEMPTS);
    for (const [i, cand] of attempts.entries()) {
      if (pdfs.length >= MAX_PDFS) break;
      onProgress(`Downloading manual ${pdfs.length + 1}/${Math.min(MAX_PDFS, attempts.length)}: ${fileNameFromUrl(cand.url)}${i > pdfs.length ? ` (candidate ${i + 1})` : ""}`);
      try {
        const f = await fetchBytes(cand.url, config.maxPdfBytes, "application/pdf,*/*", signal);
        if (!isPdf(f.contentType, f.bytes, f.finalUrl)) {
          warnings.push(`${fileNameFromUrl(cand.url)} was not a PDF.`);
          continue;
        }
        const pdf = await loadPdf(f.finalUrl, f.bytes, cand.text || fileNameFromUrl(f.finalUrl), warnings);
        pdfs.push(pdf);
        sources.push({ kind: "pdf", url: f.finalUrl, title: pdf.title, size: pdf.bytes.length, pages: pdf.pages });
      } catch (e) {
        if (e instanceof FetchCancelled) throw e;
        warnings.push(`Could not download ${fileNameFromUrl(cand.url)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // A few product photos help Claude understand the finished object. Fetched
    // one at a time and stopped at three, so nothing is downloaded only to be dropped.
    const MAX_IMAGES = 3;
    const imgUrls = [...new Set([page.ogImage, ...page.imageCandidates].filter((u): u is string => Boolean(u)))].slice(0, 5);
    for (const u of imgUrls) {
      if (images.length >= MAX_IMAGES) break;
      const img = await fetchImage(u, signal);
      if (img) images.push(img);
    }
    if (!imageUrl && images[0]) imageUrl = images[0].url;
  } else {
    // Plain text or unknown: use whatever text we got.
    pageText = main.bytes.toString("utf8").slice(0, config.maxPageTextChars);
    sources.push({ kind: "text", url: main.finalUrl, title: fileNameFromUrl(main.finalUrl), size: pageText.length });
  }

  if (!pdfs.length && !pageText.trim()) {
    throw new FetchError("The link returned no readable content. Try a direct link to the assembly-instructions PDF.");
  }
  if (warnings.length) log.warn("fetch warnings", warnings);

  return {
    url: url.toString(),
    finalUrl: main.finalUrl,
    pageTitle,
    pageDescription,
    pageText,
    pdfs,
    images,
    imageUrl,
    sources,
    warnings,
  };
}
