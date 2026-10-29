import { describe, expect, it } from "vitest";
import { findComponentInQuestion, normalizeHistory } from "../server/src/chat";
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
  it("matches multi-character labels on their own", () => {
    expect(findComponentInQuestion(plan, "what is 100383")?.id).toBe("cam_lock");
  });
  it("returns undefined when nothing matches", () => {
    expect(findComponentInQuestion(plan, "how long will it take")).toBeUndefined();
  });
});
