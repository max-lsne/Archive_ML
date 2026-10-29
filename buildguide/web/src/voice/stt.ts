/** Thin wrapper around the browser SpeechRecognition API. */

export function sttSupported(): boolean {
  return typeof window !== "undefined" && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export interface RecognizerOptions {
  continuous: boolean;
  lang?: string;
  onResult: (transcript: string, isFinal: boolean) => void;
  onEnd: () => void;
  onError?: (error: string) => void;
}

export class Recognizer {
  private rec: SpeechRecognitionLike | null = null;
  private stopped = true;

  get active(): boolean {
    return !this.stopped;
  }

  start(opts: RecognizerOptions): boolean {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) return false;
    this.stop();
    const rec = new Ctor();
    // The command grammar (shared/voice.ts) is English, so recognise English by
    // default regardless of the browser locale; callers may override via `lang`.
    rec.lang = opts.lang ?? "en-US";
    rec.continuous = opts.continuous;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const text = r[0]?.transcript ?? "";
        if (text.trim()) opts.onResult(text.trim(), r.isFinal);
      }
    };
    rec.onerror = (ev) => {
      // "no-speech" and "aborted" are routine in continuous mode.
      if (ev.error !== "no-speech" && ev.error !== "aborted") opts.onError?.(ev.error);
    };
    rec.onend = () => {
      if (this.rec === rec) {
        this.rec = null;
        this.stopped = true;
      }
      opts.onEnd();
    };
    this.rec = rec;
    this.stopped = false;
    try {
      rec.start();
      return true;
    } catch {
      this.rec = null;
      this.stopped = true;
      return false;
    }
  }

  stop(): void {
    const rec = this.rec;
    this.rec = null;
    this.stopped = true;
    if (rec) {
      rec.onend = null;
      rec.onresult = null;
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    }
  }
}
