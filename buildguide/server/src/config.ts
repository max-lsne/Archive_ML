import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Load a local .env if present (Node >= 21.7). Never throws when the file is missing.
try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.();
} catch {
  /* no .env file */
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Parse an effort level from the environment; unknown values fall back loudly, never silently upward. */
export function parseEffort(v: string | undefined, fallback: Effort, name = "effort"): Effort {
  if (v === undefined || v === "") return fallback;
  if ((EFFORTS as readonly string[]).includes(v)) return v as Effort;
  console.warn(`[config] ignoring unknown ${name} "${v}" (expected one of ${EFFORTS.join(", ")}); using "${fallback}"`);
  return fallback;
}

/**
 * Mirror of the Anthropic SDK's on-disk profile lookup (core/credentials):
 * `<config_dir>/configs/<profile>.json`, where config_dir is ANTHROPIC_CONFIG_DIR,
 * else %APPDATA%/Anthropic on Windows, else $XDG_CONFIG_HOME/anthropic, else
 * ~/.config/anthropic; the profile is ANTHROPIC_PROFILE, else the name in
 * `<config_dir>/active_config`, else "default". Created by `ant auth login`.
 */
export function hasProfileCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  let dir: string | undefined = env.ANTHROPIC_CONFIG_DIR;
  if (!dir) {
    if (process.platform === "win32") {
      if (env.APPDATA) dir = path.join(env.APPDATA, "Anthropic");
      else if (env.USERPROFILE) dir = path.join(env.USERPROFILE, "AppData", "Roaming", "Anthropic");
    } else if (env.XDG_CONFIG_HOME) dir = path.join(env.XDG_CONFIG_HOME, "anthropic");
    else {
      const home = env.HOME || os.homedir();
      if (home) dir = path.join(home, ".config", "anthropic");
    }
  }
  if (!dir) return false;
  let profile = env.ANTHROPIC_PROFILE;
  if (!profile) {
    try {
      profile = fs.readFileSync(path.join(dir, "active_config"), "utf8").trim() || "default";
    } catch {
      profile = "default";
    }
  }
  try {
    return fs.statSync(path.join(dir, "configs", `${profile}.json`)).isFile();
  } catch {
    return false;
  }
}

export const config = {
  /** Interface to bind. Loopback by default: the API has no auth and can spend API credits. */
  host: process.env.HOST || "127.0.0.1",
  port: parsePositiveInt(process.env.PORT, 8787, "PORT"),
  dataDir: path.resolve(process.env.BUILDGUIDE_DATA_DIR ?? "./data"),
  model: process.env.BUILDGUIDE_MODEL ?? "claude-opus-5-5",
  effort: parseEffort(process.env.BUILDGUIDE_EFFORT, "high", "BUILDGUIDE_EFFORT"),
  chatEffort: parseEffort(process.env.BUILDGUIDE_CHAT_EFFORT, "low", "BUILDGUIDE_CHAT_EFFORT"),
  mock: process.env.MOCK_CLAUDE === "1" || process.env.MOCK_CLAUDE === "true",
  /** Claude is reachable: an API key / auth token in the environment, or an `ant auth login` profile on disk. */
  hasCredentials: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) || hasProfileCredentials(),
  /** Hand the manual PDF to Claude in chat too (cached), so it can answer "where does part F go?" */
  chatIncludesManual: process.env.BUILDGUIDE_CHAT_MANUAL !== "0",
  /** Allow links to localhost / private networks (for testing against a local web server). */
  allowPrivateUrls: process.env.BUILDGUIDE_ALLOW_PRIVATE_URLS === "1",
  maxPdfBytes: 30 * 1024 * 1024,
  /** Largest raw PDF handed to Claude as a document block (base64 expands it by 4/3). */
  maxAttachPdfBytes: 20 * 1024 * 1024,
  /** Budget for all base64 document/image payload in one request (API limit is 32 MB total). */
  maxRequestBytes: 28 * 1024 * 1024,
  /**
   * Longest PDF handed to Claude as a document. The API accepts up to 600 pages
   * on 1M-context models (the default claude-opus-5-5) but only 100 on 200K-context
   * models, so lower this (BUILDGUIDE_MAX_PDF_PAGES) when BUILDGUIDE_MODEL is a 200K model.
   */
  maxPdfPages: parsePositiveInt(process.env.BUILDGUIDE_MAX_PDF_PAGES, 150, "BUILDGUIDE_MAX_PDF_PAGES"),
  maxPageTextChars: 40_000,
  maxPdfTextChars: 60_000,
  /** Idle timeout for a fetch: abort when no bytes arrive for this long. */
  fetchTimeoutMs: 25_000,
  /** Hard cap on one fetch (all redirects plus the body), however steady the trickle. */
  fetchMaxTotalMs: 4 * 60_000,
};

export function parsePositiveInt(v: string | undefined, fallback: number, name: string): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (Number.isInteger(n) && n > 0) return n;
  console.warn(`[config] ignoring invalid ${name} "${v}" (expected a positive integer); using ${fallback}`);
  return fallback;
}

export type AppConfig = typeof config;
