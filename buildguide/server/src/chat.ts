import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { CAMERA_HINTS, describeHardware, instancesByComponent, type AssemblyPlan } from "../../shared/plan.js";
import type { ChatEvent, ChatMessage, UiAction } from "../../shared/project.js";
import { parseVoiceCommand, type VoiceCommand } from "../../shared/voice.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { getClient } from "./planner.js";
import { chatSystem, currentStepNote } from "./prompts.js";

export interface ChatContext {
  plan: AssemblyPlan;
  history: ChatMessage[];
  stepIndex: number;
  /** Manual PDF already base64-encoded (cached per project by the route). */
  manual?: { title: string; data: string };
  /** Aborted when the browser disconnects; stops the model call and the tool loop. */
  signal?: AbortSignal;
}

export type Emit = (event: ChatEvent) => void;

/**
 * Keep the most recent `max` turns, drop empty ones, and re-anchor on a user
 * message: the API requires the first message of a conversation to be from the user.
 */
export function normalizeHistory(history: ChatMessage[], max = 30): ChatMessage[] {
  const recent = history.slice(-max).filter((m) => m.content.trim().length > 0);
  const firstUser = recent.findIndex((m) => m.role === "user");
  return firstUser < 0 ? [] : recent.slice(firstUser);
}

// ---------------------------------------------------------------------------
// UI tools: executed by the browser, so the server just validates, forwards and acks.

const GoToStep = z.object({ step: z.number().int() });
const HighlightParts = z.object({ instanceIds: z.array(z.string()) });
const SetView = z.object({ view: z.enum(CAMERA_HINTS) });
const SetExploded = z.object({ enabled: z.boolean() });

const TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  {
    name: "go_to_step",
    description: "Move the 3D view and the step panel to the given step (1-based). Use when the user wants to move on, go back, or asks about a specific step.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { step: { type: "integer", description: "1-based step number" } },
      required: ["step"],
      additionalProperties: false,
    },
  },
  {
    name: "highlight_parts",
    description: "Highlight parts in the 3D view so the user can see where they go. Pass instance ids from the plan's instances array (not component ids). Pass an empty array to clear highlights.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { instanceIds: { type: "array", items: { type: "string" } } },
      required: ["instanceIds"],
      additionalProperties: false,
    },
  },
  {
    name: "set_view",
    description: "Rotate the camera to a preset angle.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { view: { type: "string", enum: [...CAMERA_HINTS] } },
      required: ["view"],
      additionalProperties: false,
    },
  },
  {
    name: "set_exploded",
    description: "Turn the exploded view on or off. Exploded view pulls parts apart so joints are visible.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { enabled: { type: "boolean" } },
      required: ["enabled"],
      additionalProperties: false,
    },
  },
];

function executeUiTool(
  plan: AssemblyPlan,
  name: string,
  input: unknown,
  emit: Emit,
): { ok: boolean; result: string } {
  switch (name) {
    case "go_to_step": {
      const p = GoToStep.safeParse(input);
      if (!p.success) return { ok: false, result: "Invalid input: expected { step: integer }" };
      if (p.data.step < 1 || p.data.step > plan.steps.length) {
        return { ok: false, result: `Step must be between 1 and ${plan.steps.length}.` };
      }
      emit({ type: "action", action: { name: "go_to_step", input: p.data } });
      return { ok: true, result: `Moved to step ${p.data.step}: ${plan.steps[p.data.step - 1].title}` };
    }
    case "highlight_parts": {
      const p = HighlightParts.safeParse(input);
      if (!p.success) return { ok: false, result: "Invalid input: expected { instanceIds: string[] }" };
      const known = new Set(plan.instances.map((i) => i.id));
      const byComponent = instancesByComponent(plan);
      // Be forgiving: a component id expands to all of its instances.
      const ids = new Set<string>();
      const unknown: string[] = [];
      for (const id of p.data.instanceIds) {
        if (known.has(id)) ids.add(id);
        else if (byComponent.has(id)) byComponent.get(id)!.forEach((x) => ids.add(x));
        else unknown.push(id);
      }
      emit({ type: "action", action: { name: "highlight_parts", input: { instanceIds: [...ids] } } });
      return {
        ok: unknown.length === 0,
        result: unknown.length ? `Highlighted ${ids.size} part(s). Unknown ids ignored: ${unknown.join(", ")}` : `Highlighted ${ids.size} part(s).`,
      };
    }
    case "set_view": {
      const p = SetView.safeParse(input);
      if (!p.success) return { ok: false, result: `Invalid view. Use one of ${CAMERA_HINTS.join(", ")}` };
      emit({ type: "action", action: { name: "set_view", input: p.data } });
      return { ok: true, result: "View changed." };
    }
    case "set_exploded": {
      const p = SetExploded.safeParse(input);
      if (!p.success) return { ok: false, result: "Invalid input: expected { enabled: boolean }" };
      emit({ type: "action", action: { name: "set_exploded", input: p.data } });
      return { ok: true, result: `Exploded view ${p.data.enabled ? "on" : "off"}.` };
    }
    default:
      return { ok: false, result: `Unknown tool ${name}` };
  }
}

