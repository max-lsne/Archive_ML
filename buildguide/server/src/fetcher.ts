/**
 * Fetches the documentation behind a user-supplied link: the page itself, any
 * assembly-manual PDFs it links to, and a couple of product photos. Everything
 * here is best-effort — a product page with no PDF still yields usable context.
 */
import * as cheerio from "cheerio";
import { extractText } from "unpdf";
import dns from "node:dns/promises";
import net from "node:net";
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
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:/i.test(s)) {
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

function isPrivateAddress(ip: string): boolean {
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
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("::ffff:");
}

/** Basic SSRF hygiene: refuse to fetch loopback/private hosts (unless explicitly allowed for local testing). */
async function assertPublicHost(url: URL): Promise<void> {
  if (config.allowPrivateUrls) return;
  const host = url.hostname;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new FetchError("Links to local or private hosts are not allowed.");
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new FetchError("Links to private network addresses are not allowed.");
    return;
  }
  try {
    const addrs = await dns.lookup(host, { all: true });
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

async function fetchBytes(url: string, maxBytes: number, accept = "*/*"): Promise<Fetched> {
  await assertPublicHost(new URL(url));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.fetchTimeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: accept,
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
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
      finalUrl: res.url || url,
      contentType: (res.headers.get("content-type") ?? "").toLowerCase(),
      bytes: Buffer.concat(chunks),
    };
  } catch (e) {
    if (e instanceof FetchError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (/abort/i.test(msg)) throw new FetchError("Timed out fetching the link.");
    // undici wraps network errors in a bare "fetch failed"; surface the real cause.
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code || cause?.message;
    throw new FetchError(`Could not fetch the link (${detail ? `${msg}: ${detail}` : msg}).${detail === "ENOTFOUND" ? " Check the address and your network/proxy settings." : ""}`);
  } finally {
    clearTimeout(timer);
  }
}

function isPdf(contentType: string, bytes: Buffer, url: string): boolean {
  if (contentType.includes("application/pdf")) return true;
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return true;
  return /\.pdf(\?|#|$)/i.test(url) && !contentType.includes("text/html");
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
  if (/\.pdf(\?|#|$)/.test(u)) score += 2;
  if (POSITIVE.test(t)) score += 5;
  if (POSITIVE.test(u)) score += 4;
  if (/assembly[_-]?instructions|\/aa-\d{5,}|aa-\d{5,}/.test(u)) score += 6; // IKEA style
  if (NEGATIVE.test(t)) score -= 4;
  if (NEGATIVE.test(u)) score -= 3;
  return score;
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

  // PDF candidates from anchors
  const candidates = new Map<string, PdfCandidate>();
  const addCandidate = (url: string | null, text: string) => {
    if (!url) return;
    const score = scorePdfCandidate(url, text);
    const prev = candidates.get(url);
    if (!prev || prev.score < score) candidates.set(url, { url, text: text.slice(0, 120), score });
  };
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().replace(/\s+/g, " ").trim() || $(el).attr("aria-label") || $(el).attr("title") || "";
    const url = abs(href);
    if (!url) return;
    if (/\.pdf(\?|#|$)/i.test(url) || POSITIVE.test(text)) addCandidate(url, text);
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
  const pdfCandidates = [...candidates.values()].filter((c) => /\.pdf(\?|#|$)/i.test(c.url) || c.score >= 5).sort((a, b) => b.score - a.score);

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

async function fetchImage(url: string): Promise<ImageDoc | null> {
  try {
    const f = await fetchBytes(url, 6 * 1024 * 1024, "image/*");
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
  } catch {
    return null;
  }
}

/**
 * Gather everything we can about the product behind `input`.
 */
export async function gatherDocumentation(
  input: string,
  onProgress: (message: string) => void,
): Promise<Gathered> {
  const url = normalizeUrl(input);
  const warnings: string[] = [];
  const sources: SourceDoc[] = [];
  const pdfs: PdfDoc[] = [];
  const images: ImageDoc[] = [];

  onProgress(`Fetching ${url.hostname}…`);
  const main = await fetchBytes(url.toString(), config.maxPdfBytes + 2 * 1024 * 1024, "text/html,application/pdf,*/*");

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

    // Download the most promising manuals (at most two, distinct hosts allowed).
    const picks = page.pdfCandidates.filter((c) => c.score > 0).slice(0, 2);
    if (page.pdfCandidates.length && !picks.length) picks.push(page.pdfCandidates[0]);
    for (const [i, cand] of picks.entries()) {
      onProgress(`Downloading manual ${i + 1}/${picks.length}: ${fileNameFromUrl(cand.url)}`);
      try {
        const f = await fetchBytes(cand.url, config.maxPdfBytes, "application/pdf,*/*");
        if (!isPdf(f.contentType, f.bytes, f.finalUrl)) {
          warnings.push(`${fileNameFromUrl(cand.url)} was not a PDF.`);
          continue;
        }
        const pdf = await loadPdf(f.finalUrl, f.bytes, cand.text || fileNameFromUrl(f.finalUrl), warnings);
        pdfs.push(pdf);
        sources.push({ kind: "pdf", url: f.finalUrl, title: pdf.title, size: pdf.bytes.length, pages: pdf.pages });
      } catch (e) {
        warnings.push(`Could not download ${fileNameFromUrl(cand.url)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // A few product photos help Claude understand the finished object.
    const imgUrls = [page.ogImage, ...page.imageCandidates].filter((u): u is string => Boolean(u));
    const seen = new Set<string>();
    for (const u of imgUrls) {
      if (images.length >= 3) break;
      if (seen.has(u)) continue;
      seen.add(u);
      const img = await fetchImage(u);
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
