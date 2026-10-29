/**
 * The AssemblyPlan is the contract between Claude (which computes it from the
 * manual) and the 3D/voice client (which renders and narrates it).
 *
 * Geometry conventions (also spelled out to Claude in the planner prompt):
 *  - Units are centimetres. Right-handed, Y is up, +Z points toward the front
 *    of the product (toward the person standing in front of it), +X to their right.
 *  - The origin is the centre of the assembled product's footprint, on the floor (y = 0).
 *  - Every instance's `position` is the centre of the part's bounding box in its
 *    final, assembled pose; `rotation` is an XYZ Euler rotation in degrees applied
 *    around that centre. `size` is the part's bounding box before rotation.
 */
import { z } from "zod";

export const SHAPES = [
  "box",
  "cylinder",
  "tube",
  "sphere",
  "dome",
  "cone",
  "wedge",
  "arc",
] as const;
export type Shape = (typeof SHAPES)[number];

export const MATERIALS = [
  "wood",
  "laminate",
  "metal",
  "plastic",
  "fabric",
  "glass",
  "foam",
  "rope",
  "other",
] as const;
export type Material = (typeof MATERIALS)[number];

export const CAMERA_HINTS = [
  "iso",
  "iso-back",
  "front",
  "back",
  "left",
  "right",
  "top",
  "auto",
] as const;
export type CameraHint = (typeof CAMERA_HINTS)[number];

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export const SOURCE_QUALITIES = ["manual", "page", "generic"] as const;

/** Human-readable description of each primitive, shared by the prompt and the docs. */
export const SHAPE_GUIDE: Record<Shape, string> = {
  box: "rectangular solid (panels, boards, shelves, drawers, cushions). size = [width x, height y, depth z].",
  cylinder:
    "solid cylinder whose axis runs along local Y (legs, dowels, bolts, poles, rods). size = [diameter, length, diameter]. Rotate [0,0,90] to lay it along X, [90,0,0] along Z.",
  tube: "hollow cylinder along local Y (pipes, pole sleeves). size = [outer diameter, length, wall thickness].",
  sphere: "sphere or ellipsoid (knobs, ball feet). size = [diameter x, diameter y, diameter z].",
  dome: "hemisphere / half ellipsoid, flat side down (dome tents, lamp shades). size = [footprint x, height, footprint z].",
  cone: "cone pointing up along local Y (tent pegs, tapered legs, lamp shades). size = [base diameter, height, base diameter]. Rotate [180,0,0] to point it down.",
  wedge:
    "isosceles triangular prism: base along X, apex at the top centre, extruded along Z (ridge roofs, A-frame tents, wedge cushions). size = [base width, height, depth].",
  arc: "a bent pole lying in the local XY plane, ends at the bottom, apex at the top (flexible tent poles, hoops, curved handles). size = [distance between the two ends, rise of the apex above the ends, pole diameter].",
};

const Vec3 = z
  .array(z.number())
  .describe("Three numbers [x, y, z]");

export const ComponentSchema = z.object({
  id: z
    .string()
    .describe("Short stable identifier in snake_case, e.g. side_panel, cam_lock"),
  label: z
    .string()
    .describe("The label printed in the manual (letter, number or article code), e.g. 'A' or '100372'. Empty string if none."),
  name: z.string().describe("Plain-language name, e.g. 'Side panel'"),
  description: z
    .string()
    .describe("One sentence on how to recognise it and which way round it goes. Empty string if nothing useful."),
  qty: z.number().int().describe("How many of this component are in the box"),
  shape: z.enum(SHAPES),
  size: Vec3.describe("Bounding box [x, y, z] in cm before rotation, following the per-shape convention"),
  color: z.string().describe("CSS hex colour like #c9a66b, chosen to look like the real material"),
  material: z.enum(MATERIALS),
  isHardware: z
    .boolean()
    .describe("true for fasteners and small fittings (screws, cams, dowels, pegs, clips) that are listed per step rather than modelled individually"),
});
export type Component = z.infer<typeof ComponentSchema>;

