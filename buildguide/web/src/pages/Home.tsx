import { useEffect, useState } from "react";
import { api, type AppConfig } from "../api";
import type { ProjectSummary } from "../../../shared/project";
import { hostOf } from "../lib/format";
import { Logo } from "../components/TopBar";

interface Props {
  config: AppConfig | null;
  onOpen: (id: string) => void;
}

export function Home({ config, onOpen }: Props) {
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [showNotes, setShowNotes] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<ProjectSummary[]>([]);

  const refresh = () => api.listProjects().then(setRecent).catch(() => setRecent([]));
  useEffect(() => {
    void refresh();
  }, []);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.createProject(url.trim(), notes);
      onOpen(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const openSample = async (sampleId: string) => {
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.createSample(sampleId);
      onOpen(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    await api.deleteProject(id);
    void refresh();
  };

  const live = config?.liveGeneration ?? false;

  return (
    <div className="home">
      <div className="home-main">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="brand">
            <Logo size={28} /> BuildGuide
          </div>
          {config && (
            <span className={`badge ${live ? "ok" : "warn"}`}>
              <span className="dot" />
              {config.mock ? "Mock mode" : config.hasApiKey ? `Live · ${config.model}` : "Demo mode · no API key"}
            </span>
          )}
        </div>
        <section className="hero">
          <h1>
            Paste a link. Get <em>step-by-step 3D and voice</em> assembly instructions.
          </h1>
          <p className="lead">
            A wardrobe, a desk, a dome tent: BuildGuide fetches the manual behind the link, asks Claude to work out every part and every step, and walks you through the build with an interactive 3D model you can talk to.
          </p>
          <form className="url-form" onSubmit={submit}>
            <div className="row-input">
              <input className="input" type="text" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://www.ikea.com/…/billy-bookcase… or a direct link to the instructions PDF" value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy} required aria-label="Product or manual link" />
              <button className="btn primary" type="submit" disabled={busy || !url.trim()}>
                {busy ? <span className="spinner" /> : "Build my guide"}
              </button>
            </div>
            {showNotes ? (
              <textarea className="textarea notes" placeholder="Optional notes for Claude: the exact model/colour, what you already know, anything to emphasise…" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={busy} />
            ) : (
              <div className="hint">
                <button type="button" className="btn ghost sm" onClick={() => setShowNotes(true)}>
                  + Add a note for Claude
                </button>
                <span>Works best with a product page that links to its assembly PDF, or the PDF itself.</span>
              </div>
            )}
            {!live && (
              <div className="hint">
                <span className="badge warn">Demo mode</span>
                <span>Set ANTHROPIC_API_KEY on the server to analyse new links. The samples below work without it.</span>
              </div>
            )}
            {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}
          </form>
        </section>

        <h2 className="section-title">Try a sample</h2>
        <div className="cards">
          {(config?.samples ?? []).map((s) => (
            <button key={s.id} className="card" onClick={() => openSample(s.id)} disabled={busy}>
              <h3>{s.title}</h3>
              <p>{s.blurb}</p>
              <div className="meta">
                <span className="badge">{s.category}</span>
                <span className="badge">{s.steps} steps</span>
              </div>
            </button>
          ))}
        </div>

        {recent.length > 0 && (
          <>
            <h2 className="section-title">Recent guides</h2>
            <div className="recent">
              {recent.slice(0, 12).map((p) => (
                <div key={p.id} className="recent-item">
                  <button className="btn ghost sm" style={{ flex: 1, justifyContent: "flex-start", minWidth: 0, textAlign: "left" }} onClick={() => onOpen(p.id)}>
                    <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
                      <span className="name">{p.name}</span>
                      <span className="url">{p.url.startsWith("sample://") ? "Built-in sample" : hostOf(p.url)} · {new Date(p.createdAt).toLocaleString()}</span>
                    </span>
                  </button>
                  <span className={`badge ${p.status === "ready" ? "ok" : p.status === "error" ? "warn" : "info"}`}>{p.status}</span>
                  <button className="btn ghost sm danger" onClick={() => remove(p.id)} title="Delete">
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="features">
          <div className="feature">
            <b>Reads the real manual</b>
            <span>Finds the assembly PDF behind a product page and hands the diagrams to Claude Opus 5.5 with vision.</span>
          </div>
          <div className="feature">
            <b>Computed 3D model</b>
            <span>Every panel, pole and screw placed in space. Parts fly in step by step; explode the view to see the joints.</span>
          </div>
          <div className="feature">
            <b>Voice guided</b>
            <span>Each step is read aloud. Say “next”, “repeat”, or ask “where does part C go?” with your hands full.</span>
          </div>
          <div className="feature">
            <b>Talk it through</b>
            <span>Chat is grounded in the plan and the manual, and it can drive the 3D view to show you what it means.</span>
          </div>
        </div>
      </div>
      <footer className="footer">BuildGuide · plans are generated by AI from the documentation you provide; always follow the manufacturer's safety instructions.</footer>
    </div>
  );
}
