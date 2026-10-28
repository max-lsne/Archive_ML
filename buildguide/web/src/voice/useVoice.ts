import { useCallback, useEffect, useMemo, useRef } from "react";
import { describeHardware } from "../../../shared/plan";
import { parseVoiceCommand, type VoiceCommand } from "../../../shared/voice";
import { useStore } from "../store";
import { Recognizer, sttSupported } from "./stt";
import { speak, stopSpeaking, ttsSupported } from "./tts";

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
  const supported = useMemo(() => ({ tts: ttsSupported(), stt: sttSupported() }), []);

  const say = useCallback(
    (text: string) => {
      if (!supported.tts || !text.trim()) return;
      // Pause the microphone so we don't transcribe ourselves.
      if (handsFreeRef.current) recognizer.stop();
      speakingRef.current = true;
      setVoiceStatus("speaking");
      speak(text, {
        rate: voice.rate,
        voiceURI: voice.voiceURI,
        onEnd: () => {
          speakingRef.current = false;
          setVoiceStatus(handsFreeRef.current ? "listening" : "idle");
          if (handsFreeRef.current) scheduleListen(250);
        },
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [voice.rate, voice.voiceURI, supported.tts],
  );

  const stop = useCallback(() => {
    stopSpeaking();
    speakingRef.current = false;
    setVoiceStatus(handsFreeRef.current ? "listening" : "idle");
    if (handsFreeRef.current) scheduleListen(100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const speakCurrentStep = useCallback(() => {
    const s = useStore.getState();
    const step = s.plan?.steps[s.stepIndex];
    if (!step) return;
    say(`Step ${step.id}. ${step.title}. ${step.voiceScript}`);
  }, [say]);

  // Speak the step whenever the user navigates (speakNonce bumps) if enabled.
  const firstNonce = useRef(true);
  useEffect(() => {
    if (!plan) return;
    if (firstNonce.current) {
      firstNonce.current = false;
      return; // don't talk the moment the page opens
    }
    if (voice.speakSteps) speakCurrentStep();
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
          const added = step.addInstances
            .map((id) => {
              const inst = p.instances.find((i) => i.id === id);
              const comp = inst && p.components.find((c) => c.id === inst.componentId);
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

  // ---- hands-free listening -------------------------------------------------
  const scheduleListen = useCallback((delay: number) => {
    if (restartTimer.current) window.clearTimeout(restartTimer.current);
    restartTimer.current = window.setTimeout(() => {
      restartTimer.current = null;
      if (!handsFreeRef.current || speakingRef.current) return;
      startListening();
    }, delay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startListening = useCallback(() => {
    if (!supported.stt || !handsFreeRef.current || speakingRef.current) return;
    const ok = recognizer.start({
      continuous: true,
      onResult: (text, isFinal) => {
        setLastHeard(text);
        if (isFinal) {
          const cmd = parseVoiceCommand(text);
          dispatch(cmd);
        }
      },
      onEnd: () => {
        if (handsFreeRef.current && !speakingRef.current) scheduleListen(400);
      },
      onError: (err) => {
        if (err === "not-allowed" || err === "service-not-allowed") {
          useStore.getState().setVoice({ handsFree: false });
          setLastHeard("Microphone access was blocked.");
        }
      },
    });
    setVoiceStatus(ok ? "listening" : "idle");
  }, [recognizer, supported.stt, dispatch, scheduleListen, setLastHeard, setVoiceStatus]);

  useEffect(() => {
    handsFreeRef.current = voice.handsFree;
    if (voice.handsFree) {
      setLastHeard("");
      startListening();
    } else {
      recognizer.stop();
      if (!speakingRef.current) setVoiceStatus("idle");
    }
    return () => {
      if (restartTimer.current) window.clearTimeout(restartTimer.current);
    };
  }, [voice.handsFree, startListening, recognizer, setVoiceStatus, setLastHeard]);

  useEffect(() => () => {
    recognizer.stop();
    stopSpeaking();
  }, [recognizer]);

  /** Push-to-talk: one utterance, resolved with the final transcript ("" if nothing). */
  const listenOnce = useCallback((): Promise<string> => {
    return new Promise((resolve) => {
      if (!supported.stt) return resolve("");
      const wasHandsFree = handsFreeRef.current;
      recognizer.stop();
      stopSpeaking();
      let finalText = "";
      let interim = "";
      setVoiceStatus("listening");
      const ok = recognizer.start({
        continuous: false,
        onResult: (text, isFinal) => {
          if (isFinal) finalText += (finalText ? " " : "") + text;
          else interim = text;
          setLastHeard(finalText || interim);
        },
        onEnd: () => {
          setVoiceStatus(wasHandsFree ? "listening" : "idle");
          if (wasHandsFree) scheduleListen(300);
          resolve(finalText || interim);
        },
        onError: () => resolve(finalText || interim),
      });
      if (!ok) resolve("");
    });
  }, [recognizer, supported.stt, scheduleListen, setLastHeard, setVoiceStatus]);

  return { supported, say, stop, speakCurrentStep, listenOnce, stepIndex };
}
