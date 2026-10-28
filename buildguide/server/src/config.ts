import path from "node:path";

// Load a local .env if present (Node >= 21.7). Never throws when the file is missing.
try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.();
} catch {
  /* no .env file */
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

function effort(v: string | undefined): Effort {
  return (EFFORTS as readonly string[]).includes(v ?? "") ? (v as Effort) : "high";
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  dataDir: path.resolve(process.env.BUILDGUIDE_DATA_DIR ?? "./data"),
  model: process.env.BUILDGUIDE_MODEL ?? "claude-opus-5-5",
  effort: effort(process.env.BUILDGUIDE_EFFORT),
  chatEffort: effort(process.env.BUILDGUIDE_CHAT_EFFORT ?? "low"),
  mock: process.env.MOCK_CLAUDE === "1" || process.env.MOCK_CLAUDE === "true",
  hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  /** Hand the manual PDF to Claude in chat too (cached), so it can answer "where does part F go?" */
  chatIncludesManual: process.env.BUILDGUIDE_CHAT_MANUAL !== "0",
  /** Allow links to localhost / private networks (for testing against a local web server). */
  allowPrivateUrls: process.env.BUILDGUIDE_ALLOW_PRIVATE_URLS === "1",
  maxPdfBytes: 30 * 1024 * 1024,
  maxPdfPages: 150,
  maxPageTextChars: 40_000,
  maxPdfTextChars: 60_000,
  fetchTimeoutMs: 25_000,
};

export type AppConfig = typeof config;
