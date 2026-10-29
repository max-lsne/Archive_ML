import type { ChatEvent, ChatMessage, Project, ProjectSummary } from "../../shared/project";
import { readSse } from "./lib/sse";

export interface AppConfig {
  hasApiKey: boolean;
  mock: boolean;
  liveGeneration: boolean;
  /** Who answers chat for non-demo projects; absent on older servers (treated as "demo"). */
  chatBackend?: "claude" | "demo";
  model: string;
  effort: string;
  samples: { id: string; title: string; blurb: string; steps: number; category: string }[];
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* not json */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const api = {
  config: () => fetch("/api/config").then((r) => json<AppConfig>(r)),
  listProjects: () => fetch("/api/projects").then((r) => json<ProjectSummary[]>(r)),
  getProject: (id: string) => fetch(`/api/projects/${encodeURIComponent(id)}`).then((r) => json<Project>(r)),
  createProject: (url: string, notes: string) =>
    fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, notes }),
    }).then((r) => json<{ id: string }>(r)),
  createSample: (sampleId: string) =>
    fetch("/api/projects/sample", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sampleId }),
    }).then((r) => json<{ id: string }>(r)),
  deleteProject: (id: string) => fetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
  manualUrl: (id: string, index: number, page?: number) =>
    `/api/projects/${encodeURIComponent(id)}/manual/${index}${page ? `#page=${page}` : ""}`,

  /** Subscribe to project status updates. Returns an unsubscribe function. */
  watchProject(id: string, onStatus: (p: Omit<Project, "plan"> & { hasPlan: boolean }) => void, onError: () => void): () => void {
    const es = new EventSource(`/api/projects/${encodeURIComponent(id)}/events`);
    es.addEventListener("status", (ev) => onStatus(JSON.parse((ev as MessageEvent).data)));
    es.onerror = () => {
      // The server closes the stream once the project is ready/errored; EventSource
      // would reconnect forever, so let the caller refetch and decide.
      es.close();
      onError();
    };
    return () => es.close();
  },

  async chat(id: string, messages: ChatMessage[], stepIndex: number, onEvent: (ev: ChatEvent) => void, signal?: AbortSignal): Promise<void> {
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, stepIndex }),
      signal,
    });
    if (!res.ok) await json(res);
    await readSse(
      res,
      (data) => {
        try {
          onEvent(JSON.parse(data) as ChatEvent);
        } catch {
          /* ignore malformed */
        }
      },
      signal,
    );
  },
};
