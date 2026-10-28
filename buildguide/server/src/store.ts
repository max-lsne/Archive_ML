import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { config } from "./config.js";
import type { Project, ProjectSummary } from "../../shared/project.js";

const projects = new Map<string, Project>();
const emitter = new EventEmitter();
emitter.setMaxListeners(200);

function projectDir(id: string): string {
  return path.join(config.dataDir, "projects", id);
}

function projectFile(id: string): string {
  return path.join(projectDir(id), "project.json");
}

export function isValidId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{4,64}$/.test(id);
}

export async function saveProject(p: Project): Promise<void> {
  p.updatedAt = new Date().toISOString();
  projects.set(p.id, p);
  emitter.emit(`project:${p.id}`, p);
  await fs.mkdir(projectDir(p.id), { recursive: true });
  const tmp = projectFile(p.id) + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(p, null, 2));
  await fs.rename(tmp, projectFile(p.id));
}

/** Update in-memory state and notify listeners without hitting disk (for frequent progress ticks). */
export function touchProject(p: Project): void {
  p.updatedAt = new Date().toISOString();
  projects.set(p.id, p);
  emitter.emit(`project:${p.id}`, p);
}

export async function getProject(id: string): Promise<Project | undefined> {
  if (!isValidId(id)) return undefined;
  const cached = projects.get(id);
  if (cached) return cached;
  try {
    const raw = await fs.readFile(projectFile(id), "utf8");
    const p = JSON.parse(raw) as Project;
    // A project interrupted mid-generation by a restart can never finish.
    if (p.status !== "ready" && p.status !== "error") {
      p.status = "error";
      p.error = "The server restarted while this project was being analysed. Please create it again.";
    }
    projects.set(id, p);
    return p;
  } catch {
    return undefined;
  }
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const dir = path.join(config.dataDir, "projects");
  let ids: string[] = [];
  try {
    ids = (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    /* no data yet */
  }
  const out: ProjectSummary[] = [];
  for (const id of ids) {
    const p = await getProject(id);
    if (!p) continue;
    out.push({
      id: p.id,
      url: p.url,
      status: p.status,
      name: p.plan?.product.name ?? p.url,
      createdAt: p.createdAt,
      demo: p.demo,
    });
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

export async function deleteProject(id: string): Promise<boolean> {
  if (!isValidId(id)) return false;
  projects.delete(id);
  try {
    await fs.rm(projectDir(id), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function onProjectChange(id: string, cb: (p: Project) => void): () => void {
  const key = `project:${id}`;
  emitter.on(key, cb);
  return () => emitter.off(key, cb);
}

export async function saveManual(id: string, index: number, bytes: Buffer): Promise<string> {
  await fs.mkdir(projectDir(id), { recursive: true });
  const file = path.join(projectDir(id), `manual-${index}.pdf`);
  await fs.writeFile(file, bytes);
  return file;
}

export async function readManual(id: string, index: number): Promise<Buffer | undefined> {
  if (!isValidId(id)) return undefined;
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
