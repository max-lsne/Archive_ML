import { describe, expect, it } from "vitest";
import { AssemblyPlanSchema, describeHardware, instanceStepIndex, normalizePlan, visibleInstanceIds } from "../shared/plan";
import { SAMPLE_PLANS } from "../shared/samples/index";

describe("sample plans", () => {
  for (const sample of SAMPLE_PLANS) {
    it(`${sample.id} validates against the schema`, () => {
      const parsed = AssemblyPlanSchema.safeParse(sample.plan);
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues.slice(0, 3))).toBe(true);
    });
    it(`${sample.id} is internally consistent`, () => {
      const plan = normalizePlan(sample.plan);
      const instanceIds = new Set(plan.instances.map((i) => i.id));
      expect(instanceIds.size).toBe(plan.instances.length);
      const componentIds = new Set(plan.components.map((c) => c.id));
      for (const inst of plan.instances) expect(componentIds.has(inst.componentId)).toBe(true);
      // every instance is added exactly once
      const added = plan.steps.flatMap((s) => s.addInstances);
      expect(new Set(added).size).toBe(added.length);
      expect(new Set(added).size).toBe(plan.instances.length);
      // non-hardware qty matches instances
      for (const c of plan.components.filter((c) => !c.isHardware)) {
        expect(plan.instances.filter((i) => i.componentId === c.id).length, c.id).toBe(c.qty);
      }
      // every step has text and a voice script
      for (const s of plan.steps) {
        expect(s.instruction.length).toBeGreaterThan(20);
        expect(s.voiceScript.length).toBeGreaterThan(20);
      }
    });
  }
});

describe("normalizePlan", () => {
  it("repairs garbage input into a renderable plan", () => {
    const plan = normalizePlan({
      product: { name: "X", estimatedMinutes: "45" },
      components: [{ id: "A Panel", shape: "blob", size: "big", color: "red", qty: "2" }],
      instances: [
        { id: "i1", componentId: "a_panel", position: [1, 2] },
        { id: "i2", componentId: "missing", position: { x: 1, y: 2, z: 3 } },
      ],
      steps: [{ title: "s", addInstances: ["i1", "nope"], cameraHint: "sideways" }],
    });
    expect(plan.product.estimatedMinutes).toBe(45);
    expect(plan.components[0]).toMatchObject({ id: "a_panel", shape: "box", size: [10, 10, 10], qty: 2 });
    expect(plan.components[0].color).toMatch(/^#[0-9a-f]{6}$/);
    expect(plan.instances[0].position).toEqual([1, 2, 0]);
    expect(plan.instances[1].position).toEqual([1, 2, 3]);
    // the unknown component became a placeholder
    expect(plan.components.some((c) => c.id === "missing")).toBe(true);
    expect(plan.steps[0].cameraHint).toBe("auto");
    // i2 was never added by a step -> appended to the last step
    expect(plan.steps[0].addInstances).toEqual(["i1", "i2"]);
  });

  it("creates a step when there are none", () => {
    const plan = normalizePlan({ components: [{ id: "a", shape: "box", size: [1, 1, 1] }], instances: [{ id: "x", componentId: "a" }] });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].addInstances).toEqual(["x"]);
  });

  it("resolves hardware referenced by manual label or name", () => {
    const plan = normalizePlan({
      components: [
        { id: "cam_lock", label: "100383", name: "Cam lock", isHardware: true },
        { id: "side_panel", label: "A", name: "Side panel" },
      ],
      instances: [{ id: "s1", componentId: "A" }],
      steps: [{ title: "s", addInstances: ["s1"], hardware: [{ componentId: "100383", qty: 4 }, { componentId: "Cam lock", qty: 2 }, { componentId: "nope", qty: 1 }] }],
    });
    // Both references resolve to the same component and are merged.
    expect(plan.steps[0].hardware).toEqual([{ componentId: "cam_lock", qty: 6 }]);
    expect(plan.instances[0].componentId).toBe("side_panel");
  });

  it("accepts short and bare hex colours", () => {
    const plan = normalizePlan({ components: [{ id: "a", color: "#abc" }, { id: "b", color: "aabbcc" }, { id: "c", material: "metal" }] });
    expect(plan.components.map((c) => c.color)).toEqual(["#aabbcc", "#aabbcc", "#b8bec7"]);
  });
});

describe("derived state", () => {
  const plan = normalizePlan(SAMPLE_PLANS[0].plan);
  it("visibleInstanceIds accumulates", () => {
    const s0 = visibleInstanceIds(plan, 0);
    const s2 = visibleInstanceIds(plan, 2);
    const last = visibleInstanceIds(plan, plan.steps.length - 1);
    expect(s0.size).toBeLessThanOrEqual(s2.size);
    expect(last.size).toBe(plan.instances.length);
  });
  it("instanceStepIndex maps every instance", () => {
    const m = instanceStepIndex(plan);
    expect(m.size).toBe(plan.instances.length);
  });
  it("describeHardware lists quantities", () => {
    const step = plan.steps.find((s) => s.hardware.length)!;
    expect(describeHardware(plan, step)).toMatch(/\d+ × /);
  });
});
