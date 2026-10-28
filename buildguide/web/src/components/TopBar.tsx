import { useStore } from "../store";
import { api } from "../api";
import { minutes, cap } from "../lib/format";

interface Props {
  onNavigateHome: () => void;
  onToggleVoicePanel: () => void;
  voicePanelOpen: boolean;
  supported: { tts: boolean; stt: boolean };
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="14" fill="#0f1115" />
      <path d="M14 44V22l18-9 18 9v22l-18 9z" fill="none" stroke="#f5a524" strokeWidth="4" strokeLinejoin="round" />
      <path d="M14 22l18 9 18-9M32 31v22" fill="none" stroke="#f5a524" strokeWidth="4" strokeLinejoin="round" />
    </svg>
  );
}

export function TopBar({ onNavigateHome, onToggleVoicePanel, voicePanelOpen, supported }: Props) {
  const project = useStore((s) => s.project);
  const plan = useStore((s) => s.plan);
  const voice = useStore((s) => s.voice);
  const setVoice = useStore((s) => s.setVoice);
  const voiceStatus = useStore((s) => s.voiceStatus);
  if (!project || !plan) return null;
  const pdfSources = project.sources.filter((s) => s.kind === "pdf");
  const quality = plan.sourceQuality;

  return (
    <header className="topbar">
      <button className="btn ghost sm" onClick={onNavigateHome} title="Back to start" style={{ paddingLeft: 6 }}>
        <Logo />
        <span style={{ fontWeight: 700 }}>BuildGuide</span>
      </button>
      <div className="title-wrap">
        <div className="title">{plan.product.name}</div>
        <div className="subtitle">
          {[plan.product.brand, cap(plan.product.category), minutes(plan.product.estimatedMinutes), `${plan.product.peopleNeeded} ${plan.product.peopleNeeded === 1 ? "person" : "people"}`, cap(plan.product.difficulty)]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
      <span className={`badge ${quality === "manual" ? "ok" : quality === "page" ? "info" : "warn"}`} title={plan.sourceNotes}>
        {quality === "manual" ? "From the manual" : quality === "page" ? "From the product page" : project.demo ? "Sample" : "Generic plan"}
      </span>
      <div className="spacer" />
      {pdfSources.map((s, i) => (
        <a key={s.url} className="btn sm" href={api.manualUrl(project.id, i)} target="_blank" rel="noreferrer" title={s.title}>
          Manual{pdfSources.length > 1 ? ` ${i + 1}` : ""} ({s.pages ?? "?"} p)
        </a>
      ))}
      <button
        className={`btn sm ${voice.speakSteps ? "active" : ""}`}
        onClick={() => setVoice({ speakSteps: !voice.speakSteps })}
        disabled={!supported.tts}
        title={supported.tts ? "Read each step aloud" : "Speech synthesis is not available in this browser"}
      >
        {voice.speakSteps ? "🔊 Voice on" : "🔇 Voice off"}
      </button>
      <button
        className={`btn sm ${voice.handsFree ? "live" : ""}`}
        onClick={() => setVoice({ handsFree: !voice.handsFree })}
        disabled={!supported.stt}
        title={supported.stt ? "Listen continuously for commands like “next”, “repeat”, “where does part A go?”" : "Speech recognition is not available in this browser (try Chrome or Edge)"}
      >
        {voice.handsFree ? (voiceStatus === "speaking" ? "🎙 Speaking…" : "🎙 Listening") : "🎙 Hands-free"}
      </button>
      <button className={`btn sm icon ${voicePanelOpen ? "active" : ""}`} onClick={onToggleVoicePanel} title="Voice settings & commands" aria-label="Voice settings">
        ⚙
      </button>
    </header>
  );
}
