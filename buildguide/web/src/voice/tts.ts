/** Browser speech synthesis with sentence chunking (long utterances get cut off in Chrome). */

export function ttsSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

let voicesCache: SpeechSynthesisVoice[] = [];
const listeners = new Set<(v: SpeechSynthesisVoice[]) => void>();

function refreshVoices(): void {
  if (!ttsSupported()) return;
  const v = window.speechSynthesis.getVoices();
  if (v.length) {
    voicesCache = v;
    listeners.forEach((l) => l(v));
  }
}
if (ttsSupported()) {
  refreshVoices();
  window.speechSynthesis.addEventListener?.("voiceschanged", refreshVoices);
}

export function getVoices(): SpeechSynthesisVoice[] {
  if (!voicesCache.length) refreshVoices();
  return voicesCache;
}

export function onVoicesChanged(cb: (v: SpeechSynthesisVoice[]) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const PREFERRED = [/natural/i, /google (us|uk) english/i, /samantha/i, /daniel/i, /karen/i, /moira/i, /serena/i, /zira/i, /david/i];

export function pickDefaultVoice(voices: SpeechSynthesisVoice[] = getVoices()): SpeechSynthesisVoice | undefined {
  const english = voices.filter((v) => /^en([-_]|$)/i.test(v.lang));
  const pool = english.length ? english : voices;
  for (const re of PREFERRED) {
    const hit = pool.find((v) => re.test(v.name));
    if (hit) return hit;
  }
  return pool.find((v) => v.default) ?? pool[0];
}

function chunk(text: string): string[] {
  const clean = text.replace(/[*_#`>]/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) ?? [clean];
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if ((buf + s).length > 220 && buf) {
      out.push(buf.trim());
      buf = s;
    } else buf += s;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

interface SpeakOptions {
  rate?: number;
  voiceURI?: string | null;
  onEnd?: () => void;
}

let activeToken = 0;

/** Speak `text`, cancelling anything already playing. Returns a cancel function. */
export function speak(text: string, opts: SpeakOptions = {}): () => void {
  if (!ttsSupported()) {
    opts.onEnd?.();
    return () => {};
  }
  const synth = window.speechSynthesis;
  synth.cancel();
  const token = ++activeToken;
  const parts = chunk(text);
  if (!parts.length) {
    opts.onEnd?.();
    return () => {};
  }
  const voices = getVoices();
  const voice = (opts.voiceURI && voices.find((v) => v.voiceURI === opts.voiceURI)) || pickDefaultVoice(voices);
  let remaining = parts.length;
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    opts.onEnd?.();
  };
  const finish = () => {
    if (token !== activeToken) return;
    remaining -= 1;
    if (remaining <= 0) done();
  };
  for (const p of parts) {
    const u = new SpeechSynthesisUtterance(p);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    u.rate = Math.min(2, Math.max(0.5, opts.rate ?? 1));
    u.pitch = 1;
    u.onend = finish;
    u.onerror = finish;
    synth.speak(u);
  }
  // Safari/Chrome occasionally pause the queue; nudge it. Chrome can also drop
  // the final onend/onerror entirely, so when the synth has gone quiet while this
  // speak() is still the active one, treat it as finished rather than hang.
  const nudge = setInterval(() => {
    if (token !== activeToken || finished) {
      clearInterval(nudge);
      return;
    }
    if (!synth.speaking && !synth.pending) {
      clearInterval(nudge);
      done();
      return;
    }
    if (synth.paused) synth.resume();
  }, 4000);
  return () => {
    if (token === activeToken) {
      activeToken++;
      synth.cancel();
      clearInterval(nudge);
      done();
    }
  };
}

export function stopSpeaking(): void {
  if (!ttsSupported()) return;
  activeToken++;
  window.speechSynthesis.cancel();
}
