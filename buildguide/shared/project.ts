import type { AssemblyPlan } from "./plan.js";

export type ProjectStatus = "queued" | "fetching" | "analyzing" | "ready" | "error";

export interface SourceDoc {
  kind: "pdf" | "html" | "text";
  url: string;
  title: string;
  /** Bytes for pdf, characters for text/html. */
  size: number;
  pages?: number;
  /** Whether the raw PDF was handed to Claude (as opposed to extracted text only). */
  sentAsDocument?: boolean;
}

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
}

export interface Project {
  id: string;
  url: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  status: ProjectStatus;
  /** Human-readable progress line while not ready. */
  progress: string;
  /** Approximate characters of plan JSON generated so far (while analyzing). */
  progressChars?: number;
  error?: string;
  sources: SourceDoc[];
  imageUrl?: string;
  plan?: AssemblyPlan;
  usage?: Usage;
  demo?: boolean;
}

/** Shape of the public summary returned by GET /api/projects. */
export interface ProjectSummary {
  id: string;
  url: string;
  status: ProjectStatus;
  name: string;
  createdAt: string;
  demo?: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** UI actions the assistant can trigger from chat (mirrors the tools in server/src/chat.ts). */
export type UiAction =
  | { name: "go_to_step"; input: { step: number } }
  | { name: "highlight_parts"; input: { instanceIds: string[] } }
  | { name: "set_view"; input: { view: string } }
  | { name: "set_exploded"; input: { enabled: boolean } };

/** Server-sent events emitted by POST /api/projects/:id/chat */
export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "action"; action: UiAction }
  | { type: "done"; text: string; usage?: Partial<Usage> }
  | { type: "error"; message: string };

/**
 * Index, among the PDF sources, of the document most likely to be the assembly
 * manual: prefer PDFs that were handed to Claude, then the one with most pages.
 * Returns -1 when the project has no PDF. Used by both the chat route and the
 * step card so the assistant and the "Manual p.N" links agree.
 */
/** PDF sources in order; the index in this list matches the stored manual-N.pdf file. */
export function pdfSources(sources: SourceDoc[]): SourceDoc[] {
  return sources.filter((s) => s.kind === "pdf");
}

export function pickManualIndex(sources: SourceDoc[], opts: { attachedOnly?: boolean } = {}): number {
  const pdfs = pdfSources(sources);
  if (!pdfs.length) return -1;
  const eligible = pdfs.filter((s) => s.sentAsDocument !== false);
  // attachedOnly: callers that will send the PDF to Claude must not fall back to
  // a document the planner deliberately did not attach (too large or too long).
  if (!eligible.length && opts.attachedOnly) return -1;
  const pool = eligible.length ? eligible : pdfs;
  let best = pool[0];
  for (const s of pool) if ((s.pages ?? 0) > (best.pages ?? 0)) best = s;
  return pdfs.indexOf(best);
}

export interface PdfAttachLimits {
  /** Largest raw PDF, in bytes, that may be sent to Claude as a document. */
  maxAttachPdfBytes: number;
  /** Largest page count that may be sent as a document. */
  maxPdfPages: number;
}

/**
 * Single source of truth for "may this PDF be handed to Claude as a document":
 * used by the planner when building the analysis request and by the chat route
 * when attaching the manual, so both sides always agree.
 */
export function canAttachPdf(bytes: number, pages: number | undefined, limits: PdfAttachLimits): boolean {
  if (bytes <= 0 || bytes > limits.maxAttachPdfBytes) return false;
  // An unknown page count (pdfjs could not parse a file that still carries the
  // %PDF magic) is attached: Claude's reader is more tolerant than pdfjs.
  if (pages === undefined || pages <= 0) return true;
  return pages <= limits.maxPdfPages;
}