export const InstanceSchema = z.object({
  id: z.string().describe("Unique id, e.g. side_panel_left, shelf_2, pole_1"),
  componentId: z.string().describe("id of the component this is an instance of"),
  position: Vec3.describe("Centre of the part's bounding box in the fully assembled product, in cm"),
  rotation: Vec3.describe("Euler XYZ rotation in degrees, applied around the part centre"),
  label: z
    .string()
    .describe("Optional placement label shown on hover, e.g. 'left side' or 'top shelf'. Empty string if none."),
});
export type Instance = z.infer<typeof InstanceSchema>;

export const HardwareUseSchema = z.object({
  componentId: z.string(),
  qty: z.number().int(),
});

export const StepSchema = z.object({
  id: z.number().int().describe("1-based sequential step number"),
  title: z.string().describe("Short imperative title, max ~8 words, e.g. 'Attach the bottom panel'"),
  instruction: z
    .string()
    .describe("Clear written instructions for this step, 1-5 sentences. Plain text; separate sub-steps with newlines. Refer to parts by their manual label and name."),
  voiceScript: z
    .string()
    .describe("What the voice assistant says out loud for this step: conversational, 1-3 sentences, no markdown, no symbols, part labels spelled as words that are easy to hear (e.g. 'part A')."),
  addInstances: z
    .array(z.string())
    .describe("Instance ids that get attached to the assembly in this step. Empty for steps that only prepare, flip or check."),
  focusInstanceIds: z
    .array(z.string())
    .describe("Instance ids the camera and highlight should draw attention to (usually the added ones plus what they attach to)"),
  hardware: z
    .array(HardwareUseSchema)
    .describe("Hardware components used in this step with quantities, e.g. 8 cam locks"),
  tools: z.array(z.string()).describe("Tools needed in this step, e.g. 'Phillips screwdriver'"),
  insertDirection: Vec3.describe(
    "Direction the new parts come from before sliding into place, as a vector in world axes, e.g. [0,1,0] from above, [1,0,0] from the right. Use [0,0,0] to let the viewer pick an outward direction.",
  ),
  cameraHint: z.enum(CAMERA_HINTS).describe("Best viewing angle for this step"),
  tips: z.array(z.string()).describe("Helpful tips, 0-3 short items"),
  warnings: z
    .array(z.string())
    .describe("Safety or mistake warnings, 0-3 short items (two-person lift, wrong-way-round risks, don't overtighten)"),
  checkpoint: z
    .string()
    .describe("How to verify the step was done right, one sentence. Empty string if not applicable."),
  manualPages: z
    .array(z.number().int())
    .describe("Page numbers in the manual PDF that cover this step, if a manual was provided"),
  durationMinutes: z.number().describe("Estimated minutes for this step"),
});
export type Step = z.infer<typeof StepSchema>;

export const ToolSchema = z.object({
  name: z.string(),
  required: z.boolean(),
  note: z.string().describe("Why/when it is needed, or empty string"),
});

export const ProductSchema = z.object({
  name: z.string(),
  brand: z.string().describe("Brand or manufacturer, or empty string"),
  category: z.string().describe("e.g. bookcase, wardrobe, desk, bed frame, dome tent, gazebo"),
  summary: z
    .string()
    .describe("Two sentences: what it is and what assembly involves overall"),
  difficulty: z.enum(DIFFICULTIES),
  estimatedMinutes: z.number().int(),
  peopleNeeded: z.number().int().describe("1 or 2"),
  assembledSize: Vec3.describe("Overall assembled size [width, height, depth] in cm"),
});

