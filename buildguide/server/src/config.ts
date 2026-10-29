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
type Effort = (typeof EFFORTS)[number];

function effort(v: string | undefined): Effort {
  return (EFFORTS as readonly string[]).includes(v ?? "") ? (v as Effort) : "high";
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
  port: Number(process.env.PORT ?? 8787),
  dataDir: path.resolve(process.env.BUILDGUIDE_DATA_DIR ?? "./data"),
  model: process.env.BUILDGUIDE_MODEL ?? "claude-opus-5-5",
  effort: effort(process.env.BUILDGUIDE_EFFORT),
  chatEffort: effort(process.env.BUILDGUIDE_CHAT_EFFORT ?? "low"),
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
  maxPdfPages: 150,
  maxPageTextChars: 40_000,
  maxPdfTextChars: 60_000,
  fetchTimeoutMs: 25_000,
};

export type AppConfig = typeof config;