// ---------------------------------------------------------------------------

export async function runClaudeChat(ctx: ChatContext, emit: Emit): Promise<void> {
  const anthropic = getClient();
  const { plan } = ctx;
  const started = Date.now();

  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  if (ctx.manual) {
    messages.push({
      role: "user",
      content: [
        {
          type: "document",
          title: ctx.manual.title,
          context: "The original assembly manual. Mostly diagrams; refer to it when asked about a page or a detail.",
          source: { type: "base64", media_type: "application/pdf", data: ctx.manual.data },
          cache_control: { type: "ephemeral" },
        },
        { type: "text", text: "Here is the original assembly manual for reference." },
      ],
    });
    messages.push({ role: "assistant", content: "Thanks, I have the manual and the assembly plan. What would you like to know?" });
  }
  const history = normalizeHistory(ctx.history);
  if (!history.length || history[history.length - 1].role !== "user") {
    throw new Error("The last message must come from the user.");
  }
  for (const m of history) messages.push({ role: m.role, content: m.content });
  // Operator context after the user's turn: keeps the cached prefix intact.
  messages.push({ role: "system", content: currentStepNote(plan, ctx.stepIndex) });

  let fullText = "";
  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let jsonRetries = 0;
  const MAX_ITERATIONS = 6;
  const signal = ctx.signal;

  const emitText = (text: string) => {
    fullText += text;
    emit({ type: "text", text });
  };
  // Constant for the whole request (and the stable, cached prefix of every turn).
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: "text", text: chatSystem(plan, Boolean(ctx.manual)), cache_control: { type: "ephemeral" } },
  ];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (signal?.aborted) return; // the browser is gone; end quietly
    let turnText = "";
    const stream = anthropic.beta.messages.stream(
      {
        model: config.model,
        max_tokens: 8000,
        output_config: { effort: config.chatEffort },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        cache_control: { type: "ephemeral" },
        system,
        tools: TOOLS,
        messages,
      },
      { signal },
    );
    stream.on("text", (delta) => {
      // Text from a new model turn (after tool calls) must not run into the previous sentence.
      if (turnText === "" && fullText && !/\s$/.test(fullText)) emitText("\n\n");
      turnText += delta;
      emitText(delta);
    });

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      if (signal?.aborted || err instanceof Anthropic.APIUserAbortError) return;
      // Re-issuing after text already reached the client would stream the answer twice.
      if (err instanceof Anthropic.APIError || turnText.length > 0 || jsonRetries++ >= 2) throw err;
      log.warn("chat: tool input was not parseable JSON, re-issuing the turn");
      continue;
    }
    if (signal?.aborted) return;

    usage = {
      inputTokens: usage.inputTokens + message.usage.input_tokens,
      outputTokens: usage.outputTokens + message.usage.output_tokens,
      cacheReadTokens: usage.cacheReadTokens + (message.usage.cache_read_input_tokens ?? 0),
      cacheWriteTokens: usage.cacheWriteTokens + (message.usage.cache_creation_input_tokens ?? 0),
    };

    if (message.stop_reason === "refusal") {
      if (!fullText) emitText("I can't help with that one. Ask me anything about assembling this product.");
      break;
    }
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }
    // A tool input cut off at max_tokens can still parse; never run it, and say so.
    if (message.stop_reason === "max_tokens") {
      emitText(`${fullText ? "\n\n" : ""}[The answer was cut short. Ask again more specifically.]`);
      break;
    }
    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (message.stop_reason !== "tool_use" || toolUses.length === 0) break;

    messages.push({ role: "assistant", content: message.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = toolUses.map((tu) => {
      const { ok, result } = executeUiTool(plan, tu.name, tu.input, emit);
      return { type: "tool_result", tool_use_id: tu.id, content: result, is_error: !ok };
    });
    messages.push({ role: "user", content: results });
    if (iteration === MAX_ITERATIONS - 1) {
      // Tools ran but the model never got to answer: don't end in silence.
      emitText(`${fullText ? "\n\n" : ""}[I stopped after too many view actions. Ask again and I'll keep it shorter.]`);
    }
  }

  emit({
    type: "done",
    text: fullText,
    usage: { model: config.model, ...usage, durationMs: Date.now() - started },
  });
}

