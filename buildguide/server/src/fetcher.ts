/**
 * Fetches the documentation behind a user-supplied link: the page itself, any
 * assembly-manual PDFs it links to, and a couple of product photos. Everything
 * here is best-effort — a product page with no PDF still yields usable context.
 */
import * as cheerio from "cheerio";
import { extractText } from "unpdf";
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
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
      (a === 192 && b === 0) || // 192.0.0.0/24 IETF protocol assignments
      (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224 // multicast and reserved, incl. 255.255.255.255
    );
  }
  const v6 = ip.toLowerCase();
  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) embed an IPv4 address: judge that.
  const embedded = embeddedIPv4(v6);
  if (embedded) return isPrivateAddress(embedded);
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

/** IPv4 address embedded in a NAT64 (64:ff9b::a.b.c.d / ::hhhh:hhhh) or 6to4 (2002:hhhh:hhhh::) address, if any. */
function embeddedIPv4(v6: string): string | null {
  const hextets = expandIPv6(v6);
  if (!hextets) return null;
  const toV4 = (hi: number, lo: number) => `${hi >>> 8}.${hi & 255}.${lo >>> 8}.${lo & 255}`;
  if (hextets[0] === 0x64 && hextets[1] === 0xff9b && hextets.slice(2, 6).every((h) => h === 0)) return toV4(hextets[6], hextets[7]);
  if (hextets[0] === 0x2002) return toV4(hextets[1], hextets[2]);
  return null;
}

