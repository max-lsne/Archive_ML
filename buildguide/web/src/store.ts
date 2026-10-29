import { create } from "zustand";
import { instancesByComponent, type AssemblyPlan, type CameraHint } from "../../shared/plan";
import type { ChatMessage, Project, UiAction } from "../../shared/project";
import { api } from "./api";

export interface ChatEntry extends ChatMessage {
  id: string;
  actions?: UiAction[];
  streaming?: boolean;
  error?: string;
  /** The question arrived by voice, so the answer should be spoken. */
  spoken?: boolean;
}

export interface VoiceSettings {
  speakSteps: boolean;
  speakReplies: boolean;
  handsFree: boolean;
  rate: number;
  voiceURI: string | null;
}

interface State {
  project: Project | null;
  plan: AssemblyPlan | null;
  stepIndex: number;
  completed: Record<number, boolean>;
  highlighted: string[];
  selected: string | null;
  hovered: string | null;
  view: CameraHint | null;
  viewNonce: number;
  exploded: number;
  ghostFuture: boolean;
  autoRotate: boolean;
  showLabels: boolean;
  /** Bumps whenever the current step should be (re)spoken. */
  speakNonce: number;
  chat: ChatEntry[];
  chatBusy: boolean;
  voice: VoiceSettings;
  voiceStatus: "idle" | "listening" | "speaking";
  lastHeard: string;
  mobilePane: "steps" | "viewer" | "chat";

  loadProject: (p: Project) => void;
  setStep: (index: number, opts?: { speak?: boolean; keepHighlights?: boolean; force?: boolean }) => void;
  nextStep: () => void;
  prevStep: () => void;
  toggleCompleted: (stepId: number) => void;
  setHighlighted: (ids: string[]) => void;
  highlightComponent: (componentId: string) => void;
  setSelected: (id: string | null) => void;
  setHovered: (id: string | null) => void;
  setView: (view: CameraHint) => void;
  setExploded: (v: number) => void;
  toggle: (key: "ghostFuture" | "autoRotate" | "showLabels") => void;
  sendChat: (text: string, opts?: { spoken?: boolean }) => Promise<void>;
  clearChat: () => void;
  applyAction: (a: UiAction) => void;
  setVoice: (patch: Partial<VoiceSettings>) => void;
  setVoiceStatus: (s: State["voiceStatus"]) => void;
  setLastHeard: (t: string) => void;
  setMobilePane: (p: State["mobilePane"]) => void;
}

const VOICE_KEY = "buildguide.voice";
function loadVoice(): VoiceSettings {
  const base: VoiceSettings = { speakSteps: true, speakReplies: true, handsFree: false, rate: 1, voiceURI: null };
  try {
    const raw = localStorage.getItem(VOICE_KEY);
    return raw ? { ...base, ...(JSON.parse(raw) as Partial<VoiceSettings>), handsFree: false } : base;
  } catch {
    return base;
  }
}

let uid = 0;
const nextId = () => `m${++uid}_${Date.now().toString(36)}`;

/** The in-flight chat request, so switching projects can cancel it. */
let activeChat: AbortController | null = null;