export const AssemblyPlanSchema = z.object({
  product: ProductSchema,
  sourceQuality: z
    .enum(SOURCE_QUALITIES)
    .describe("'manual' if an actual assembly manual was read, 'page' if only a product page was available, 'generic' if the plan is based on general knowledge of this kind of product"),
  sourceNotes: z
    .string()
    .describe("One or two sentences on which documents were used and any caveats (e.g. 'Based on the 12-page IKEA PDF; shelf spacing is my estimate')."),
  beforeYouStart: z.array(z.string()).describe("3-6 short preparation tips"),
  safety: z.array(z.string()).describe("Key safety notes for the whole project, 1-5 items"),
  tools: z.array(ToolSchema),
  components: z.array(ComponentSchema),
  instances: z.array(InstanceSchema),
  steps: z.array(StepSchema),
});
export type AssemblyPlan = z.infer<typeof AssemblyPlanSchema>;

// ---------------------------------------------------------------------------
// Normalisation: make a model-produced (or hand-written) plan safe to render.
// ---------------------------------------------------------------------------

const MATERIAL_FALLBACK_COLOR: Record<Material, string> = {
  wood: "#c9a66b",
  laminate: "#e8dcc8",
  metal: "#b8bec7",
  plastic: "#9aa5b1",
  fabric: "#5e81ac",
  glass: "#9fd3e6",
  foam: "#f2e8d5",
  rope: "#d9c7a1",
  other: "#a0a0a0",
};

function num(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : v == null ? fallback : String(v);
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return typeof v === "string" && v.trim() ? [v] : [];
  return v.filter((x) => typeof x === "string" && x.trim().length > 0);
}

function vec3(v: unknown, fallback: [number, number, number]): [number, number, number] {
  if (Array.isArray(v)) {
    return [num(v[0], fallback[0]), num(v[1], fallback[1]), num(v[2], fallback[2])];
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return [num(o.x, fallback[0]), num(o.y, fallback[1]), num(o.z, fallback[2])];
  }
  return fallback;
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function hexColor(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  const s = v.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return ("#" + s.slice(1).split("").map((c) => c + c).join("")).toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(s)) return ("#" + s).toLowerCase();
  return fallback;
}

function slug(s: string, fallback: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return out || fallback;
}

/**
 * Turn arbitrary JSON (ideally matching AssemblyPlanSchema) into a plan that
 * the renderer can trust: all references resolve, every instance is added by
 * exactly one step, numbers are finite, enums are valid.
 */