/** Expand an IPv6 literal (with optional trailing dotted IPv4) into eight hextets. */
function expandIPv6(v6: string): number[] | null {
  if (!net.isIPv6(v6)) return null;
  let s = v6;
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4[1].split(".").map(Number);
    s = s.slice(0, -v4[1].length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const parts = s.split("::");
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length > 1 && parts[1] ? parts[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (parts.length === 1 && missing !== 0)) return null;
  const all = [...head, ...Array(parts.length > 1 ? missing : 0).fill("0"), ...tail];
  if (all.length !== 8) return null;
  return all.map((h) => parseInt(h || "0", 16));
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

/**
 * Synchronous half of the SSRF check (literal IPs and local names); used by the
 * create-project route for an early 400 and by assertPublicHost on every hop.
 * Returns true when the host is a public literal and needs no DNS check.
 */
export function assertPublicHostLiteral(url: URL): boolean {
  if (config.allowPrivateUrls) return true;
  const literal = hostIsPrivateLiteral(url.hostname);
  if (literal === true) throw new FetchError("Links to local or private network addresses are not allowed.");
  return literal === false;
}

/** Basic SSRF hygiene: refuse to fetch loopback/private hosts (unless explicitly allowed for local testing). */
async function assertPublicHost(url: URL): Promise<void> {
  if (assertPublicHostLiteral(url)) return;
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
/** Web pages are parsed synchronously; a few MB is more than any product page needs. */
const HTML_MAX_BYTES = 4 * 1024 * 1024;

/**
 * DNS resolution that refuses private addresses at connect time. assertPublicHost
 * checks the name first, but a rebinding host can answer public there and private
 * for the actual connection; pinning the check into the dialer closes that gap.
 */
function proxyEnv(): string | undefined {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
}

const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dnsCallback.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err, address, family);
    const addresses = Array.isArray(address) ? address.map((a) => a.address) : [address];
    if (!config.allowPrivateUrls && addresses.some((a) => typeof a === "string" && isPrivateAddress(a))) {
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
  // Direct connections resolve names through guardedLookup, which refuses
  // private addresses at connect time. Behind a proxy (HTTPS_PROXY / HTTP_PROXY)
  // EnvHttpProxyAgent hands `connect` to its internal no-proxy Agent, so hosts
  // dialled directly (NO_PROXY) are guarded; its ProxyAgents build their own
  // connector and ignore `connect`, so proxied hosts (and the proxy itself) are
  // resolved by the proxy, whose policy decides what it reaches.
  // assertPublicHost additionally rejects literal and local hosts on every hop.
  const connect = { lookup: guardedLookup };
  dispatcher = proxyEnv() ? new EnvHttpProxyAgent({ connect }) : new Agent({ connect });
  return dispatcher;
}

/** Raised when the caller's signal (project deleted) cancels a fetch. */
export class FetchCancelled extends FetchError {
  constructor() {
    super("Cancelled.");
    this.name = "FetchCancelled";
  }
}

interface FetchOptions {
  /** Reject web pages before reading the body and non-PDF bodies after the first chunk. */
  expectPdf?: boolean;
  /** Lower size cap applied once the response is known to be HTML (parsed synchronously). */
  htmlMaxBytes?: number;
}

/**
 * Fetch with manual redirect handling so every hop goes through the
 * private-host check (a public URL may 30x to an internal address).
 */
async function fetchBytes(url: string, maxBytes: number, accept = "*/*", signal?: AbortSignal, opts: FetchOptions = {}): Promise<Fetched> {
  if (signal?.aborted) throw new FetchCancelled();
  const ctrl = new AbortController();
  // Idle timeout (reset on every redirect hop and every received chunk) so a large
  // manual on a slow link is not cut off, plus a hard overall cap as a safety net.
  let timedOut: "idle" | "total" | null = null;
  let idleTimer: NodeJS.Timeout | undefined;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = "idle";
      ctrl.abort();
    }, config.fetchTimeoutMs);
  };
  const totalTimer = setTimeout(() => {
    timedOut = "total";
    ctrl.abort();
  }, config.fetchMaxTotalMs);
  resetIdle();
  // The timeouts and the caller's cancellation all abort the fetch.
  const combined = signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal;
  let current = new URL(url);
  try {
    for (let hop = 0; ; hop++) {
      resetIdle();
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
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      const mime = contentType.split(";")[0].trim();
      if (opts.expectPdf && (mime === "text/html" || mime === "application/xhtml+xml")) {
        // A web page where a manual was expected: don't buffer it at all.
        await res.body?.cancel().catch(() => {});
        throw new FetchError("The link was a web page, not a PDF.");
      }
      if (opts.htmlMaxBytes && (mime === "text/html" || mime === "application/xhtml+xml")) maxBytes = Math.min(maxBytes, opts.htmlMaxBytes);
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len && len > maxBytes) throw new FetchError(`File is too large (${(len / 1e6).toFixed(1)} MB).`);
      if (!res.body) throw new FetchError("Empty response.");
      const chunks: Uint8Array[] = [];
      let total = 0;
      let magicChecked = false;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        resetIdle();
        total += value.byteLength;
        if (total > maxBytes) {
          reader.cancel().catch(() => {});
          throw new FetchError(`File is too large (over ${(maxBytes / 1e6).toFixed(0)} MB).`);
        }
        chunks.push(value);
        if (opts.expectPdf && !magicChecked && total >= PDF_MAGIC_WINDOW + 4) {
          // Decide on the first kilobyte rather than after buffering up to the cap
          // (the header may sit anywhere in the first 1024 bytes). Shorter bodies
          // are judged by the caller's isPdf check once fully read.
          magicChecked = true;
          if (!isPdf(contentType, Buffer.concat(chunks))) {
            reader.cancel().catch(() => {});
            throw new FetchError("The link was not a PDF.");
          }
        }
      }
      return { finalUrl: current.toString(), contentType, bytes: Buffer.concat(chunks) };
    }
  } catch (e) {
    if (e instanceof FetchError) throw e;
    if (signal?.aborted) throw new FetchCancelled();
    const msg = e instanceof Error ? e.message : String(e);
    if (timedOut === "total") {
      throw new FetchError(`Gave up fetching the link after ${Math.round(config.fetchMaxTotalMs / 60_000)} minutes.`);
    }
    if (timedOut === "idle" || /abort/i.test(msg)) {
      throw new FetchError(`Timed out fetching the link (no data for ${Math.round(config.fetchTimeoutMs / 1000)} s).`);
    }
    // undici wraps network errors in a bare "fetch failed"; surface the real cause.
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code === "EPRIVATEADDR") throw new FetchError("Links to private network addresses are not allowed.");
    const detail = cause?.code || cause?.message;
    throw new FetchError(`Could not fetch the link (${detail ? `${msg}: ${detail}` : msg}).${detail === "ENOTFOUND" ? " Check the address and your network/proxy settings." : ""}`);
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
  }
}

/** The PDF spec allows the "%PDF-" header anywhere in the first 1024 bytes. */
export const PDF_MAGIC_WINDOW = 1024;

export function hasPdfMagic(bytes: Uint8Array): boolean {
  // The last valid start offset is 1023, so the 5-byte marker ends at byte 1027.
  return Buffer.from(bytes.subarray(0, PDF_MAGIC_WINDOW + 4)).toString("latin1").includes("%PDF-");
}

/**
 * Is this body a PDF? The magic bytes settle it; otherwise only an explicit
 * application/pdf content type counts (loadPdf then insists the text layer is
 * readable). A JSON or octet-stream error page at a .pdf URL is not a manual.
 */
