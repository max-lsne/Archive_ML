import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { AssemblyPlanSchema, normalizePlan, type AssemblyPlan } from "../../shared/plan.js";
import type { Usage } from "../../shared/project.js";
import { SAMPLE_PLANS } from "../../shared/samples/index.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import type { Gathered } from "./fetcher.js";
import { PLANNER_SYSTEM, plannerUserText } from "./prompts.js";

export interface PlanResult {
  plan: AssemblyPlan;
  usage: Usage;
  /** Which attached PDFs were passed to Claude as full documents. */
  sentAsDocument: boolean[];
}

export interface PlannerProgress {
  (message: string, chars?: number): void;
}

export interface Planner {
  /** `signal` aborts the model call when the project is deleted mid-flight. */
  generate(gathered: Gathered, notes: string, onProgress: PlannerProgress, signal?: AbortSignal): Promise<PlanResult>;
}

/** Thrown when the caller aborted the generation (project deleted). */
export class PlanCancelled extends Error {
  constructor() {
    super("plan generation cancelled");
    this.name = "PlanCancelled";
  }
}

let client: Anthropic | undefined;
export function getClient(): Anthropic {
  // Credentials resolve from ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile.
  client ??= new Anthropic({ maxRetries: 2, timeout: 20 * 60 * 1000 });
  return client;
}

// Only the JSON schema is sent. The helper's own `parse` would make finalMessage()
// reject on truncated or refused output before stop_reason can be inspected.
const PLAN_SCHEMA = betaZodOutputFormat(AssemblyPlanSchema).schema;

export class ClaudePlanner implements Planner {
  async generate(gathered: Gathered, notes: string, onProgress: PlannerProgress, signal?: AbortSignal): Promise<PlanResult> {
    const anthropic = getClient();
    const started = Date.now();
    if (signal?.aborted) throw new PlanCancelled();

    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    const sentAsDocument: boolean[] = [];
    const pdfSummaries: Parameters<typeof plannerUserText>[0]["pdfSummaries"] = [];

    // Base64 inflates payloads by 4/3 and the API caps a request at 32 MB, so
    // attach documents/images only while the encoded total stays within budget.
    const base64Size = (bytes: number) => Math.ceil(bytes / 3) * 4;
    let payload = 0;
    for (const pdf of gathered.pdfs) {
      const encoded = base64Size(pdf.bytes.length);
      const attach =
        pdf.bytes.length <= config.maxAttachPdfBytes &&
        payload + encoded <= config.maxRequestBytes &&
        // pages === 0 means the text layer could not be read: fall back to text only.
        pdf.pages > 0 &&
        pdf.pages <= config.maxPdfPages;
      if (attach) payload += encoded;
      sentAsDocument.push(attach);
      if (attach) {
        content.push({
          type: "document",
          title: pdf.title,
          context: "Assembly manual for the product. Pages are mostly pictorial; read the diagrams carefully.",
          source: { type: "base64", media_type: "application/pdf", data: pdf.bytes.toString("base64") },
        });
      }
      pdfSummaries.push({
        title: pdf.title,
        pages: pdf.pages,
        // When the PDF is attached, Claude reads it directly; a short text excerpt still helps with part lists.
        textExcerpt: attach ? pdf.text.slice(0, 6000) : pdf.text,
        sentAsDocument: attach,
      });
    }
    for (const img of gathered.images) {
      const encoded = base64Size(img.bytes.length);
      if (payload + encoded > config.maxRequestBytes) continue;
      payload += encoded;
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.bytes.toString("base64") },
      });
    }
    content.push({
      type: "text",
      text: plannerUserText({
        url: gathered.finalUrl,
        pageTitle: gathered.pageTitle,
        pageDescription: gathered.pageDescription,
        pageText: gathered.pageText,
        pdfSummaries,
        notes,
        imageCount: gathered.images.length,
      }),
    });

    onProgress(`Asking ${config.model} to study the documentation…`, 0);
    log.info(`planner: model=${config.model} effort=${config.effort} pdfs=${gathered.pdfs.length} images=${gathered.images.length}`);

    let chars = 0;
    let lastTick = 0;
    const stream = anthropic.beta.messages.stream(
      {
        model: config.model,
        max_tokens: 64000,
        // Opus 5.5 always thinks; effort is the depth control. Fallbacks re-run a
        // (rare) safety decline on Anthropic's recommended substitute model.
        output_config: { effort: config.effort, format: { type: "json_schema", schema: PLAN_SCHEMA } },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: PLANNER_SYSTEM,
        messages: [{ role: "user", content }],
      },
      // Deleting the project aborts the request so the tokens are not billed.
      { signal },
    );
    stream.on("text", (delta) => {
      chars += delta.length;
      const now = Date.now();
      if (now - lastTick > 400) {
        lastTick = now;
        onProgress("Computing the 3D assembly plan…", chars);
      }
    });

    let message: Awaited<ReturnType<typeof stream.finalMessage>>;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      if (signal?.aborted || err instanceof Anthropic.APIUserAbortError) throw new PlanCancelled();
      if (err instanceof Anthropic.AuthenticationError) {
        throw new Error("Claude rejected the API key. Check ANTHROPIC_API_KEY.");
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new Error("Claude is rate-limiting this account right now. Try again in a minute.");
      }
      if (err instanceof Anthropic.BadRequestError) {
        throw new Error(`Claude rejected the request: ${err.message}`);
      }
      if (err instanceof Anthropic.APIError) {
        throw new Error(`Claude API error ${err.status ?? ""}: ${err.message}`);
      }
      throw err;
    }

    if (message.stop_reason === "refusal") {
      const why = message.stop_details?.type === "refusal" ? message.stop_details.explanation ?? "" : "";
      throw new Error(`Claude declined to process this document${why ? `: ${why}` : "."}`);
    }
    if (message.stop_reason === "max_tokens") {
      throw new Error("The plan was too long to finish. Try a product with a shorter manual, or split it in two.");
    }
    if (message.stop_reason === "model_context_window_exceeded") {
      throw new Error("The documentation is too large for the model's context window. Try a direct link to a shorter manual.");
    }
    if (message.stop_reason && message.stop_reason !== "end_turn") {
      throw new Error(`Claude stopped early (${message.stop_reason}). Please try again.`);
    }

    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const plan = normalizePlan(parseLooseJson(text));
    if (!plan.steps.length || !plan.instances.length) {
      throw new Error("Claude returned a plan with no steps or parts. Please try again.");
    }

    const usage: Usage = {
      model: message.model,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      durationMs: Date.now() - started,
    };
    log.info(`planner: done in ${(usage.durationMs / 1000).toFixed(1)}s, in=${usage.inputTokens} out=${usage.outputTokens}, ${plan.steps.length} steps, ${plan.instances.length} instances`);
    return { plan, usage, sentAsDocument };
  }
}