export const useStore = create<State>((set, get) => ({
  project: null,
  plan: null,
  stepIndex: 0,
  completed: {},
  highlighted: [],
  selected: null,
  hovered: null,
  view: null,
  viewNonce: 0,
  exploded: 0,
  ghostFuture: true,
  autoRotate: false,
  showLabels: false,
  speakNonce: 0,
  chat: [],
  chatBusy: false,
  voice: loadVoice(),
  voiceStatus: "idle",
  lastHeard: "",
  mobilePane: "viewer",

  loadProject: (p) => {
    const prev = get().project;
    const same = prev?.id === p.id;
    if (!same && activeChat) {
      // A reply still streaming for the previous project must not touch this one.
      activeChat.abort();
      activeChat = null;
    }
    let completed: Record<number, boolean> = {};
    try {
      completed = JSON.parse(localStorage.getItem(`buildguide.done.${p.id}`) ?? "{}");
    } catch {
      /* ignore */
    }
    set({
      project: p,
      plan: p.plan ?? null,
      stepIndex: same ? get().stepIndex : 0,
      completed,
      highlighted: [],
      selected: null,
      chat: same ? get().chat : [],
      chatBusy: same ? get().chatBusy : false,
      view: null,
      exploded: 0,
      voiceStatus: "idle",
      lastHeard: "",
    });
  },

  setStep: (index, opts) => {
    const { plan } = get();
    if (!plan) return;
    const i = Math.max(0, Math.min(plan.steps.length - 1, index));
    // Already there (e.g. Next on the last step): don't re-read or re-fly.
    if (i === get().stepIndex && !opts?.force) return;
    const hint = plan.steps[i].cameraHint;
    set((s) => ({
      stepIndex: i,
      highlighted: opts?.keepHighlights ? s.highlighted : [],
      selected: opts?.keepHighlights ? s.selected : null,
      // "auto" keeps the user's current angle; CameraRig only re-frames.
      view: hint === "auto" ? null : hint,
      viewNonce: s.viewNonce + 1,
      speakNonce: opts?.speak === false ? s.speakNonce : s.speakNonce + 1,
    }));
  },
  nextStep: () => get().setStep(get().stepIndex + 1),
  prevStep: () => get().setStep(get().stepIndex - 1),
  toggleCompleted: (stepId) => {
    const completed = { ...get().completed, [stepId]: !get().completed[stepId] };
    set({ completed });
    const id = get().project?.id;
    if (id) {
      try {
        localStorage.setItem(`buildguide.done.${id}`, JSON.stringify(completed));
      } catch {
        /* storage unavailable (private mode, quota); the in-memory toggle still applies */
      }
    }
  },

  setHighlighted: (ids) => set({ highlighted: ids }),
  highlightComponent: (componentId) => {
    const { plan, highlighted } = get();
    if (!plan) return;
    const ids = instancesByComponent(plan).get(componentId) ?? [];
    const already = ids.length > 0 && ids.every((id) => highlighted.includes(id));
    set({ highlighted: already ? [] : ids, selected: already ? null : ids[0] ?? null });
  },
  setSelected: (id) => set({ selected: id }),
  setHovered: (id) => set({ hovered: id }),
  setView: (view) => set((s) => ({ view, viewNonce: s.viewNonce + 1 })),
  setExploded: (v) => set({ exploded: Math.max(0, Math.min(1, v)) }),
  toggle: (key) => set((s) => ({ [key]: !s[key] }) as Partial<State>),

  applyAction: (a) => {
    const { plan } = get();
    if (!plan) return;
    switch (a.name) {
      case "go_to_step":
        // The assistant may highlight parts and move to a step in the same turn; keep both.
        get().setStep(a.input.step - 1, { speak: false, keepHighlights: true });
        break;
      case "highlight_parts":
        set({ highlighted: a.input.instanceIds, selected: a.input.instanceIds[0] ?? null });
        break;
      case "set_view":
        get().setView(a.input.view as CameraHint);
        break;
      case "set_exploded":
        set({ exploded: a.input.enabled ? 0.8 : 0 });
        break;
    }
  },

  sendChat: async (text, opts) => {
    const { project, plan, chatBusy } = get();
    const trimmed = text.trim();
    if (!project || !plan || !trimmed || chatBusy) return;
    const userMsg: ChatEntry = { id: nextId(), role: "user", content: trimmed, spoken: opts?.spoken };
    const reply: ChatEntry = { id: nextId(), role: "assistant", content: "", streaming: true, actions: [], spoken: opts?.spoken };
    set((s) => ({ chat: [...s.chat, userMsg, reply], chatBusy: true }));
    const history = [...get().chat.filter((m) => !m.streaming && !m.error).map((m) => ({ role: m.role, content: m.content }))];
    const controller = new AbortController();
    activeChat = controller;
    const projectId = project.id;
    /** False once another project was loaded or this request was superseded. */
    const current = () => activeChat === controller && !controller.signal.aborted && get().project?.id === projectId;
    const patch = (p: Partial<ChatEntry>) => {
      if (!current()) return;
      set((s) => ({ chat: s.chat.map((m) => (m.id === reply.id ? { ...m, ...p } : m)) }));
    };
    try {
      await api.chat(project.id, history, get().stepIndex, (ev) => {
        if (!current()) return;
        if (ev.type === "text") {
          set((s) => ({ chat: s.chat.map((m) => (m.id === reply.id ? { ...m, content: m.content + ev.text } : m)) }));
        } else if (ev.type === "action") {
          get().applyAction(ev.action);
          set((s) => ({ chat: s.chat.map((m) => (m.id === reply.id ? { ...m, actions: [...(m.actions ?? []), ev.action] } : m)) }));
        } else if (ev.type === "done") {
          const entry = get().chat.find((m) => m.id === reply.id);
          const text = ev.text || entry?.content || "";
          // An empty reply would be dropped from the history sent back to the
          // server, merging two user turns; keep a short placeholder instead.
          const placeholder = entry?.actions?.length
            ? "I've updated the 3D view for you."
            : "I couldn't come up with an answer to that. Try rephrasing.";
          patch({ content: text.trim() ? text : placeholder, streaming: false });
        } else if (ev.type === "error") {
          patch({ error: ev.message, streaming: false });
        }
      }, controller.signal);
    } catch (e) {
      if (!controller.signal.aborted) patch({ error: e instanceof Error ? e.message : String(e), streaming: false });
    } finally {
      patch({ streaming: false });
      if (current()) set({ chatBusy: false });
      if (activeChat === controller) activeChat = null;
    }
  },
  clearChat: () => set({ chat: [] }),

  setVoice: (patch) => {
    const voice = { ...get().voice, ...patch };
    set({ voice });
    try {
      localStorage.setItem(VOICE_KEY, JSON.stringify(voice));
    } catch {
      /* ignore */
    }
  },
  setVoiceStatus: (voiceStatus) => set({ voiceStatus }),
  setLastHeard: (lastHeard) => set({ lastHeard }),
  setMobilePane: (mobilePane) => set({ mobilePane }),
}));
