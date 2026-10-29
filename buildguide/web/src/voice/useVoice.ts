import { useCallback, useEffect, useMemo, useRef } from "react";
import { componentMap, describeHardware } from "../../../shared/plan";
import { parseVoiceCommand, type VoiceCommand } from "../../../shared/voice";
import { useStore } from "../store";
import { Recognizer, sttSupported } from "./stt";
import { speak, stopSpeaking, ttsSupported } from "./tts";

/** Recognizer errors after which listening cannot recover on its own. */
const FATAL_STT_ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access was blocked.",
  "service-not-allowed": "Speech recognition is not allowed in this browser.",
  "audio-capture": "No microphone was found.",
  network: "Speech recognition needs a network connection.",
  "language-not-supported": "Speech recognition does not support this language.",
};

const RESTART_BASE_MS = 400;
const RESTART_MAX_MS = 8000;

/**
 * Wires speech synthesis and recognition to the store:
 *  - speaks each step when the user navigates (or asks to repeat),
 *  - speaks assistant replies to spoken questions,
 *  - in hands-free mode listens continuously and turns commands into actions.
 */
export function useVoice() {
  const voice = useStore((s) => s.voice);
  const plan = useStore((s) => s.plan);
  const stepIndex = useStore((s) => s.stepIndex);
  const speakNonce = useStore((s) => s.speakNonce);
  const chat = useStore((s) => s.chat);
  const setVoiceStatus = useStore((s) => s.setVoiceStatus);
  const setLastHeard = useStore((s) => s.setLastHeard);

  const recognizer = useMemo(() => new Recognizer(), []);
  const spokenReplies = useRef(new Set<string>());
  const speakingRef = useRef(false);
  const handsFreeRef = useRef(false);
  const restartTimer = useRef<number | null>(null);
  /** Consecutive recognizer ends without a result; drives the restart backoff. */
  const idleEnds = useRef(0);
  const supported = useMemo(() => ({ tts: ttsSupported(), stt: sttSupported() }), []);

  // Latest settings and callbacks, readable from long-lived closures (timers, recognizer callbacks).
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const startListeningRef = useRef<() => void>(() => {});
  const dispatchRef = useRef<(cmd: VoiceCommand) => void>(() => {});
  /** Settles an in-flight push-to-talk promise when speech interrupts it (Recognizer.stop() never fires onend). */
  const listenOnceInterruptRef = useRef<(() => void) | null>(null);

  const scheduleListen = useCallback((delay: number) => {
    if (restartTimer.current) window.clearTimeout(restartTimer.current);
    restartTimer.current = window.setTimeout(() => {
      restartTimer.current = null;
      if (!handsFreeRef.current || speakingRef.current) return;
      startListeningRef.current();
    }, delay);
  }, []);

  const say = useCallback(
    (text: string) => {
      if (!supported.tts || !text.trim()) return;
      // Pause the microphone so we don't transcribe ourselves (hands-free or push-to-talk).
      if (recognizer.active) recognizer.stop();
      listenOnceInterruptRef.current?.();
      speakingRef.current = true;
      setVoiceStatus("speaking");
      speak(text, {
        rate: voiceRef.current.rate,
        voiceURI: voiceRef.current.voiceURI,
        onEnd: () => {
          speakingRef.current = false;
          setVoiceStatus(handsFreeRef.current ? "listening" : "idle");
          if (handsFreeRef.current) scheduleListen(250);
        },
      });
    },
    [supported.tts, recognizer, scheduleListen, setVoiceStatus],
  );

  /** Cancel speech and clear the speaking flag (speak()'s onEnd does not fire on cancel). */
  const cancelSpeech = useCallback(() => {
    stopSpeaking();
    speakingRef.current = false;
  }, []);

  const stop = useCallback(() => {
    cancelSpeech();
    setVoiceStatus(handsFreeRef.current ? "listening" : "idle");
    if (handsFreeRef.current) scheduleListen(100);
  }, [cancelSpeech, scheduleListen, setVoiceStatus]);

  const speakCurrentStep = useCallback(() => {
    const s = useStore.getState();
    const step = s.plan?.steps[s.stepIndex];
    if (!step) return;
    say(`Step ${step.id}. ${step.title}. ${step.voiceScript}`);
  }, [say]);

  // Speak the step whenever the user navigates (speakNonce bumps) if enabled.
  // Tracking the last spoken nonce (initialised to the mount value) keeps the
  // page quiet on load, including under StrictMode's double effect run.
  const lastSpokenNonce = useRef(speakNonce);
  useEffect(() => {
    if (!plan) return;
    if (lastSpokenNonce.current === speakNonce) return;
    lastSpokenNonce.current = speakNonce;
    if (voiceRef.current.speakSteps) speakCurrentStep();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speakNonce]);

  // Speak finished assistant replies to spoken questions (or everything in hands-free mode).
  useEffect(() => {
    const last = chat[chat.length - 1];
    if (!last || last.role !== "assistant" || last.streaming || last.error) return;
    if (spokenReplies.current.has(last.id)) return;
    if (!voice.speakReplies) return;
    if (!(last.spoken || handsFreeRef.current)) return;
    spokenReplies.current.add(last.id);
    if (last.content.trim()) say(last.content);
  }, [chat, voice.speakReplies, say]);

  const dispatch = useCallback(
    (cmd: VoiceCommand) => {
      const s = useStore.getState();
      const p = s.plan;
      if (!p) return;
      switch (cmd.type) {
        case "next":
          if (s.stepIndex >= p.steps.length - 1) say("That was the last step. Nice work!");
          else s.nextStep();
          return;
        case "prev":
          s.prevStep();
          return;
        case "repeat":
          s.repeatStep();
          return;
        case "goto":
          if (cmd.step < 1 || cmd.step > p.steps.length) say(`There are only ${p.steps.length} steps.`);
          else s.setStep(cmd.step - 1);
          return;
        case "first":
          s.setStep(0);
          return;
        case "last":
          s.setStep(p.steps.length - 1);
          return;
        case "parts": {
          const step = p.steps[s.stepIndex];
          const hw = describeHardware(p, step);
          const components = componentMap(p);
          const added = step.addInstances
            .map((id) => {
              const inst = p.instances.find((i) => i.id === id);
              const comp = inst && components.get(inst.componentId);
              return comp ? `${comp.name}${comp.label ? ` ${comp.label}` : ""}` : "";
            })
            .filter((v, i, arr) => v && arr.indexOf(v) === i);
          s.setHighlighted(step.addInstances);
          say(`For this step you need ${[...added, hw].filter(Boolean).join(", ") || "no new parts"}.`);
          return;
        }
        case "tools": {
          const step = p.steps[s.stepIndex];
          const tools = step.tools.length ? step.tools : p.tools.filter((t) => t.required).map((t) => t.name);
          say(tools.length ? `You need ${tools.join(" and ")}.` : "No tools are needed for this step.");
          return;
        }
        case "stop":
          stop();
          return;
        case "explode":
          s.setExploded(cmd.enabled ? 0.8 : 0);
          say(cmd.enabled ? "Here is the exploded view." : "Back to the assembled view.");
          return;
        case "ask":
          void s.sendChat(cmd.text, { spoken: true });
          return;
      }
    },
    [say, stop],
  );
  dispatchRef.current = dispatch;

  // ---- hands-free listening -------------------------------------------------
  const startListening = useCallback(() => {
    if (!supported.stt || !handsFreeRef.current || speakingRef.current) return;
    let gotResult = false;
    let fatal = false;
    const ok = recognizer.start({
      continuous: true,
      onResult: (text, isFinal) => {
        gotResult = true;
        idleEnds.current = 0;
        setLastHeard(text);
        if (isFinal) dispatchRef.current(parseVoiceCommand(text));
      },
      onEnd: () => {
        if (fatal || !handsFreeRef.current || speakingRef.current) return;
        // Back off when the recognizer keeps ending without hearing anything,
        // so a flaky service doesn't turn into a tight restart loop.
        idleEnds.current = gotResult ? 0 : idleEnds.current + 1;
        const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** Math.max(0, idleEnds.current - 1));
        scheduleListen(delay);
      },
      onError: (err) => {
        const message = FATAL_STT_ERRORS[err];
        if (message) {
          fatal = true;
          if (restartTimer.current) window.clearTimeout(restartTimer.current);
          useStore.getState().setVoice({ handsFree: false });
          setLastHeard(message);
          setVoiceStatus("idle");
        }
      },
    });
    if (ok) {
      setVoiceStatus("listening");
    } else {
      // start() can throw right after an abort (Chrome's InvalidStateError);
      // treat it like an idle end and retry with the same backoff.
      idleEnds.current += 1;
      const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** Math.max(0, idleEnds.current - 1));
      scheduleListen(delay);
    }
  }, [recognizer, supported.stt, scheduleListen, setLastHeard, setVoiceStatus]);
  startListeningRef.current = startListening;

  useEffect(() => {
    handsFreeRef.current = voice.handsFree;
    if (voice.handsFree) {
      idleEnds.current = 0;
      setLastHeard("");
      startListeningRef.current();
    } else {
      if (restartTimer.current) window.clearTimeout(restartTimer.current);
      recognizer.stop();
      if (!speakingRef.current) setVoiceStatus("idle");
    }
    return () => {
      if (restartTimer.current) window.clearTimeout(restartTimer.current);
    };
  }, [voice.handsFree, recognizer, setVoiceStatus, setLastHeard]);

  useEffect(() => () => {
    recognizer.stop();
    stopSpeaking();
  }, [recognizer]);

  /** Push-to-talk: one utterance, resolved with the final transcript ("" if nothing). */
  const listenOnce = useCallback((): Promise<string> => {
    return new Promise((resolve) => {
      if (!supported.stt) return resolve("");
      const wasHandsFree = handsFreeRef.current;
      if (restartTimer.current) window.clearTimeout(restartTimer.current);
      recognizer.stop();
      cancelSpeech();
      let finalText = "";
      let interim = "";
      let settled = false;
      const settle = (text: string) => {
        if (settled) return;
        settled = true;
        listenOnceInterruptRef.current = null;
        setVoiceStatus(wasHandsFree ? "listening" : "idle");
        if (wasHandsFree) scheduleListen(300);
        resolve(text);
      };
      listenOnceInterruptRef.current = () => settle(finalText || interim);
      setVoiceStatus("listening");
      const begin = (): boolean =>
        recognizer.start({
          continuous: false,
          onResult: (text, isFinal) => {
            if (isFinal) finalText += (finalText ? " " : "") + text;
            else interim = text;
            setLastHeard(finalText || interim);
          },
          onEnd: () => settle(finalText || interim),
          onError: (err) => {
            const message = FATAL_STT_ERRORS[err];
            if (message) setLastHeard(message);
            settle(finalText || interim);
          },
        });
      // Chrome throws InvalidStateError when start() follows an abort too closely
      // (e.g. hands-free was listening): retry briefly before giving up.
      const RETRY_DELAYS_MS = [250, 600];
      const attempt = (retry: number) => {
        if (settled) return;
        if (begin()) return;
        const delay = RETRY_DELAYS_MS[retry];
        if (delay === undefined) {
          setLastHeard("Microphone is busy, try again.");
          settle("");
          return;
        }
        window.setTimeout(() => attempt(retry + 1), delay);
      };
      attempt(0);
    });
  }, [recognizer, supported.stt, cancelSpeech, scheduleListen, setLastHeard, setVoiceStatus]);

  return { supported, say, stop, speakCurrentStep, listenOnce, stepIndex };
}
