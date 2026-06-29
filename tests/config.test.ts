import { describe, expect, it } from "bun:test";
import { parseConfig, type ResolvedConfig } from "../src/config";

describe("parseConfig", () => {
  describe("defaults", () => {
    it("returns all defaults from empty input", () => {
      const cfg = parseConfig({});
      expect(cfg).toEqual({
        cswapBin: "cswap",
        includeSlots: null,
        excludeSlots: [],
        rateLimitPct: 100,
        strategy: "round-robin",
        prewarmArgs: ["--version"],
        refreshIntervalMs: 60000,
        bootWarmTimeoutMs: 30000,
        abortOnEmpty: true,
        makePrimaryButtons: true,
      } satisfies ResolvedConfig);
    });
  });

  describe("overrides", () => {
    it("accepts cswapBin override", () => {
      expect(parseConfig({ cswapBin: "/usr/local/bin/cswap" }).cswapBin).toBe(
        "/usr/local/bin/cswap",
      );
    });

    it("accepts includeSlots as array of ints", () => {
      expect(parseConfig({ includeSlots: [1, 2] }).includeSlots).toEqual([1, 2]);
    });

    it("accepts includeSlots: null explicitly", () => {
      expect(parseConfig({ includeSlots: null }).includeSlots).toBeNull();
    });

    it("accepts excludeSlots as array of ints", () => {
      expect(parseConfig({ excludeSlots: [3, 4] }).excludeSlots).toEqual([3, 4]);
    });

    it("accepts rateLimitPct override", () => {
      expect(parseConfig({ rateLimitPct: 80 }).rateLimitPct).toBe(80);
    });

    it("accepts rateLimitPct at 0 boundary", () => {
      expect(parseConfig({ rateLimitPct: 0 }).rateLimitPct).toBe(0);
    });

    it("accepts rateLimitPct at 1000 boundary", () => {
      expect(parseConfig({ rateLimitPct: 1000 }).rateLimitPct).toBe(1000);
    });

    it("accepts prewarmArgs override", () => {
      expect(parseConfig({ prewarmArgs: ["--help"] }).prewarmArgs).toEqual(["--help"]);
    });

    it("accepts refreshIntervalMs override", () => {
      expect(parseConfig({ refreshIntervalMs: 30000 }).refreshIntervalMs).toBe(30000);
    });

    it("accepts bootWarmTimeoutMs override", () => {
      expect(parseConfig({ bootWarmTimeoutMs: 15000 }).bootWarmTimeoutMs).toBe(15000);
    });

    it("accepts abortOnEmpty: false", () => {
      expect(parseConfig({ abortOnEmpty: false }).abortOnEmpty).toBe(false);
    });

    it("defaults makePrimaryButtons to true", () => {
      expect(parseConfig({}).makePrimaryButtons).toBe(true);
    });

    it("accepts makePrimaryButtons: false", () => {
      expect(parseConfig({ makePrimaryButtons: false }).makePrimaryButtons).toBe(false);
    });

    it("accepts makePrimaryButtons: true explicitly", () => {
      expect(parseConfig({ makePrimaryButtons: true }).makePrimaryButtons).toBe(true);
    });
  });

  describe("validation — cswapBin", () => {
    it("throws if cswapBin is not a string", () => {
      expect(() => parseConfig({ cswapBin: 42 })).toThrow();
    });

    it("throws if cswapBin is empty string", () => {
      expect(() => parseConfig({ cswapBin: "" })).toThrow();
    });

    it("throws if cswapBin is null", () => {
      expect(() => parseConfig({ cswapBin: null })).toThrow();
    });
  });

  describe("validation — includeSlots", () => {
    it("throws if includeSlots is a non-null non-array", () => {
      expect(() => parseConfig({ includeSlots: "all" })).toThrow();
      expect(() => parseConfig({ includeSlots: 1 })).toThrow();
    });

    it("throws if includeSlots contains a non-integer", () => {
      expect(() => parseConfig({ includeSlots: [1.5] })).toThrow();
    });

    it("throws if includeSlots contains a non-finite value", () => {
      expect(() => parseConfig({ includeSlots: [Infinity] })).toThrow();
      expect(() => parseConfig({ includeSlots: [NaN] })).toThrow();
    });

    it("throws if includeSlots contains a string", () => {
      expect(() => parseConfig({ includeSlots: ["1"] })).toThrow();
    });
  });

  describe("validation — excludeSlots", () => {
    it("throws if excludeSlots is not an array", () => {
      expect(() => parseConfig({ excludeSlots: 1 })).toThrow();
      expect(() => parseConfig({ excludeSlots: "[]" })).toThrow();
    });

    it("throws if excludeSlots contains a non-integer", () => {
      expect(() => parseConfig({ excludeSlots: [1.5] })).toThrow();
    });

    it("throws if excludeSlots contains a string", () => {
      expect(() => parseConfig({ excludeSlots: ["1"] })).toThrow();
    });
  });

  describe("validation — rateLimitPct", () => {
    it("throws if rateLimitPct is negative", () => {
      expect(() => parseConfig({ rateLimitPct: -1 })).toThrow();
    });

    it("throws if rateLimitPct is > 1000", () => {
      expect(() => parseConfig({ rateLimitPct: 1001 })).toThrow();
    });

    it("throws if rateLimitPct is non-finite", () => {
      expect(() => parseConfig({ rateLimitPct: Infinity })).toThrow();
      expect(() => parseConfig({ rateLimitPct: NaN })).toThrow();
    });

    it("throws if rateLimitPct is not a number", () => {
      expect(() => parseConfig({ rateLimitPct: "80" })).toThrow();
    });
  });

  describe("validation — prewarmArgs", () => {
    it("throws if prewarmArgs is not an array", () => {
      expect(() => parseConfig({ prewarmArgs: "--version" })).toThrow();
    });

    it("throws if prewarmArgs contains a non-string", () => {
      expect(() => parseConfig({ prewarmArgs: [1] })).toThrow();
    });
  });

  describe("validation — refreshIntervalMs", () => {
    it("throws if refreshIntervalMs is negative", () => {
      expect(() => parseConfig({ refreshIntervalMs: -1 })).toThrow();
    });

    it("throws if refreshIntervalMs is zero", () => {
      expect(() => parseConfig({ refreshIntervalMs: 0 })).toThrow();
    });

    it("throws if refreshIntervalMs is not a number", () => {
      expect(() => parseConfig({ refreshIntervalMs: "60000" })).toThrow();
    });

    it("throws if refreshIntervalMs is non-finite", () => {
      expect(() => parseConfig({ refreshIntervalMs: Infinity })).toThrow();
    });
  });

  describe("validation — bootWarmTimeoutMs", () => {
    it("throws if bootWarmTimeoutMs is zero", () => {
      expect(() => parseConfig({ bootWarmTimeoutMs: 0 })).toThrow();
    });

    it("throws if bootWarmTimeoutMs is negative", () => {
      expect(() => parseConfig({ bootWarmTimeoutMs: -100 })).toThrow();
    });

    it("throws if bootWarmTimeoutMs is not a number", () => {
      expect(() => parseConfig({ bootWarmTimeoutMs: "30000" })).toThrow();
    });
  });

  describe("overrides — strategy", () => {
    it("defaults to round-robin", () => {
      expect(parseConfig({}).strategy).toBe("round-robin");
    });

    it("accepts least-used", () => {
      expect(parseConfig({ strategy: "least-used" }).strategy).toBe("least-used");
    });

    it("accepts round-robin explicitly", () => {
      expect(parseConfig({ strategy: "round-robin" }).strategy).toBe("round-robin");
    });
  });

  describe("validation — strategy", () => {
    it("throws on invalid string", () => {
      expect(() => parseConfig({ strategy: "best" })).toThrow();
    });

    it("throws on number", () => {
      expect(() => parseConfig({ strategy: 42 })).toThrow();
    });

    it("throws on null", () => {
      expect(() => parseConfig({ strategy: null })).toThrow();
    });
  });

  describe("validation — abortOnEmpty", () => {
    it("throws if abortOnEmpty is a string", () => {
      expect(() => parseConfig({ abortOnEmpty: "true" })).toThrow();
    });

    it("throws if abortOnEmpty is a number", () => {
      expect(() => parseConfig({ abortOnEmpty: 1 })).toThrow();
    });

    it("throws if abortOnEmpty is null", () => {
      expect(() => parseConfig({ abortOnEmpty: null })).toThrow();
    });
  });

  describe("validation — makePrimaryButtons", () => {
    it("throws if makePrimaryButtons is a string", () => {
      expect(() => parseConfig({ makePrimaryButtons: "true" })).toThrow();
    });

    it("throws if makePrimaryButtons is a number", () => {
      expect(() => parseConfig({ makePrimaryButtons: 1 })).toThrow();
    });

    it("throws if makePrimaryButtons is null", () => {
      expect(() => parseConfig({ makePrimaryButtons: null })).toThrow();
    });
  });
});
