import express, { type Request, type Response, type NextFunction } from "express";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { log } from "./logger.js";
import { SseWriter } from "./sse.js";
import {
  deleteProject,
  getProject,
  isDeleted,
  listProjects,
  onProjectChange,
  readManual,
  saveManual,
  saveProject,
  summarize,
  touchProject,
} from "./store.js";
import { FetchError, gatherDocumentation } from "./fetcher.js";
import { createPlanner } from "./planner.js";
import { runClaudeChat, runMockChat, type ChatContext } from "./chat.js";
import { SAMPLE_PLANS, findSample } from "../../shared/samples/index.js";
import { normalizePlan } from "../../shared/plan.js";
import type { ChatMessage, Project } from "../../shared/project.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

const planner = createPlanner();

// ---------------------------------------------------------------------------
// Config & listing

app.get("/api/config", (_req, res) => {
  res.json({
    hasApiKey: config.hasApiKey,
    mock: config.mock,
    liveGeneration: config.hasApiKey || config.mock,
    allowPrivateUrls: config.allowPrivateUrls,
    model: config.model,
    effort: config.effort,
    samples: SAMPLE_PLANS.map((s) => ({ id: s.id, title: s.title, blurb: s.blurb, steps: s.plan.steps.length, category: s.plan.product.category })),
  });
});

app.get("/api/projects", async (_req, res) => {
  res.json(await listProjects());
});

// ---------------------------------------------------------------------------
// Create from a link

app.post("/api/projects", async (req, res) => {
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  const notes = typeof req.body?.notes === "string" ? req.body.notes.slice(0, 2000) : "";
  if (!url) return res.status(400).json({ error: "Paste a link to the product page or its assembly manual." });
  if (!config.hasApiKey && !config.mock) {
    return res.status(503).json({
      error: "No ANTHROPIC_API_KEY is configured, so new links can't be analysed. Try a sample project, or set the key and restart.",
    });
  }
  const now = new Date().toISOString();
  const project: Project = {
    id: randomUUID().slice(0, 12),
    url,
    notes,
    createdAt: now,
    updatedAt: now,
    status: "queued",
    progress: "Queued…",
    sources: [],
  };
  await saveProject(project);
  void runPipeline(project);
  res.status(202).json({ id: project.id });
});

// Create from a bundled sample (works without an API key)
app.post("/api/projects/sample", async (req, res) => {
  const sample = findSample(String(req.body?.sampleId ?? ""));
  if (!sample) return res.status(404).json({ error: "Unknown sample." });
  const now = new Date().toISOString();
  const project: Project = {
    id: randomUUID().slice(0, 12),
    url: sample.url,
    notes: "",
    createdAt: now,
    updatedAt: now,
    status: "ready",
    progress: "Ready",
    sources: [{ kind: "text", url: sample.url, title: `${sample.title} (built-in sample)`, size: 0 }],
    plan: normalizePlan(sample.plan),
    demo: true,
  };
  await saveProject(project);
  res.status(201).json({ id: project.id });
});

/** Thrown inside the pipeline when the user deleted the project mid-flight. */
class ProjectDeleted extends Error {
  constructor() {
    super("project deleted");
  }
}

