import { useEffect, useState } from "react";
import { useStore } from "../store";
import { getVoices, onVoicesChanged, pickDefaultVoice } from "../voice/tts";

interface Props {
  supported: { tts: boolean; stt: boolean };
  onTest: () => void;
  onClose: () => void;
}

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <button className={`toggle ${on ? "on" : ""}`} onClick={() => onChange(!on)} disabled={disabled} role="switch" aria-checked={on} />;
}

export function VoicePanel({ supported, onTest, onClose }: Props) {
  const voice = useStore((s) => s.voice);
  const setVoice = useStore((s) => s.setVoice);
  const [voices, setVoices] = useState(getVoices());
  useEffect(() => onVoicesChanged(setVoices), []);
  const def = pickDefaultVoice(voices);

  return (
    <div className="voice-panel" role="dialog" aria-label="Voice settings">
      <div className="row">
        <b>Voice</b>
        <div className="spacer" />
        <button className="btn ghost sm" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {!supported.tts && <div className="note warn">This browser can't speak. Try Chrome, Edge or Safari.</div>}
      {!supported.stt && <div className="note warn">This browser can't listen (no SpeechRecognition). Chrome and Edge support it.</div>}
      <label>
        Read steps aloud <Toggle on={voice.speakSteps} onChange={(v) => setVoice({ speakSteps: v })} disabled={!supported.tts} />
      </label>
      <label>
        Read assistant replies <Toggle on={voice.speakReplies} onChange={(v) => setVoice({ speakReplies: v })} disabled={!supported.tts} />
      </label>
      <label>
        Hands-free listening <Toggle on={voice.handsFree} onChange={(v) => setVoice({ handsFree: v })} disabled={!supported.stt} />
      </label>
      <label>
        Speed <span className="dim">{voice.rate.toFixed(2)}×</span>
        <input type="range" min={0.7} max={1.4} step={0.05} value={voice.rate} onChange={(e) => setVoice({ rate: Number(e.target.value) })} />
      </label>
      <label>
        Voice
        <select value={voice.voiceURI ?? ""} onChange={(e) => setVoice({ voiceURI: e.target.value || null })}>
          <option value="">Auto{def ? ` (${def.name})` : ""}</option>
          {voices.map((v) => (
            <option key={v.voiceURI} value={v.voiceURI}>
              {v.name} ({v.lang})
            </option>
          ))}
        </select>
      </label>
      <button className="btn sm" onClick={onTest} disabled={!supported.tts}>
        ▶ Test voice
      </button>
      <div className="info-block" style={{ marginBottom: 0 }}>
        <h4>Say things like</h4>
        <ul>
          <li>“Next” · “Back” · “Repeat” · “Go to step 5”</li>
          <li>“What parts do I need?” · “Which tools?”</li>
          <li>“Exploded view” · “Stop”</li>
          <li>Anything else is a question for the assistant: “Where does part C go?”</li>
          <li className="dim">Commands are recognised in English.</li>
        </ul>
      </div>
    </div>
  );
}
