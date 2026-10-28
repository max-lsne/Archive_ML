import { useState } from "react";
import { useStore } from "../store";
import { minutes, bytes, hostOf, cap } from "../lib/format";
import { api } from "../api";

type Tab = "steps" | "parts" | "overview";

export function StepsSidebar() {
  const [tab, setTab] = useState<Tab>("steps");
  return (
    <>
      <div className="tabs" role="tablist">
        {(["steps", "parts", "overview"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {cap(t)}
          </button>
        ))}
      </div>
      <div className="sidebar-body">
        {tab === "steps" && <StepsList />}
        {tab === "parts" && <PartsList />}
        {tab === "overview" && <Overview />}
      </div>
    </>
  );
}

function StepsList() {
  const plan = useStore((s) => s.plan)!;
  const stepIndex = useStore((s) => s.stepIndex);
  const completed = useStore((s) => s.completed);
  const setStep = useStore((s) => s.setStep);
  return (
    <div className="steps-list">
      {plan.steps.map((step, i) => (
        <button key={step.id} className={`step-item ${i === stepIndex ? "active" : ""} ${completed[step.id] ? "done" : ""}`} onClick={() => setStep(i)}>
          <span className="num">{completed[step.id] ? "✓" : step.id}</span>
          <span>
            <div className="t">{step.title}</div>
            <div className="m">
              {minutes(step.durationMinutes)}
              {step.addInstances.length ? ` · ${step.addInstances.length} part${step.addInstances.length > 1 ? "s" : ""}` : ""}
              {step.warnings.length ? " · ⚠" : ""}
            </div>
          </span>
        </button>
      ))}
    </div>
  );
}

function PartsList() {
  const plan = useStore((s) => s.plan)!;
  const highlighted = useStore((s) => s.highlighted);
  const highlightComponent = useStore((s) => s.highlightComponent);
  const instancesOf = (id: string) => plan.instances.filter((i) => i.componentId === id);
  const isActive = (id: string) => {
    const ids = instancesOf(id).map((i) => i.id);
    return ids.length > 0 && ids.every((x) => highlighted.includes(x));
  };
  const structural = plan.components.filter((c) => !c.isHardware);
  const hardware = plan.components.filter((c) => c.isHardware);
  const Item = ({ c }: { c: (typeof plan.components)[number] }) => (
    <button className={`part-item ${isActive(c.id) ? "active" : ""}`} onClick={() => highlightComponent(c.id)} title={c.description || c.name}>
      <span className="swatch" style={{ background: c.color }} />
      <span>
        <div className="pn">
          {c.label && <span className="label-chip" style={{ marginRight: 6 }}>{c.label}</span>}
          {c.name}
        </div>
        <div className="pd">
          {c.size.map((n) => Math.round(n * 10) / 10).join(" × ")} cm · {c.material}
        </div>
      </span>
      <span className="qty">×{c.qty}</span>
    </button>
  );
  return (
    <div className="parts-list">
      <div className="section-title" style={{ margin: "6px 10px 6px" }}>
        Parts ({structural.length})
      </div>
      {structural.map((c) => (
        <Item key={c.id} c={c} />
      ))}
      {hardware.length > 0 && (
        <>
          <div className="section-title" style={{ margin: "14px 10px 6px" }}>
            Hardware ({hardware.length})
          </div>
          {hardware.map((c) => (
            <Item key={c.id} c={c} />
          ))}
        </>
      )}
      <p className="dim" style={{ fontSize: 12, padding: "8px 10px" }}>
        Click a part to light it up in the 3D view.
      </p>
    </div>
  );
}

function Overview() {
  const project = useStore((s) => s.project)!;
  const plan = useStore((s) => s.plan)!;
  const totalMin = plan.steps.reduce((a, s) => a + s.durationMinutes, 0);
  return (
    <div>
      <div className="info-block">
        <h4>About</h4>
        <div className="muted">{plan.product.summary}</div>
        <div className="row" style={{ marginTop: 8, flexWrap: "wrap", gap: 6 }}>
          <span className="badge">{plan.steps.length} steps</span>
          <span className="badge">{minutes(totalMin || plan.product.estimatedMinutes)}</span>
          <span className="badge">{plan.product.assembledSize.map((n) => Math.round(n)).join(" × ")} cm</span>
          <span className="badge">{plan.components.length} part types</span>
        </div>
      </div>
      {plan.sourceNotes && (
        <div className="info-block">
          <h4>Source</h4>
          <div className="muted">{plan.sourceNotes}</div>
          <ul style={{ marginTop: 6 }}>
            {project.sources.map((s, i) => (
              <li key={s.url + i}>
                {s.kind === "pdf" ? (
                  <a href={api.manualUrl(project.id, project.sources.filter((x) => x.kind === "pdf").indexOf(s))} target="_blank" rel="noreferrer">
                    {s.title}
                  </a>
                ) : (
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.title || hostOf(s.url)}
                  </a>
                )}{" "}
                <span className="dim">
                  {s.kind === "pdf" ? `PDF · ${s.pages ?? "?"} pages · ${bytes(s.size)}` : s.kind === "html" ? `page · ${hostOf(s.url)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {plan.beforeYouStart.length > 0 && (
        <div className="info-block">
          <h4>Before you start</h4>
          <ul>
            {plan.beforeYouStart.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      {plan.safety.length > 0 && (
        <div className="info-block" style={{ borderColor: "rgba(242,166,90,0.35)" }}>
          <h4 style={{ color: "var(--warn)" }}>Safety</h4>
          <ul>
            {plan.safety.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      {plan.tools.length > 0 && (
        <div className="info-block">
          <h4>Tools</h4>
          <ul>
            {plan.tools.map((t, i) => (
              <li key={i}>
                {t.name} {!t.required && <span className="dim">(optional)</span>}
                {t.note && <span className="dim"> — {t.note}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {project.usage && project.usage.model !== "mock" && (
        <div className="info-block">
          <h4>Analysis</h4>
          <div className="dim" style={{ fontSize: 12 }}>
            {project.usage.model} · {project.usage.inputTokens.toLocaleString()} in / {project.usage.outputTokens.toLocaleString()} out tokens · {(project.usage.durationMs / 1000).toFixed(0)} s
          </div>
        </div>
      )}
    </div>
  );
}
