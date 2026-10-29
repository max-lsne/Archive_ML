import { describe, expect, it } from "vitest";
import { findComponentInQuestion, normalizeHistory, routeMockQuestion } from "../server/src/chat";
import { normalizePlan } from "../shared/plan";
import { SAMPLE_PLANS } from "../shared/samples/index";
import type { ChatMessage } from "../shared/project";

const u = (content: string): ChatMessage => ({ role: "user", content });
const a = (content: string): ChatMessage => ({ role: "assistant", content });

describe("normalizeHistory", () => {
  it("keeps a short conversation as is", () => {
    const h = [u("hi"), a("hello"), u("where does A go?")];
    expect(normalizeHistory(h)).toEqual(h);
  });
  it("drops empty turns", () => {
    expect(normalizeHistory([u("  "), a(""), u("q")])).toEqual([u("q")]);
  });
  it("re-anchors on a user turn after trimming an odd-length history", () => {
    const h: ChatMessage[] = [];
    for (let i = 0; i < 15; i++) h.push(u(`q${i}`), a(`a${i}`));
    h.push(u("final")); // 31 turns: slice(-30) would start on an assistant message
    const out = normalizeHistory(h, 30);
    expect(out[0].role).toBe("user");
    expect(out[0].content).toBe("q1");
    expect(out[out.length - 1].content).toBe("final");
    expect(out.length).toBe(29);
  });
  it("returns an empty list when there is no user turn", () => {
    expect(normalizeHistory([a("x"), a("y")])).toEqual([]);
  });
});

describe("findComponentInQuestion", () => {
  const plan = normalizePlan(SAMPLE_PLANS.find((s) => s.id === "sample-bookcase")!.plan);
  it("does not treat the article 'a' as the label A", () => {
    // No component is named just "shelf", so this must not fall back to the side panel (label A).
    const hit = findComponentInQuestion(plan, "where does a shelf go");
    expect(hit?.label).not.toBe("A");
    expect(findComponentInQuestion(plan, "is there a tool for this")).toBeUndefined();
  });
  it("matches 'part a' explicitly", () => {
    expect(findComponentInQuestion(plan, "where does part a go")?.label).toBe("A");
  });
  it("prefers the longest matching name", () => {
    expect(findComponentInQuestion(plan, "which way does the adjustable shelf go")?.id).toBe("adjustable_shelf");
    expect(findComponentInQuestion(plan, "where is the fixed middle shelf")?.id).toBe("fixed_shelf");
  });
  it("matches alphanumeric labels on their own, numeric ones only as 'part N'", () => {
    const alnum = normalizePlan({
      components: [{ id: "bracket", label: "AB12", name: "Bracket", shape: "box", size: [4, 2, 1] }],
      instances: [{ id: "bracket_1", componentId: "bracket" }],
      steps: [{ title: "Fit", instruction: "Fit the bracket to the panel.", addInstances: ["bracket_1"] }],
    });
    expect(findComponentInQuestion(alnum, "what is ab12")?.id).toBe("bracket");
    expect(findComponentInQuestion(plan, "what is 100383")).toBeUndefined();
    expect(findComponentInQuestion(plan, "what is part 100383")?.id).toBe("cam_lock");
  });
  it("returns undefined when nothing matches", () => {
    expect(findComponentInQuestion(plan, "how long will it take")).toBeUndefined();
  });
  it("matches purely numeric labels only as 'part N'", () => {
    const numeric = normalizePlan({
      components: [
        { id: "bolt", label: "12", name: "Bolt", shape: "cylinder", size: [1, 4, 1], isHardware: true },
        { id: "leg", label: "100383", name: "Leg", shape: "box", size: [4, 40, 4] },
      ],
      instances: [{ id: "leg_1", componentId: "leg" }],
      steps: [{ title: "Attach the leg", instruction: "Attach the leg with the bolt.", addInstances: ["leg_1"], durationMinutes: 5 }],
    });
    expect(findComponentInQuestion(numeric, "how long does step 12 take")).toBeUndefined();
    expect(findComponentInQuestion(numeric, "i need 12 of these")).toBeUndefined();
    expect(findComponentInQuestion(numeric, "where does part 12 go")?.id).toBe("bolt");
    expect(findComponentInQuestion(numeric, "what is part 100383")?.id).toBe("leg");
    expect(routeMockQuestion(numeric, "how long does step 12 take?")).toEqual({ kind: "duration" });
  });
});

describe("routeMockQuestion", () => {
  const plan = normalizePlan(SAMPLE_PLANS.find((s) => s.id === "sample-bookcase")!.plan);
  it("treats a part name that contains a command word as a part question", () => {
    const r = routeMockQuestion(plan, "back panel?");
    expect(r.kind).toBe("component");
    if (r.kind === "component") expect(r.component.id).toBe("back_panel");
  });
  it("does not jump steps for a duration question that mentions a step", () => {
    expect(routeMockQuestion(plan, "how long does step 3 take?")).toEqual({ kind: "duration" });
  });
  it("routes navigation through the shared voice parser", () => {
    expect(routeMockQuestion(plan, "go to step three")).toEqual({ kind: "command", command: { type: "goto", step: 3 } });
    expect(routeMockQuestion(plan, "step twelve")).toEqual({ kind: "command", command: { type: "goto", step: 12 } });
    expect(routeMockQuestion(plan, "next")).toEqual({ kind: "command", command: { type: "next" } });
    expect(routeMockQuestion(plan, "what parts do I need?")).toEqual({ kind: "command", command: { type: "parts" } });
  });
  it("answers part questions before other heuristics", () => {
    const r = routeMockQuestion(plan, "what tools do I need for the cam lock");
    expect(r.kind).toBe("component");
  });
  it("falls back for unrelated questions", () => {
    expect(routeMockQuestion(plan, "is it raining")).toEqual({ kind: "fallback" });
    expect(routeMockQuestion(plan, "how long will it take")).toEqual({ kind: "duration" });
  });
});
