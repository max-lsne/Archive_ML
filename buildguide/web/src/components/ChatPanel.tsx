import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { UiAction } from "../../../shared/project";

interface Props {
  live: boolean;
  onListenOnce: () => Promise<string>;
  sttSupported: boolean;
}

const SUGGESTIONS = ["What tools do I need?", "Which way round does this part go?", "Show me the exploded view", "What's the most common mistake here?", "How long will this take?"];

function actionLabel(a: UiAction, stepTitle?: string): string {
  switch (a.name) {
    case "go_to_step":
      return `→ Step ${a.input.step}${stepTitle ? `: ${stepTitle}` : ""}`;
    case "highlight_parts":
      return a.input.instanceIds.length ? `✨ Highlighted ${a.input.instanceIds.length} part${a.input.instanceIds.length > 1 ? "s" : ""}` : "Cleared highlights";
    case "set_view":
      return `🎥 ${a.input.view} view`;
    case "set_exploded":
      return a.input.enabled ? "💥 Exploded view" : "Assembled view";
  }
}

export function ChatPanel({ live, onListenOnce, sttSupported }: Props) {
  const chat = useStore((s) => s.chat);
  const busy = useStore((s) => s.chatBusy);
  const plan = useStore((s) => s.plan);
  const sendChat = useStore((s) => s.sendChat);
  const clearChat = useStore((s) => s.clearChat);
  const voiceStatus = useStore((s) => s.voiceStatus);
  const lastHeard = useStore((s) => s.lastHeard);
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat]);

  const submit = (t = text) => {
    if (!t.trim() || busy) return;
    setText("");
    void sendChat(t);
  };

  const mic = async () => {
    if (listening) return;
    setListening(true);
    try {
      const heard = await onListenOnce();
      if (heard.trim()) void sendChat(heard, { spoken: true });
    } finally {
      setListening(false);
    }
  };

  return (
    <>
      <div className="chat-head">
        <b>Ask about this build</b>
        <span className={`badge ${live ? "accent" : ""}`} title={live ? "Answers come from Claude, grounded in the plan and the manual" : "Demo assistant: answers from the plan only"}>
          {live ? "Claude" : "Demo"}
        </span>
        <div className="spacer" />
        {chat.length > 0 && (
          <button className="btn ghost sm" onClick={clearChat} title="Clear conversation">
            Clear
          </button>
        )}
      </div>
      <div className="chat-body" ref={bodyRef}>
        {chat.length === 0 && (
          <div className="chat-empty">
            Ask anything about the assembly: where a part goes, which screw to use, what a diagram means. I can also move the 3D view for you.
          </div>
        )}
        {chat.map((m) => (
          <div key={m.id} className={`msg ${m.role} ${m.streaming ? "streaming" : ""}`}>
            {m.content || (m.streaming ? "" : m.error ? "" : "…")}
            {m.error && <div className="error" style={{ marginTop: 6 }}>{m.error}</div>}
            {m.actions && m.actions.length > 0 && (
              <div className="actions">
                {m.actions.map((a, i) => (
                  <span key={i} className="chip">
                    {actionLabel(a, a.name === "go_to_step" ? plan?.steps[a.input.step - 1]?.title : undefined)}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {chat.length === 0 && (
        <div className="suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="chip" onClick={() => submit(s)} disabled={busy}>
              {s}
            </button>
          ))}
        </div>
      )}
      {(listening || voiceStatus === "listening") && (
        <div className="listening">
          <span className="badge" style={{ color: "#ff9598", borderColor: "rgba(229,72,77,0.4)" }}>
            <span className="dot pulse" /> Listening
          </span>
          <span className="dim">{lastHeard}</span>
        </div>
      )}
      <div className="chat-input">
        <textarea
          className="textarea"
          rows={1}
          placeholder={busy ? "Thinking…" : "Ask a question… (Enter to send)"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={busy}
          aria-label="Message"
        />
        {sttSupported && (
          <button className={`btn icon ${listening ? "live" : ""}`} onClick={mic} disabled={busy || listening} title="Hold a question by voice" aria-label="Speak a question">
            🎤
          </button>
        )}
        <button className="btn primary icon" onClick={() => submit()} disabled={busy || !text.trim()} title="Send" aria-label="Send">
          ➤
        </button>
      </div>
    </>
  );
}
