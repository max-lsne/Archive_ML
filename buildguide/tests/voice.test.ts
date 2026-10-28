import { describe, expect, it } from "vitest";
import { parseNumber, parseVoiceCommand } from "../shared/voice";

describe("parseVoiceCommand", () => {
  const cases: [string, unknown][] = [
    ["next", { type: "next" }],
    ["Okay, next step.", { type: "next" }],
    ["I'm done", { type: "next" }],
    ["go back", { type: "prev" }],
    ["repeat that please", { type: "repeat" }],
    ["go to step 7", { type: "goto", step: 7 }],
    ["step twelve", { type: "goto", step: 12 }],
    ["jump to step twenty one", { type: "goto", step: 21 }],
    ["take me to the first step", { type: "first" }],
    ["last step", { type: "last" }],
    ["what parts do I need", { type: "parts" }],
    ["which tools", { type: "tools" }],
    ["stop", { type: "stop" }],
    ["exploded view", { type: "explode", enabled: true }],
    ["put it back together", { type: "explode", enabled: false }],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}"`, () => expect(parseVoiceCommand(input)).toEqual(expected));
  }
  it("treats anything else as a question", () => {
    expect(parseVoiceCommand("where does part B go?")).toEqual({ type: "ask", text: "where does part B go?" });
    expect(parseVoiceCommand("is the next panel the long one")).toEqual({ type: "ask", text: "is the next panel the long one" });
  });
});

describe("parseNumber", () => {
  it("reads digits and words", () => {
    expect(parseNumber("step 14")).toBe(14);
    expect(parseNumber("twenty three")).toBe(23);
    expect(parseNumber("third")).toBe(3);
    expect(parseNumber("nothing")).toBeNull();
  });
});
