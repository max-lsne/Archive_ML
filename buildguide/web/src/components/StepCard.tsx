import { useMemo } from "react";
import { useStore } from "../store";
import { api } from "../api";
import { minutes } from "../lib/format";
import { componentMap, instancesByComponent } from "../../../shared/plan";
import { pickManualIndex } from "../../../shared/project";

interface Props {
  onSpeak: () => void;
  onStop: () => void;
  speaking: boolean;
  ttsSupported: boolean;
}

export function StepCard({ onSpeak, onStop, speaking, ttsSupported }: Props) {
  const project = useStore((s) => s.project)!;
  const plan = useStore((s) => s.plan)!;
  const stepIndex = useStore((s) => s.stepIndex);
  const completed = useStore((s) => s.completed);
  const nextStep = useStore((s) => s.nextStep);
  const prevStep = useStore((s) => s.prevStep);
  const toggleCompleted = useStore((s) => s.toggleCompleted);
  const setHighlighted = useStore((s) => s.setHighlighted);
  const highlighted = useStore((s) => s.highlighted);
  // Hooks must run before the early return below.
  const components = useMemo(() => componentMap(plan), [plan]);
  const instancesOf = useMemo(() => instancesByComponent(plan), [plan]);
  const step = plan.steps[stepIndex];
  if (!step) return null;
  // Same selection rule as the server uses when attaching the manual to chat.
  const pdfSources = project.sources.filter((s) => s.kind === "pdf");
  const manualOrdinal = pickManualIndex(project.sources);
  const manual = manualOrdinal >= 0 ? pdfSources[manualOrdinal] : undefined;
  const manualPages = manual ? step.manualPages.filter((p) => !manual.pages || p <= manual.pages) : [];
  const isLast = stepIndex === plan.steps.length - 1;
  const done = Boolean(completed[step.id]);

  const toggleHw = (componentId: string) => {
    const ids = instancesOf.get(componentId) ?? [];
    const on = ids.length && ids.every((id) => highlighted.includes(id));
    setHighlighted(on ? [] : ids.length ? ids : step.addInstances);
  };

  return (
    <div className="step-card" aria-live="polite">
      <div className="head">
        <span className="k">
          Step {step.id} / {plan.steps.length}
        </span>
        <h2>{step.title}</h2>
        <div className="spacer" />
        <span className="k">{minutes(step.durationMinutes)}</span>
        {ttsSupported && (
          <button className={`btn sm icon ${speaking ? "active" : ""}`} onClick={speaking ? onStop : onSpeak} title={speaking ? "Stop speaking" : "Read this step aloud"} aria-label={speaking ? "Stop" : "Read aloud"}>
            {speaking ? "⏹" : "🔊"}
          </button>
        )}
      </div>
      <div className="body">
        <p className="instruction">{step.instruction}</p>
        {(step.hardware.length > 0 || step.tools.length > 0 || manualPages.length > 0) && (
          <div className="chips">
            {step.hardware.map((h) => {
              const c = components.get(h.componentId);
              return c ? (
                <button key={h.componentId} className="chip hw" onClick={() => toggleHw(h.componentId)} title={c.description || "Highlight in the 3D view"}>
                  <span className="swatch" style={{ width: 10, height: 10, background: c.color }} />
                  {h.qty} × {c.name}
                  {c.label && <span className="label-chip">{c.label}</span>}
                </button>
              ) : null;
            })}
            {step.tools.map((t) => (
              <span key={t} className="chip tool">
                🔧 {t}
              </span>
            ))}
            {manual &&
              manualPages.map((p) => (
                <a key={p} className="chip" href={api.manualUrl(project.id, manualOrdinal, p)} target="_blank" rel="noreferrer" title="Open the manual at this page">
                  📄 Manual p.{p}
                </a>
              ))}
          </div>
        )}
        {step.warnings.map((w, i) => (
          <div key={`w${i}`} className="note warn">
            ⚠ {w}
          </div>
        ))}
        {step.tips.map((t, i) => (
          <div key={`t${i}`} className="note tip">
            💡 {t}
          </div>
        ))}
        {step.checkpoint && <div className="note check">✓ Check: {step.checkpoint}</div>}
      </div>
      <div className="nav">
        <button className="btn sm" onClick={prevStep} disabled={stepIndex === 0}>
          ← Back
        </button>
        <button className={`btn sm ${done ? "active" : ""}`} onClick={() => toggleCompleted(step.id)} title="Mark this step as done">
          {done ? "✓ Done" : "Mark done"}
        </button>
        <div className="progress" aria-hidden>
          <div style={{ width: `${((stepIndex + 1) / plan.steps.length) * 100}%` }} />
        </div>
        <button
          className="btn sm primary"
          onClick={() => {
            if (!done) toggleCompleted(step.id);
            if (!isLast) nextStep();
          }}
        >
          {isLast ? (done ? "All done 🎉" : "Finish ✓") : "Next →"}
        </button>
      </div>
    </div>
  );
}