export function isPdf(contentType: string, bytes: Uint8Array): boolean {
  if (hasPdfMagic(bytes)) return true;
  return contentType.split(";")[0].trim() === "application/pdf";
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
  // ... and from anywhere in the raw markup (embedded JSON, data attributes).
  // JSON serialisers escape slashes as \/ or \u002F, so undo that first.
  const unescaped = html.replace(/\\\//g, "/").replace(/\\u002f/gi, "/");
  const rawRe = /https?:\/\/[^\s"'<>)\\]+?\.pdf(?:\?[^\s"'<>)\\]*)?/gi;
  for (const m of unescaped.matchAll(rawRe)) {
    const url = abs(m[0]);
    if (url && !candidates.has(url)) addCandidate(url, "");
  }
  const relRe = /["'](\/[^\s"'<>\\]+?\.pdf(?:\?[^\s"'<>\\]*)?)["']/gi;
  for (const m of unescaped.matchAll(relRe)) {
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

const PDF_WORKER_TIMEOUT_MS = 60_000;
const PDF_WORKER_URL = new URL("./pdf-worker.js", import.meta.url);
// Under tsx (dev) the compiled worker script does not exist next to the .ts source.
const PDF_WORKER_AVAILABLE = fs.existsSync(fileURLToPath(PDF_WORKER_URL));
let workerAvailabilityLogged = false;
// Extractions run one at a time: a worker per PDF with a memory ceiling bounds
// the blast radius of a hostile file without a pool to manage.
let extractionQueue: Promise<unknown> = Promise.resolve();

/**
 * Run pdfjs text extraction off the main thread so a 30 MB manual does not stall
 * every other request. In-process extraction is used only when the worker script
 * is unavailable (running from TypeScript sources); a worker that times out,
 * crashes or runs out of memory fails the extraction instead of re-parsing the
 * same bytes on the event loop.
 */
function extractPdfText(bytes: Buffer): Promise<{ totalPages: number; text: string }> {
  const run = async () => {
    if (!PDF_WORKER_AVAILABLE) {
      if (!workerAvailabilityLogged) {
        workerAvailabilityLogged = true;
        log.warn("pdf worker script not built; extracting PDF text in-process (run `npm run build:server` for off-thread extraction)");
      }
      const r = await extractText(new Uint8Array(bytes), { mergePages: true });
      return { totalPages: r.totalPages, text: r.text || "" };
    }
    // Copy into a standalone ArrayBuffer so it can be transferred without touching
    // the caller's Buffer (which may share a larger pool slab).
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const worker = new Worker(PDF_WORKER_URL, {
      workerData: { buffer: ab },
      transferList: [ab],
      resourceLimits: { maxOldGenerationSizeMb: 1024 },
    });
    return new Promise<{ totalPages: number; text: string }>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        worker.terminate().catch(() => {});
        finish(() => reject(new Error(`PDF text extraction took longer than ${PDF_WORKER_TIMEOUT_MS / 1000} s`)));
      }, PDF_WORKER_TIMEOUT_MS);
      worker.once("message", (msg: { totalPages?: number; text?: string; error?: string }) => {
        finish(() => {
          if (msg.error !== undefined) reject(new Error(msg.error));
          else resolve({ totalPages: msg.totalPages ?? 0, text: msg.text ?? "" });
        });
      });
      worker.once("error", (err) => finish(() => reject(new Error(`PDF worker failed: ${err.message}`))));
      worker.once("exit", (code) => finish(() => reject(new Error(`PDF worker exited with code ${code}`))));
    });
  };
  const result = extractionQueue.then(run, run);
  extractionQueue = result.catch(() => undefined);
  return result;
}

async function loadPdf(url: string, bytes: Buffer, title: string, warnings: string[]): Promise<PdfDoc> {
  let pages = 0;
  let text = "";
  try {
    const result = await extractPdfText(bytes);
    pages = result.totalPages;
    text = (result.text || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  } catch (e) {
    // Claimed to be a PDF by content type but neither looks nor parses like one:
    // an error page in disguise. Skip it rather than hand garbage to Claude.
    if (!hasPdfMagic(bytes)) throw new FetchError(`${title} was not a readable PDF.`);
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

export interface SniffedImage {
  mediaType: ImageDoc["mediaType"];
  width?: number;
  height?: number;
}

/** Image dimensions from a JPEG's first SOF marker (undefined when none is found before the scan data). */
function jpegDimensions(b: Buffer): { width?: number; height?: number } {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xda) break; // start of scan: no frame header found
    const len = b.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return {};
}

/**
 * Identify an image by its magic bytes (never by the URL or the declared type)
 * and read its pixel size where the format makes that cheap (PNG, JPEG, GIF).
 */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length < 12) return null;
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mediaType: "image/jpeg", ...jpegDimensions(b) };
  if (b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") {
    const dims = b.length >= 24 && b.toString("latin1", 12, 16) === "IHDR" ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : {};
    return { mediaType: "image/png", ...dims };
  }
  if (b.toString("latin1", 0, 4) === "GIF8") return { mediaType: "image/gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return { mediaType: "image/webp" };
  return null;
}

