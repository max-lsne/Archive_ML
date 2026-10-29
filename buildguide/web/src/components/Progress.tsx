import type { Project } from "../../../shared/project";
import { bytes, hostOf } from "../lib/format";

interface Props {
  project: Omit<Project, "plan"> & { hasPlan?: boolean };
  onRetry: () => void;
  onHome: () => void;
}

export function Progress({ project, onRetry, onHome }: Props) {
  const order = ["fetching", "analyzing", "ready"] as const;
  const idx = project.status === "queued" ? 0 : project.status === "error" ? -1 : order.indexOf(project.status as (typeof order)[number]);
  const stageState = (i: number): "done" | "active" | "todo" | "error" => {
    if (project.status === "error") return i < errorStage() ? "done" : i === errorStage() ? "error" : "todo";
    if (i < idx) return "done";
    if (i === idx) return project.status === "ready" ? "done" : "active";
    return "todo";
  };
  const errorStage = () => (project.sources.length ? 1 : 0);
  const kb = project.progressChars ? (project.progressChars / 1024).toFixed(1) : null;
  // A full plan is typically 20–80 KB of JSON; show indeterminate-ish progress.
  const pct = project.progressChars ? Math.min(95, 15 + (project.progressChars / 60000) * 80) : project.status === "analyzing" ? 12 : 4;

  return (
    <div className="progress-page">
      <div className="progress-card">
        <h2>{project.status === "error" ? "Couldn't build a guide" : "Building your guide"}</h2>
        <div className="url-row">
          {project.imageUrl && (
            <img
              className="product-thumb"
              src={project.imageUrl}
              alt=""
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          )}
          <div className="url">{project.url}</div>
        </div>
        <div className="stages">
          <Stage n={1} state={stageState(0)} label="Fetching the documentation" detail={project.sources.length ? project.sources.map((s) => `${s.kind.toUpperCase()}: ${s.title || hostOf(s.url)}${s.pages ? ` (${s.pages} pages, ${bytes(s.size)})` : ""}`).join(" · ") : stageState(0) === "active" ? project.progress : "Product page, assembly-manual PDFs, photos"} />
          <Stage n={2} state={stageState(1)} label="Claude studies the manual and computes the 3D plan" detail={stageState(1) === "active" ? `${project.progress}${kb ? ` — ${kb} KB generated` : ""}` : stageState(1) === "done" ? "Done" : "Parts, geometry, steps, voice scripts"} />
          <Stage n={3} state={stageState(2)} label="Ready to assemble" detail={stageState(2) === "done" ? "Opening…" : "Interactive 3D view, voice guidance and chat"} />
        </div>
        {project.status !== "error" && (
          <div className="meter" aria-hidden>
            <div style={{ width: `${pct}%` }} />
          </div>
        )}
        {project.status === "analyzing" && <p className="dim" style={{ fontSize: 12, marginTop: 10 }}>Longer manuals take a few minutes. The plan streams in as it is generated.</p>}
        {project.status === "error" && (
          <>
            <div className="error" data-testid="pipeline-error" style={{ marginTop: 6 }}>{project.error}</div>
            <p className="muted" style={{ fontSize: 13 }}>
              Tips: paste a direct link to the assembly-instructions PDF if the product page didn't include one; some retailers block automated access, in which case download the PDF and host it yourself or use the manufacturer's site.
            </p>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn primary" onClick={onRetry}>
                Try again
              </button>
              <button className="btn" onClick={onHome}>
                Back
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stage({ n, state, label, detail }: { n: number; state: "done" | "active" | "todo" | "error"; label: string; detail: string }) {
  return (
    <div className={`stage ${state}`}>
      <div className="bullet">{state === "done" ? "✓" : state === "active" ? <span className="spinner" /> : state === "error" ? "!" : n}</div>
      <div>
        <div className="label">{label}</div>
        <div className="detail">{detail}</div>
      </div>
    </div>
  );
}