// ---------------------------------------------------------------------------
// Demo assistant: answers from the plan with simple rules when no API key is set.

type Component = AssemblyPlan["components"][number];

/** How the demo assistant decided to handle a message. Pure, so it can be unit-tested. */
export type MockRoute =
  | { kind: "command"; command: Exclude<VoiceCommand, { type: "ask" }> }
  | { kind: "component"; component: Component }
  | { kind: "tools" }
  | { kind: "duration" }
  | { kind: "safety" }
  | { kind: "step_parts" }
  | { kind: "explode" }
  | { kind: "repeat" }
  | { kind: "fallback" };

/**
 * One parser for both voice and typed input: navigation and other commands go
 * through the shared parseVoiceCommand; anything else is a question, and a
 * question that names a part is about that part before any other heuristic
 * ("back panel" is a part, not "go back"; "how long does step 3 take" is a
 * duration question, not a jump).
 */
export function routeMockQuestion(plan: AssemblyPlan, text: string): MockRoute {
  const command = parseVoiceCommand(text);
  if (command.type !== "ask") return { kind: "command", command };
  const q = command.text.toLowerCase();
  const component = findComponentInQuestion(plan, q);
  if (component) return { kind: "component", component };
  if (/\btools?\b/.test(q)) return { kind: "tools" };
  if (/how long|time|minutes|hours/.test(q)) return { kind: "duration" };
  if (/safety|warning|danger|careful/.test(q)) return { kind: "safety" };
  if (/(parts|hardware|need|which screws|what do i need)/.test(q)) return { kind: "step_parts" };
  if (/explode|exploded|spread/.test(q)) return { kind: "explode" };
  if (/repeat|again|what do i do/.test(q)) return { kind: "repeat" };
  return { kind: "fallback" };
}