/** API limits: 5 MB per image and 8000 px on either side; stay under both. */
const MAX_IMAGE_BYTES = Math.floor(4.5 * 1024 * 1024);
const MAX_IMAGE_DIM = 8000;

/** Best-effort: anything that is not plainly a usable image is skipped, never fatal. */
async function fetchImage(url: string, signal?: AbortSignal): Promise<ImageDoc | null> {
  try {
    const f = await fetchBytes(url, MAX_IMAGE_BYTES, "image/*", signal);
    if (f.bytes.length < 2000) return null;
    const sniffed = sniffImage(f.bytes);
    if (!sniffed) return null;
    // The declared type may be absent or generic (octet-stream, text/plain from a
    // misconfigured CDN); the magic bytes decide. Only a declared *image* type that
    // disagrees with the bytes is treated as suspicious.
    const declared = f.contentType.split(";")[0].trim();
    const declaredOk =
      !declared.startsWith("image/") || declared === sniffed.mediaType || (declared === "image/jpg" && sniffed.mediaType === "image/jpeg");
    if (!declaredOk) return null;
    if ((sniffed.width ?? 0) > MAX_IMAGE_DIM || (sniffed.height ?? 0) > MAX_IMAGE_DIM) return null;
    return { url, mediaType: sniffed.mediaType, bytes: f.bytes };
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
  const main = await fetchBytes(url.toString(), config.maxPdfBytes + 2 * 1024 * 1024, "text/html,application/pdf,*/*", signal, { htmlMaxBytes: HTML_MAX_BYTES });

  let pageTitle = "";
  let pageDescription = "";
  let pageText = "";
  let imageUrl: string | undefined;

  if (isPdf(main.contentType, main.bytes)) {
    onProgress("Reading the manual PDF…");
    const pdf = await loadPdf(main.finalUrl, main.bytes, fileNameFromUrl(main.finalUrl), warnings);
    pdfs.push(pdf);
    pageTitle = pdf.title;
    sources.push({ kind: "pdf", url: main.finalUrl, title: pdf.title, size: pdf.bytes.length, pages: pdf.pages });
  } else if (main.contentType.includes("html") || /<!doctype|<html|<head|<body/.test(main.bytes.subarray(0, 4096).toString("utf8").toLowerCase())) {
    onProgress("Reading the product page…");
    const page = parseHtml(main.bytes.toString("utf8"), main.finalUrl);
    pageTitle = page.title;
    pageDescription = page.description;
    pageText = page.text.length > config.maxPageTextChars ? page.text.slice(0, config.maxPageTextChars) + "\n…[truncated]" : page.text;
    imageUrl = page.ogImage;
    sources.push({ kind: "html", url: main.finalUrl, title: page.title || main.finalUrl, size: page.text.length });

    // Download the most promising manuals in rank order (parseHtml already
    // filtered and ranked them), stopping as soon as two real PDFs are in hand.
    // expectPdf makes fetchBytes drop web pages and non-PDF bodies on the first
    // bytes, so a wrong candidate never gets buffered to the size cap.
    const MAX_ATTEMPTS = 4;
    const MAX_PDFS = 2;
    const attempts = page.pdfCandidates.slice(0, MAX_ATTEMPTS);
    for (const [i, cand] of attempts.entries()) {
      if (pdfs.length >= MAX_PDFS) break;
      onProgress(`Downloading manual ${pdfs.length + 1}/${Math.min(MAX_PDFS, attempts.length)}: ${fileNameFromUrl(cand.url)}${i > pdfs.length ? ` (candidate ${i + 1})` : ""}`);
      try {
        const f = await fetchBytes(cand.url, config.maxPdfBytes, "application/pdf,*/*", signal, { expectPdf: true });
        if (!isPdf(f.contentType, f.bytes)) {
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
    // Plain text or unknown. Images and other binaries are not documentation.
    if (sniffImage(main.bytes)) throw new FetchError("That link is an image, not a manual. Paste the product page or the instructions PDF instead.");
    const decoded = main.bytes.toString("utf8").slice(0, config.maxPageTextChars);
    const garbage = (decoded.match(/\uFFFD/g) ?? []).length;
    if (decoded.length && garbage / decoded.length > 0.02) {
      throw new FetchError("The link returned binary content rather than a page or a PDF.");
    }
    pageText = decoded;
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
