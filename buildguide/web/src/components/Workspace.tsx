import { useEffect, useState } from "react";
import { useStore } from "../store";
import { useVoice } from "../voice/useVoice";
import { Viewer3D } from "../three/Viewer3D";
import { TopBar } from "./TopBar";
import { StepsSidebar } from "./StepsSidebar";
import { StepCard } from "./StepCard";
import { ChatPanel } from "./ChatPanel";
import { VoicePanel } from "./VoicePanel";

interface Props {
  live: boolean;
  onNavigateHome: () => void;
}

export function Workspace({ live, onNavigateHome }: Props) {
  const plan = useStore((s) => s.plan);
  const mobilePane = useStore((s) => s.mobilePane);
  const setMobilePane = useStore((s) => s.setMobilePane);
  const voiceStatus = useStore((s) => s.voiceStatus);
  const nextStep = useStore((s) => s.nextStep);
  const prevStep = useStore((s) => s.prevStep);
  const [voicePanel, setVoicePanel] = useState(false);
  const { supported, speakCurrentStep, stop, listenOnce, say } = useVoice();

  // Keyboard shortcuts (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser chords (Ctrl+R, Cmd+P, Cmd+N) alone
      if (e.key === "ArrowRight" || e.key === "n") nextStep();
      else if (e.key === "ArrowLeft" || e.key === "p") prevStep();
      else if (e.key === "r") speakCurrentStep();
      else if (e.key === "Escape") stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nextStep, prevStep, speakCurrentStep, stop]);

  if (!plan) return null;
  const vis = (pane: typeof mobilePane) => (mobilePane === pane ? "mobile-visible" : "");

  return (
    <div className="workspace">
      <TopBar onNavigateHome={onNavigateHome} onToggleVoicePanel={() => setVoicePanel((v) => !v)} voicePanelOpen={voicePanel} supported={supported} />
      <aside className={`sidebar ${vis("steps")}`}>
        <StepsSidebar />
      </aside>
      <main className={`viewer ${vis("viewer")}`}>
        <Viewer3D />
        <StepCard onSpeak={speakCurrentStep} onStop={stop} speaking={voiceStatus === "speaking"} ttsSupported={supported.tts} />
      </main>
      <section className={`chat ${vis("chat")}`}>
        <ChatPanel live={live} onListenOnce={listenOnce} sttSupported={supported.stt} />
      </section>
      <nav className="mobile-tabs">
        {(["steps", "viewer", "chat"] as const).map((p) => (
          <button key={p} className={mobilePane === p ? "active" : ""} onClick={() => setMobilePane(p)}>
            {p === "steps" ? "Steps" : p === "viewer" ? "3D" : "Chat"}
          </button>
        ))}
      </nav>
      {voicePanel && (
        <VoicePanel
          supported={supported}
          onClose={() => setVoicePanel(false)}
          onTest={() => say("Hi! I'm your assembly guide. Say next when you're ready to move on.")}
        />
      )}
    </div>
  );
}