async function runPipeline(project: Project): Promise<void> {
  const checkAlive = () => {
    if (isDeleted(project.id)) throw new ProjectDeleted();
  };
  const update = async (patch: Partial<Project>, persist = false) => {
    checkAlive();
    Object.assign(project, patch);
    if (persist) await saveProject(project);
    else touchProject(project);
  };
  try {
    await update({ status: "fetching", progress: "Fetching the link…" });
    const gathered = await gatherDocumentation(project.url, (message) => {
      if (!isDeleted(project.id)) void update({ progress: message });
    });
    checkAlive();
    for (const [i, pdf] of gathered.pdfs.entries()) await saveManual(project.id, i, pdf.bytes);
    await update({ sources: gathered.sources, imageUrl: gathered.imageUrl, status: "analyzing", progress: "Analysing the documentation…" }, true);

    const result = await planner.generate(gathered, project.notes, (message, chars) => {
      if (!isDeleted(project.id)) void update({ progress: message, progressChars: chars });
    });
    checkAlive();
    for (const [i, sent] of result.sentAsDocument.entries()) {
      const src = project.sources.filter((s) => s.kind === "pdf")[i];
      if (src) src.sentAsDocument = sent;
    }
    await update({ status: "ready", progress: "Ready", plan: result.plan, usage: result.usage, progressChars: undefined }, true);
    log.info(`project ${project.id} ready: ${result.plan.product.name}`);
  } catch (err) {
    if (err instanceof ProjectDeleted || isDeleted(project.id)) {
      log.info(`project ${project.id} was deleted while it was being built; stopping.`);
      return;
    }
    const message = err instanceof FetchError ? err.message : err instanceof Error ? err.message : String(err);
    log.error(`project ${project.id} failed:`, message);
    await update({ status: "error", error: message, progress: "Failed" }, true).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Read / watch / delete

app.get("/api/projects/:id", async (req, res) => {
  const p = await getProject(req.params.id);
  if (!p) return res.status(404).json({ error: "Project not found." });
  res.json(p);
});

app.get("/api/projects/:id/events", async (req, res) => {
  const p = await getProject(req.params.id);
  if (!p) return res.status(404).json({ error: "Project not found." });
  const sse = new SseWriter(res);
  const send = (proj: Project) => {
    sse.send("status", summarize(proj));
    if (proj.status === "ready" || proj.status === "error") {
      setTimeout(() => sse.end(), 50);
    }
  };
  send(p);
  const off = onProjectChange(p.id, send);
  const ping = setInterval(() => sse.comment("ping"), 15000);
  res.on("close", () => {
    off();
    clearInterval(ping);
  });
});

app.delete("/api/projects/:id", async (req, res) => {
  const ok = await deleteProject(req.params.id);
  res.status(ok ? 204 : 404).end();
});

app.get("/api/projects/:id/manual/:index", async (req, res) => {
  const idx = Number(req.params.index);
  if (!Number.isInteger(idx) || idx < 0) return res.status(400).end();
  const bytes = await readManual(req.params.id, idx);
  if (!bytes) return res.status(404).json({ error: "Manual not found." });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="manual-${idx}.pdf"`);
  res.send(bytes);
});

// ---------------------------------------------------------------------------
// Chat (SSE over POST)

app.post("/api/projects/:id/chat", async (req, res) => {
  const p = await getProject(req.params.id);
  if (!p || !p.plan) return res.status(404).json({ error: "Project not ready." });
  const rawMessages = Array.isArray(req.body?.messages) ? (req.body.messages as unknown[]) : [];
  const history: ChatMessage[] = rawMessages
    .map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>) : {}))
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role as ChatMessage["role"], content: (m.content as string).slice(0, 8000) }));
  if (!history.length || history[history.length - 1].role !== "user") {
    return res.status(400).json({ error: "Send at least one user message." });
  }
  const stepIndex = Math.max(0, Math.min(p.plan.steps.length - 1, Number(req.body?.stepIndex ?? 0) || 0));

  const sse = new SseWriter(res);
  const ctx: ChatContext = { plan: p.plan, history, stepIndex };
  const useClaude = config.hasApiKey && !config.mock && !p.demo;
  if (useClaude && config.chatIncludesManual) {
    const pdfIndex = p.sources.findIndex((s) => s.kind === "pdf" && s.sentAsDocument !== false);
    if (pdfIndex >= 0) {
      const pdfOrdinal = p.sources.filter((s) => s.kind === "pdf").findIndex((s) => s === p.sources[pdfIndex]);
      const bytes = await readManual(p.id, pdfOrdinal);
      // Same payload rule as the planner: a PDF that doesn't fit the request stays out.
      if (bytes && bytes.length <= config.maxAttachPdfBytes) ctx.manual = { title: p.sources[pdfIndex].title, bytes };
    }
  }
  try {
    if (useClaude) await runClaudeChat(ctx, (ev) => sse.data(ev));
    else await runMockChat(ctx, (ev) => sse.data(ev));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("chat failed:", message);
    sse.data({ type: "error", message });
  } finally {
    sse.end();
  }
});

// ---------------------------------------------------------------------------
// Static client (production build)

const candidates = [path.resolve(here, "../../../web/dist"), path.resolve(here, "../../web/dist"), path.resolve(process.cwd(), "web/dist")];
const webDist = candidates.find((d) => fs.existsSync(path.join(d, "index.html")));
if (webDist) {
  app.use(express.static(webDist, { index: false, maxAge: "1h" }));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(webDist, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res.type("text").send("BuildGuide API is running. Start the client with `npm run dev:web` or build it with `npm run build`.");
  });
}

app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  log.error("unhandled:", message);
  if (!res.headersSent) res.status(500).json({ error: message });
});

app.listen(config.port, () => {
  const mode = config.mock ? "MOCK (canned plans)" : config.hasApiKey ? `live (${config.model}, effort ${config.effort})` : "demo (no API key: samples only)";
  log.info(`BuildGuide server on http://localhost:${config.port} — mode: ${mode}`);
  log.info(`data dir: ${config.dataDir}${webDist ? `, serving client from ${webDist}` : ", client not built (use npm run dev)"}`);
});
