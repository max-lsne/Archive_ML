import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Project } from "../../../shared/project";
import { useStore } from "../store";
import { Progress } from "../components/Progress";
import { Workspace } from "../components/Workspace";

interface Props {
  id: string;
  /** Reported by the server: "claude" only when chat really goes to Claude. */
  chatBackend: "claude" | "demo";
  onHome: () => void;
}

type Status = Omit<Project, "plan"> & { hasPlan?: boolean };

export function ProjectPage({ id, chatBackend, onHome }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const project = useStore((s) => s.project);
  const loadProject = useStore((s) => s.loadProject);
  const loaded = project?.id === id && project.plan;
  const retrying = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    setError(null);
    setStatus(null);
    const fetchFull = async () => {
      try {
        const p = await api.getProject(id);
        if (cancelled) return;
        setStatus(p);
        if (p.status === "ready" && p.plan) loadProject(p);
        else if (p.status !== "ready" && p.status !== "error") {
          unsubscribe = api.watchProject(
            id,
            (s) => {
              if (cancelled) return;
              setStatus(s);
              if (s.status === "ready" || s.status === "error") {
                unsubscribe?.();
                void fetchFull();
              }
            },
            () => {
              // stream closed; refetch to learn the final state
              if (!cancelled) setTimeout(() => void fetchFull(), 500);
            },
          );
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void fetchFull();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [id, loadProject]);

  const retry = async () => {
    if (!status || retrying.current) return;
    retrying.current = true;
    try {
      const { id: newId } = await api.createProject(status.url, status.notes ?? "");
      window.history.pushState({}, "", `/p/${newId}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      retrying.current = false;
    }
  };

  if (error) {
    return (
      <div className="progress-page">
        <div className="progress-card">
          <h2>Project unavailable</h2>
          <div className="error">{error}</div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" onClick={onHome}>
              Back to start
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (loaded) return <Workspace live={chatBackend === "claude" && !project?.demo} onNavigateHome={onHome} />;
  if (status) return <Progress project={status} onRetry={retry} onHome={onHome} />;
  return (
    <div className="progress-page">
      <span className="spinner" />
    </div>
  );
}
