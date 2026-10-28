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
