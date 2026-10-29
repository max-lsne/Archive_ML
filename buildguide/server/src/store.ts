import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { config } from "./config.js";
import type { Project, ProjectSummary } from "../../shared/project.js";

const projects = new Map<string, Project>();
/** Lightweight listing entries, so GET /api/projects never re-parses every stored plan. */
const summaries = new Map<string, ProjectSummary>();
/** Ids deleted while a pipeline may still be running; writes for them are dropped. */
const tombstones = new Set<string>();
/** Abort controllers of pipelines still running, so a delete can stop their network and model calls. */
const pipelines = new Map<string, AbortController>();
const emitter = new EventEmitter();
emitter.setMaxListeners(200);

export function isDeleted(id: string): boolean {
  return tombstones.has(id);
}

export function registerPipeline(id: string, controller: AbortController): void {
  pipelines.set(id, controller);
}

/** Called from the pipeline's finally: no more writes can follow, so its tombstone can go too. */
export function unregisterPipeline(id: string): void {
  pipelines.delete(id);
  tombstones.delete(id);
}

function projectDir(id: string): string {
  return path.join(config.dataDir, "projects", id);
}

function projectFile(id: string): string {
  return path.join(projectDir(id), "project.json");
}

export function isValidId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{4,64}$/.test(id);
}

function toSummary(p: Project): ProjectSummary {
  return {
    id: p.id,
    url: p.url,
    status: p.status,
    name: p.plan?.product.name ?? p.url,
    createdAt: p.createdAt,
    demo: p.demo,
  };
}

/** Persist a project. Returns false (and writes nothing) if it was deleted meanwhile. */
export async function saveProject(p: Project): Promise<boolean> {
  if (tombstones.has(p.id)) return false;
  p.updatedAt = new Date().toISOString();
  projects.set(p.id, p);
  summaries.set(p.id, toSummary(p));
  emitter.emit(`project:${p.id}`, p);
  await fs.mkdir(projectDir(p.id), { recursive: true });
  const tmp = projectFile(p.id) + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(p, null, 2));
  if (tombstones.has(p.id)) {
    // Deleted while we were writing: don't leave the directory behind.
    await fs.rm(projectDir(p.id), { recursive: true, force: true }).catch(() => {});
    return false;
  }
  await fs.rename(tmp, projectFile(p.id));
  if (tombstones.has(p.id)) {
    // A delete raced the rename: its rm may have listed the directory before the
    // file landed, so remove it again.
    await fs.rm(projectDir(p.id), { recursive: true, force: true }).catch(() => {});
    return false;
  }
  return true;
}

/** Update in-memory state and notify listeners without hitting disk (for frequent progress ticks). */
export function touchProject(p: Project): boolean {
  if (tombstones.has(p.id)) return false;
  p.updatedAt = new Date().toISOString();
  projects.set(p.id, p);
  summaries.set(p.id, toSummary(p));
  emitter.emit(`project:${p.id}`, p);
  return true;
}

/** Read a project file without touching the in-memory cache. */
async function readProjectFile(id: string): Promise<Project | undefined> {
  try {
    const raw = await fs.readFile(projectFile(id), "utf8");
    const p = JSON.parse(raw) as Project;
    // A project interrupted mid-generation by a restart can never finish.
    if (p.status !== "ready" && p.status !== "error") {
      p.status = "error";
      p.error = "The server restarted while this project was being analysed. Please create it again.";
    }
    return p;
  } catch {
    return undefined;
  }
}

export async function getProject(id: string): Promise<Project | undefined> {
  if (!isValidId(id) || tombstones.has(id)) return undefined;
  const cached = projects.get(id);
  if (cached) return cached;
  const p = await readProjectFile(id);
  if (p) {
    projects.set(id, p);
    summaries.set(id, toSummary(p));
  }
  return p;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const dir = path.join(config.dataDir, "projects");
  let ids: string[] = [];
  try {
    ids = (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    /* no data yet */
  }
  // Serve from the summary cache; only ids never seen since startup hit the disk,
  // and their full plan is parsed once to fill the cache, not kept in memory.
  const out = await Promise.all(
    ids
      .filter((id) => isValidId(id) && !tombstones.has(id))
      .map(async (id): Promise<ProjectSummary | undefined> => {
        const cached = summaries.get(id);
        if (cached) return cached;
        const live = projects.get(id);
        if (live) {
          const summary = toSummary(live);
          summaries.set(id, summary);
          return summary;
        }
        const p = await readProjectFile(id);
        if (!p) return undefined;
        const summary = toSummary(p);
        summaries.set(id, summary);
        return summary;
      }),
  );
  const list = out.filter((s): s is ProjectSummary => Boolean(s));
  list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return list;
}

export async function deleteProject(id: string): Promise<boolean> {
  if (!isValidId(id)) return false;
  const current = projects.get(id) ?? (await readProjectFile(id));
  const existed = Boolean(current);
  // A tombstone only matters while a pipeline may still write; it is removed when
  // that pipeline unregisters. Deleting unknown ids must not grow the set.
  const pipeline = pipelines.get(id);
  if (pipeline) tombstones.add(id);
  projects.delete(id);
  summaries.delete(id);
  // Stop a pipeline that is still fetching or waiting on Claude: no point paying for a discarded plan.
  pipeline?.abort();
  // Let open /events streams finish instead of pinging a deleted project forever.
  if (current) {
    emitter.emit(`project:${id}`, { ...current, status: "error", error: "Project deleted", progress: "Deleted", plan: undefined } satisfies Project);
  }
  try {
    await fs.rm(projectDir(id), { recursive: true, force: true });
    return existed;
  } catch {
    return false;
  }
}

export function onProjectChange(id: string, cb: (p: Project) => void): () => void {
  const key = `project:${id}`;
  emitter.on(key, cb);
  return () => emitter.off(key, cb);
}

export async function saveManual(id: string, index: number, bytes: Buffer): Promise<string | undefined> {
  if (tombstones.has(id)) return undefined;
  await fs.mkdir(projectDir(id), { recursive: true });
  const file = path.join(projectDir(id), `manual-${index}.pdf`);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, bytes);
  if (tombstones.has(id)) {
    // Deleted while we were writing: mirror saveProject and leave no orphan behind.
    await fs.rm(projectDir(id), { recursive: true, force: true }).catch(() => {});
    return undefined;
  }
  await fs.rename(tmp, file);
  return file;
}

export async function readManual(id: string, index: number): Promise<Buffer | undefined> {
  if (!isValidId(id) || tombstones.has(id)) return undefined;
  try {
    return await fs.readFile(path.join(projectDir(id), `manual-${index}.pdf`));
  } catch {
    return undefined;
  }
}

/** Strip the heavy plan payload for list/status responses. */
export function summarize(p: Project): Omit<Project, "plan"> & { hasPlan: boolean } {
  const { plan, ...rest } = p;
  return { ...rest, hasPlan: Boolean(plan) };
}