export async function runMockChat(ctx: ChatContext, emit: Emit): Promise<void> {
  const { plan } = ctx;
  const last = ctx.history[ctx.history.length - 1];
  const step = plan.steps[ctx.stepIndex];
  const say = async (text: string) => {
    // Simulate streaming so the UI path is identical to the real assistant;
    // stop as soon as the browser has gone away, like the Claude path does.
    const words = text.split(/(\s+)/);
    for (const w of words) {
      if (ctx.signal?.aborted) return;
      emit({ type: "text", text: w });
      await new Promise((r) => setTimeout(r, 12));
    }
    if (ctx.signal?.aborted) return;
    emit({ type: "done", text });
  };
  const act = (action: UiAction) => emit({ type: "action", action });
  const goTo = (n: number) => {
    const target = plan.steps[n - 1];
    act({ name: "go_to_step", input: { step: n } });
    return say(`Step ${n}: ${target.title}. ${target.voiceScript}`);
  };
  const stepParts = () => {
    if (!step) return say("Pick a step first and I'll list its parts.");
    const hw = describeHardware(plan, step);
    act({ name: "highlight_parts", input: { instanceIds: step.addInstances } });
    return say(
      `For step ${step.id} you need ${hw || "no hardware"}${step.tools.length ? `, plus ${step.tools.join(" and ")}` : ""}. Parts added: ${step.addInstances.length ? step.addInstances.map((id) => plan.instances.find((i) => i.id === id)?.label || id).join(", ") : "none"}.`,
    );
  };
  const toolsAnswer = () => {
    const req = plan.tools.filter((t) => t.required).map((t) => t.name);
    const opt = plan.tools.filter((t) => !t.required).map((t) => t.name);
    return say(`You need: ${req.join(", ") || "no tools beyond what's in the box"}.${opt.length ? ` Optional: ${opt.join(", ")}.` : ""}`);
  };

  const route = routeMockQuestion(plan, last?.content ?? "");
  switch (route.kind) {
    case "command": {
      const c = route.command;
      switch (c.type) {
        case "next":
          if (ctx.stepIndex + 1 >= plan.steps.length) return say("That was the last step. Nice work!");
          return goTo(ctx.stepIndex + 2);
        case "prev":
          if (ctx.stepIndex === 0) return say("You're already on the first step.");
          return goTo(ctx.stepIndex);
        case "goto":
          if (c.step < 1 || c.step > plan.steps.length) return say(`This plan has ${plan.steps.length} steps, so there is no step ${c.step}.`);
          return goTo(c.step);
        case "first":
          return goTo(1);
        case "last":
          return goTo(plan.steps.length);
        case "repeat":
          return say(step ? step.voiceScript : "Pick a step and I'll read it to you.");
        case "parts":
          return stepParts();
        case "tools":
          return toolsAnswer();
        case "explode":
          act({ name: "set_exploded", input: { enabled: c.enabled } });
          return say(c.enabled ? "Here's the exploded view so you can see how the parts fit together." : "Back to the assembled view.");
        case "stop":
          return say("Okay.");
      }
      return say("Okay.");
    }
    case "component": {
      const comp = route.component;
      const ids = instancesByComponent(plan).get(comp.id) ?? [];
      const usedIn = plan.steps.filter((s) => s.addInstances.some((id) => ids.includes(id)) || s.hardware.some((h) => h.componentId === comp.id));
      // Step first: a step change resets highlights on the client, so highlight after it.
      if (usedIn[0]) act({ name: "go_to_step", input: { step: usedIn[0].id } });
      if (ids.length) act({ name: "highlight_parts", input: { instanceIds: ids } });
      act({ name: "set_exploded", input: { enabled: ids.length > 0 && !comp.isHardware } });
      return say(
        `${comp.name}${comp.label ? ` (${comp.label})` : ""}: ${comp.description || "see the highlighted part in the 3D view."} There ${comp.qty === 1 ? "is one" : `are ${comp.qty}`} in the box${usedIn.length ? `, used in step${usedIn.length > 1 ? "s" : ""} ${usedIn.map((s) => s.id).join(", ")}` : ""}. I've highlighted it for you.`,
      );
    }
    case "tools":
      return toolsAnswer();
    case "duration":
      return say(
        `Plan on about ${plan.product.estimatedMinutes} minutes with ${plan.product.peopleNeeded === 1 ? "one person" : `${plan.product.peopleNeeded} people`}. ${step ? `Step ${step.id} should take around ${Math.max(1, Math.round(step.durationMinutes))} minutes.` : ""}`,
      );
    case "safety":
      return say(`Key safety notes: ${plan.safety.join(" ")}${step?.warnings.length ? ` For this step: ${step.warnings.join(" ")}` : ""}`);
    case "step_parts":
      return stepParts();
    case "explode":
      act({ name: "set_exploded", input: { enabled: true } });
      return say("Here's the exploded view so you can see how the parts fit together.");
    case "repeat":
      return say(step ? step.voiceScript : "Pick a step and I'll read it to you.");
    case "fallback":
      return say(
        `I'm running in demo mode without an API key, so I can only answer from the plan itself. ${step ? `Right now you're on step ${step.id}: ${step.voiceScript}` : ""} Try asking "where does part A go", "what tools do I need", or "go to step 3". Add an ANTHROPIC_API_KEY to chat with Claude about the actual manual.`,
      );
  }
}

/**
 * Which component is a (lower-cased) question about? Component names win,
 * longest match first. Labels match on their own only when they are longer
 * than one character and not purely numeric; single letters ("A") and numbers
 * ("12") match only as "part A" / "part 12", so the article "a" and step or
 * quantity numbers never hijack a question.
 */
export function findComponentInQuestion(plan: AssemblyPlan, q: string): Component | undefined {
  const byName = plan.components
    .filter((c) => c.name.trim() && new RegExp(`\\b${escapeRe(c.name.toLowerCase())}s?\\b`).test(q))
    .sort((a, b) => b.name.length - a.name.length);
  if (byName.length) return byName[0];
  return plan.components.find((c) => {
    const label = c.label.trim().toLowerCase();
    if (!label) return false;
    const needsPartPrefix = label.length === 1 || /^\d+$/.test(label);
    const re = needsPartPrefix ? new RegExp(`\\bpart\\s+${escapeRe(label)}\\b`) : new RegExp(`\\b(?:part\\s+)?${escapeRe(label)}\\b`);
    return re.test(q);
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