export function normalizePlan(input: unknown): AssemblyPlan {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const rawProduct = (raw.product && typeof raw.product === "object" ? raw.product : {}) as Record<string, unknown>;

  const product: AssemblyPlan["product"] = {
    name: str(rawProduct.name, "Untitled product"),
    brand: str(rawProduct.brand),
    category: str(rawProduct.category, "furniture"),
    summary: str(rawProduct.summary),
    difficulty: pick(rawProduct.difficulty, DIFFICULTIES, "medium"),
    estimatedMinutes: Math.max(1, Math.round(num(rawProduct.estimatedMinutes, 60))),
    peopleNeeded: Math.max(1, Math.round(num(rawProduct.peopleNeeded, 1))),
    assembledSize: vec3(rawProduct.assembledSize, [100, 100, 50]),
  };

  // Components
  const components: Component[] = [];
  const componentIds = new Set<string>();
  for (const [i, c0] of (Array.isArray(raw.components) ? raw.components : []).entries()) {
    const c = (c0 && typeof c0 === "object" ? c0 : {}) as Record<string, unknown>;
    const material = pick(c.material, MATERIALS, "other");
    let id = slug(str(c.id) || str(c.name) || `part_${i + 1}`, `part_${i + 1}`);
    while (componentIds.has(id)) id = `${id}_${i + 1}`;
    componentIds.add(id);
    const size = vec3(c.size, [10, 10, 10]).map((n) => Math.max(0.1, Math.abs(n))) as [number, number, number];
    components.push({
      id,
      label: str(c.label),
      name: str(c.name, id.replace(/_/g, " ")),
      description: str(c.description),
      qty: Math.max(1, Math.round(num(c.qty, 1))),
      shape: pick(c.shape, SHAPES, "box"),
      size,
      color: hexColor(c.color, MATERIAL_FALLBACK_COLOR[material]),
      material,
      isHardware: Boolean(c.isHardware),
    });
  }

  // Instances
  const instances: Instance[] = [];
  const instanceIds = new Set<string>();
  const byComponent = new Map(components.map((c) => [c.id, c] as const));

  /** Resolve a reference that may be a component id, a manual label or a name. */
  const resolveComponentId = (ref: string): string | null => {
    const asId = slug(ref, "");
    if (asId && byComponent.has(asId)) return asId;
    const needle = ref.trim().toLowerCase();
    if (!needle) return null;
    const hit = components.find((c) => (c.label && c.label.toLowerCase() === needle) || c.name.toLowerCase() === needle);
    return hit ? hit.id : null;
  };

  for (const [i, i0] of (Array.isArray(raw.instances) ? raw.instances : []).entries()) {
    const inst = (i0 && typeof i0 === "object" ? i0 : {}) as Record<string, unknown>;
    let componentId = slug(str(inst.componentId), "");
    if (!byComponent.has(componentId)) {
      // Try to recover by label or name, else create a placeholder component.
      const resolved = resolveComponentId(str(inst.componentId));
      if (resolved) componentId = resolved;
      else {
        const placeholder: Component = {
          id: componentId || `unknown_${i + 1}`,
          label: "",
          name: str(inst.componentId, "Unknown part"),
          description: "",
          qty: 1,
          shape: "box",
          size: [10, 10, 10],
          color: MATERIAL_FALLBACK_COLOR.other,
          material: "other",
          isHardware: false,
        };
        if (!byComponent.has(placeholder.id)) {
          components.push(placeholder);
          byComponent.set(placeholder.id, placeholder);
        }
        componentId = placeholder.id;
      }
    }
    let id = slug(str(inst.id) || `${componentId}_${i + 1}`, `${componentId}_${i + 1}`);
    while (instanceIds.has(id)) id = `${id}_${i + 1}`;
    instanceIds.add(id);
    instances.push({
      id,
      componentId,
      position: vec3(inst.position, [0, 0, 0]),
      rotation: vec3(inst.rotation, [0, 0, 0]),
      label: str(inst.label),
    });
  }

  // Steps
  const steps: Step[] = [];
  const added = new Set<string>();
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  for (const [i, s0] of rawSteps.entries()) {
    const s = (s0 && typeof s0 === "object" ? s0 : {}) as Record<string, unknown>;
    const addInstances: string[] = [];
    for (const x of strArray(s.addInstances).map((x) => slug(x, ""))) {
      if (instanceIds.has(x) && !added.has(x)) {
        added.add(x);
        addInstances.push(x);
      }
    }
    const focus = strArray(s.focusInstanceIds)
      .map((x) => slug(x, ""))
      .filter((x) => instanceIds.has(x));
    const hardware = (Array.isArray(s.hardware) ? s.hardware : [])
      .map((h0) => {
        const h = (h0 && typeof h0 === "object" ? h0 : {}) as Record<string, unknown>;
        return { componentId: resolveComponentId(str(h.componentId)), qty: Math.max(1, Math.round(num(h.qty, 1))) };
      })
      .filter((h): h is { componentId: string; qty: number } => h.componentId !== null)
      // Merge repeated references to the same component (e.g. given once by id and once by label).
      .reduce<{ componentId: string; qty: number }[]>((acc, h) => {
        const prev = acc.find((x) => x.componentId === h.componentId);
        if (prev) prev.qty += h.qty;
        else acc.push({ ...h });
        return acc;
      }, []);
    steps.push({
      id: i + 1,
      title: str(s.title, `Step ${i + 1}`),
      instruction: str(s.instruction),
      voiceScript: str(s.voiceScript) || str(s.instruction),
      addInstances,
      focusInstanceIds: focus.length ? focus : addInstances,
      hardware,
      tools: strArray(s.tools),
      insertDirection: vec3(s.insertDirection, [0, 0, 0]),
      cameraHint: pick(s.cameraHint, CAMERA_HINTS, "auto"),
      tips: strArray(s.tips),
      warnings: strArray(s.warnings),
      checkpoint: str(s.checkpoint),
      manualPages: (Array.isArray(s.manualPages) ? s.manualPages : [])
        .map((p) => Math.round(num(p, 0)))
        .filter((p) => p > 0),
      durationMinutes: Math.max(0, num(s.durationMinutes, 5)),
    });
  }

  // Any instance never added by a step gets attached to the last step so it is
  // not lost (or a synthetic final step if there are no steps at all).
  const orphans = instances.map((i) => i.id).filter((id) => !added.has(id));
  if (orphans.length) {
    if (steps.length === 0) {
      steps.push({
        id: 1,
        title: "Assemble all parts",
        instruction: "Attach all parts as shown.",
        voiceScript: "Attach all the parts as shown in the three D view.",
        addInstances: [],
        focusInstanceIds: [],
        hardware: [],
        tools: [],
        insertDirection: [0, 0, 0],
        cameraHint: "iso",
        tips: [],
        warnings: [],
        checkpoint: "",
        manualPages: [],
        durationMinutes: 10,
      });
    }
    const last = steps[steps.length - 1];
    last.addInstances = [...last.addInstances, ...orphans];
    if (last.focusInstanceIds.length === 0) last.focusInstanceIds = [...orphans];
  }

  const tools = (Array.isArray(raw.tools) ? raw.tools : []).map((t0) => {
    const t = (t0 && typeof t0 === "object" ? t0 : { name: t0 }) as Record<string, unknown>;
    return { name: str(t.name, "Tool"), required: t.required == null ? true : Boolean(t.required), note: str(t.note) };
  });

  return {
    product,
    sourceQuality: pick(raw.sourceQuality, SOURCE_QUALITIES, "generic"),
    sourceNotes: str(raw.sourceNotes),
    beforeYouStart: strArray(raw.beforeYouStart),
    safety: strArray(raw.safety),
    tools,
    components,
    instances,
    steps,
  };
}

