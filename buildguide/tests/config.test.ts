import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEffort, parsePositiveInt } from "../server/src/config";

describe("parseEffort", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts known levels", () => {
    expect(parseEffort("low", "high")).toBe("low");
    expect(parseEffort("max", "low")).toBe("max");
  });

  it("uses the caller's fallback for unset values", () => {
    expect(parseEffort(undefined, "low")).toBe("low");
    expect(parseEffort("", "high")).toBe("high");
  });

  it("rejects unknown values loudly and keeps the fallback (never silently raises effort)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseEffort("lo", "low", "BUILDGUIDE_CHAT_EFFORT")).toBe("low");
    expect(parseEffort("Low", "low")).toBe("low");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain("BUILDGUIDE_CHAT_EFFORT");
  });
});

describe("parsePositiveInt (PORT)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("parses valid ports and falls back on empty or junk", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parsePositiveInt("3000", 8787, "PORT")).toBe(3000);
    expect(parsePositiveInt("", 8787, "PORT")).toBe(8787);
    expect(parsePositiveInt(undefined, 8787, "PORT")).toBe(8787);
    expect(parsePositiveInt("8787x", 8787, "PORT")).toBe(8787);
    expect(parsePositiveInt("0", 8787, "PORT")).toBe(8787);
  });
});
