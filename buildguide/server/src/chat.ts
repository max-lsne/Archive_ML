import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { CAMERA_HINTS, describeHardware, type AssemblyPlan } from "../../shared/plan.js";
import type { ChatEvent, ChatMessage, UiAction } from "../../shared/project.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { getClient } from "./planner.js";
import { chatSystem, currentStepNote } from "./prompts.js";

export interface ChatContext {
  plan: AssemblyPlan;
  history: ChatMessage[];
  stepIndex: number;
  manual?: { title: string; bytes: Buffer };
}

export type Emit = (event: ChatEvent) => void;

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
      const byComponent = new Map<string, string[]>();
      for (const inst of plan.instances) {
        byComponent.set(inst.componentId, [...(byComponent.get(inst.componentId) ?? []), inst.id]);
      }
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
          source: { type: "base64", media_type: "application/pdf", data: ctx.manual.bytes.toString("base64") },
          cache_control: { type: "ephemeral" },
        },
        { type: "text", text: "Here is the original assembly manual for reference." },
      ],
    });
    messages.push({ role: "assistant", content: "Thanks, I have the manual and the assembly plan. What would you like to know?" });
  }
  const history = ctx.history.slice(-30).filter((m) => m.content.trim().length > 0);
  if (!history.length || history[history.length - 1].role !== "user") {
    throw new Error("The last message must come from the user.");
  }
  for (const m of history) messages.push({ role: m.role, content: m.content });
  // Operator context after the user's turn: keeps the cached prefix intact.
  messages.push({ role: "system", content: currentStepNote(plan, ctx.stepIndex) });

  let fullText = "";
  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let jsonRetries = 0;

  for (let iteration = 0; iteration < 6; iteration++) {
    const stream = anthropic.beta.messages.stream({
      model: config.model,
      max_tokens: 4000,
      output_config: { effort: config.chatEffort },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
      system: [{ type: "text", text: chatSystem(plan, Boolean(ctx.manual)), cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      messages,
    });
    stream.on("text", (delta) => {
      fullText += delta;
      emit({ type: "text", text: delta });
    });

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
      log.warn("chat: tool input was not parseable JSON, re-issuing the turn");
      continue;
    }

    usage = {
      inputTokens: usage.inputTokens + message.usage.input_tokens,
      outputTokens: usage.outputTokens + message.usage.output_tokens,
      cacheReadTokens: usage.cacheReadTokens + (message.usage.cache_read_input_tokens ?? 0),
      cacheWriteTokens: usage.cacheWriteTokens + (message.usage.cache_creation_input_tokens ?? 0),
    };

    if (message.stop_reason === "refusal") {
      if (!fullText) {
        const t = "I can't help with that one. Ask me anything about assembling this product.";
        fullText = t;
        emit({ type: "text", text: t });
      }
      break;
    }
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }
    // A tool input cut off at max_tokens can still parse; never run it.
    if (message.stop_reason === "max_tokens") break;
    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (message.stop_reason !== "tool_use" || toolUses.length === 0) break;

    messages.push({ role: "assistant", content: message.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = toolUses.map((tu) => {
      const { ok, result } = executeUiTool(plan, tu.name, tu.input, emit);
      return { type: "tool_result", tool_use_id: tu.id, content: result, is_error: !ok };
    });
    messages.push({ role: "user", content: results });
  }

  emit({
    type: "done",
    text: fullText,
    usage: { model: config.model, ...usage, durationMs: Date.now() - started },
  });
}

// ---------------------------------------------------------------------------
// Demo assistant: answers from the plan with simple rules when no API key is set.

export async function runMockChat(ctx: ChatContext, emit: Emit): Promise<void> {
  const { plan } = ctx;
  const last = ctx.history[ctx.history.length - 1];
  const q = (last?.content ?? "").toLowerCase();
  const step = plan.steps[ctx.stepIndex];
  const say = async (text: string) => {
    // Simulate streaming so the UI path is identical to the real assistant.
    const words = text.split(/(\s+)/);
    for (const w of words) {
      emit({ type: "text", text: w });
      await new Promise((r) => setTimeout(r, 12));
    }
    emit({ type: "done", text });
  };
  const act = (action: UiAction) => emit({ type: "action", action });

  const stepMatch = q.match(/step\s+(\d+)/) || q.match(/(?:go to|show|open)\s+(?:the\s+)?(\d+)/);
  if (stepMatch) {
    const n = parseInt(stepMatch[1], 10);
    if (n >= 1 && n <= plan.steps.length) {
      act({ name: "go_to_step", input: { step: n } });
      return say(`Step ${n}: ${plan.steps[n - 1].title}. ${plan.steps[n - 1].voiceScript}`);
    }
    return say(`This plan has ${plan.steps.length} steps, so there is no step ${n}.`);
  }
  const isShortCommand = q.split(/\s+/).length <= 3;
  if (isShortCommand && /\b(next|continue|done)\b/.test(q) && step && ctx.stepIndex + 1 < plan.steps.length) {
    act({ name: "go_to_step", input: { step: ctx.stepIndex + 2 } });
    const s = plan.steps[ctx.stepIndex + 1];
    return say(`On to step ${s.id}: ${s.title}. ${s.voiceScript}`);
  }
  if (isShortCommand && /\b(back|previous)\b/.test(q) && ctx.stepIndex > 0) {
    act({ name: "go_to_step", input: { step: ctx.stepIndex } });
    const s = plan.steps[ctx.stepIndex - 1];
    return say(`Back to step ${s.id}: ${s.title}. ${s.voiceScript}`);
  }

  // Part lookup by name or label
  const byComponent = new Map<string, string[]>();
  for (const inst of plan.instances) byComponent.set(inst.componentId, [...(byComponent.get(inst.componentId) ?? []), inst.id]);
  const comp = plan.components.find(
    (c) => q.includes(c.name.toLowerCase()) || (c.label && new RegExp(`\\b(part\\s+)?${escapeRe(c.label.toLowerCase())}\\b`).test(q)),
  );
  if (comp && /where|what|which|show|find|look|is|does|go/.test(q)) {
    const ids = byComponent.get(comp.id) ?? [];
    const usedIn = plan.steps.filter((s) => s.addInstances.some((id) => ids.includes(id)) || s.hardware.some((h) => h.componentId === comp.id));
    if (ids.length) act({ name: "highlight_parts", input: { instanceIds: ids } });
    if (usedIn[0]) act({ name: "go_to_step", input: { step: usedIn[0].id } });
    act({ name: "set_exploded", input: { enabled: ids.length > 0 && !comp.isHardware } });
    return say(
      `${comp.name}${comp.label ? ` (${comp.label})` : ""}: ${comp.description || "see the highlighted part in the 3D view."} There ${comp.qty === 1 ? "is one" : `are ${comp.qty}`} in the box${usedIn.length ? `, used in step${usedIn.length > 1 ? "s" : ""} ${usedIn.map((s) => s.id).join(", ")}` : ""}. I've highlighted it for you.`,
    );
  }
  if (/\btools?\b/.test(q)) {
    const req = plan.tools.filter((t) => t.required).map((t) => t.name);
    const opt = plan.tools.filter((t) => !t.required).map((t) => t.name);
    return say(`You need: ${req.join(", ") || "no tools beyond what's in the box"}.${opt.length ? ` Optional: ${opt.join(", ")}.` : ""}`);
  }
  if (/how long|time|minutes|hours/.test(q)) {
    return say(`Plan on about ${plan.product.estimatedMinutes} minutes with ${plan.product.peopleNeeded === 1 ? "one person" : `${plan.product.peopleNeeded} people`}. ${step ? `Step ${step.id} should take around ${Math.max(1, Math.round(step.durationMinutes))} minutes.` : ""}`);
  }
  if (/safety|warning|danger|careful/.test(q)) {
    return say(`Key safety notes: ${plan.safety.join(" ")}${step?.warnings.length ? ` For this step: ${step.warnings.join(" ")}` : ""}`);
  }
  if (step && /(parts|hardware|need|which screws|what do i need)/.test(q)) {
    const hw = describeHardware(plan, step);
    act({ name: "highlight_parts", input: { instanceIds: step.addInstances } });
    return say(`For step ${step.id} you need ${hw || "no hardware"}${step.tools.length ? `, plus ${step.tools.join(" and ")}` : ""}. Parts added: ${step.addInstances.length ? step.addInstances.map((id) => plan.instances.find((i) => i.id === id)?.label || id).join(", ") : "none"}.`);
  }
  if (/explode|exploded|spread/.test(q)) {
    act({ name: "set_exploded", input: { enabled: true } });
    return say("Here's the exploded view so you can see how the parts fit together.");
  }
  if (/repeat|again|what do i do/.test(q) && step) {
    return say(step.voiceScript);
  }
  return say(
    `I'm running in demo mode without an API key, so I can only answer from the plan itself. ${step ? `Right now you're on step ${step.id}: ${step.voiceScript}` : ""} Try asking "where does part A go", "what tools do I need", or "go to step 3". Add an ANTHROPIC_API_KEY to chat with Claude about the actual manual.`,
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