// ---------------------------------------------------------------------------
// Derived state used by the viewer and the voice assistant.
// ---------------------------------------------------------------------------

/** Map component id -> component. */
export function componentMap(plan: AssemblyPlan): Map<string, Component> {
  return new Map(plan.components.map((c) => [c.id, c]));
}

/** Map component id -> ids of its instances, in plan order. */
export function instancesByComponent(plan: AssemblyPlan): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const inst of plan.instances) {
    const list = m.get(inst.componentId);
    if (list) list.push(inst.id);
    else m.set(inst.componentId, [inst.id]);
  }
  return m;
}

/** Map instance id -> 0-based index of the step that adds it. */
export function instanceStepIndex(plan: AssemblyPlan): Map<string, number> {
  const m = new Map<string, number>();
  plan.steps.forEach((s, i) => s.addInstances.forEach((id) => m.set(id, i)));
  return m;
}

/** Ids of instances that are attached once step `stepIndex` (0-based) is done. */
export function visibleInstanceIds(plan: AssemblyPlan, stepIndex: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i <= Math.min(stepIndex, plan.steps.length - 1); i++) {
    for (const id of plan.steps[i].addInstances) out.add(id);
  }
  return out;
}

/** Text summary of a step's hardware, e.g. "8 × cam lock, 4 × wood dowel". */
export function describeHardware(plan: AssemblyPlan, step: Step): string {
  const byComponent = componentMap(plan);
  return step.hardware
    .map((h) => {
      const c = byComponent.get(h.componentId);
      return c ? `${h.qty} × ${c.name}${c.label ? ` (${c.label})` : ""}` : "";
    })
    .filter(Boolean)
    .join(", ");
}