/** Parse JSON that may be wrapped in a code fence or have trailing prose. */
export function parseLooseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* fall through to the friendly error */
      }
    }
    throw new Error("Claude's answer was not valid JSON.");
  }
}

/** Returns a bundled sample plan after a short delay; lets the whole UI run without an API key. */
export class MockPlanner implements Planner {
  async generate(gathered: Gathered, _notes: string, onProgress: PlannerProgress, signal?: AbortSignal): Promise<PlanResult> {
    const started = Date.now();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const checkCancelled = () => {
      if (signal?.aborted) throw new PlanCancelled();
    };
    checkCancelled();
    onProgress("(mock) Pretending to study the documentation…", 0);
    await sleep(800);
    const text = JSON.stringify(pickSample(gathered.url + " " + gathered.pageTitle + " " + gathered.pageText.slice(0, 2000)));
    for (let i = 1; i <= 6; i++) {
      checkCancelled();
      onProgress("(mock) Computing the 3D assembly plan…", Math.round((text.length * i) / 6));
      await sleep(300);
    }
    checkCancelled();
    const plan = normalizePlan(JSON.parse(text));
    return {
      plan,
      usage: { model: "mock", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, durationMs: Date.now() - started },
      sentAsDocument: gathered.pdfs.map(() => false),
    };
  }
}

function pickSample(hint: string): AssemblyPlan {
  const h = hint.toLowerCase();
  const tent = SAMPLE_PLANS.find((s) => s.id === "sample-dome-tent")!.plan;
  const bookcase = SAMPLE_PLANS.find((s) => s.id === "sample-bookcase")!.plan;
  return /tent|camp|canopy|gazebo|awning/.test(h) ? tent : bookcase;
}

export function createPlanner(): Planner {
  if (config.mock) return new MockPlanner();
  return new ClaudePlanner();
}
