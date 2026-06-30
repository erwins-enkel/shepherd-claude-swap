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
        routeAuxQuota: true,
        autoHeal: true,
        autoHealAfterCycles: 2,
        healLaunchArgs: ["-p", "ok"],
        healLaunchTimeoutMs: 60000,
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

    it("defaults routeAuxQuota to true", () => {
      expect(parseConfig({}).routeAuxQuota).toBe(true);
    });

    it("accepts routeAuxQuota: false", () => {
      expect(parseConfig({ routeAuxQuota: false }).routeAuxQuota).toBe(false);
    });

    it("accepts routeAuxQuota: true explicitly", () => {
      expect(parseConfig({ routeAuxQuota: true }).routeAuxQuota).toBe(true);
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

  describe("validation — routeAuxQuota", () => {
    it("throws if routeAuxQuota is a string", () => {
      expect(() => parseConfig({ routeAuxQuota: "true" })).toThrow();
    });

    it("throws if routeAuxQuota is a number", () => {
      expect(() => parseConfig({ routeAuxQuota: 1 })).toThrow();
    });

    it("throws if routeAuxQuota is null", () => {
      expect(() => parseConfig({ routeAuxQuota: null })).toThrow();
    });
  });

  describe("overrides — autoHeal", () => {
    it("defaults to true", () => {
      expect(parseConfig({}).autoHeal).toBe(true);
    });

    it("accepts false", () => {
      expect(parseConfig({ autoHeal: false }).autoHeal).toBe(false);
    });

    it("accepts true explicitly", () => {
      expect(parseConfig({ autoHeal: true }).autoHeal).toBe(true);
    });
  });

  describe("validation — autoHeal", () => {
    it("throws on non-boolean string", () => {
      expect(() => parseConfig({ autoHeal: "yes" })).toThrow();
    });

    it("throws on number", () => {
      expect(() => parseConfig({ autoHeal: 1 })).toThrow();
    });

    it("throws on null", () => {
      expect(() => parseConfig({ autoHeal: null })).toThrow();
    });
  });

  describe("overrides — autoHealAfterCycles", () => {
    it("defaults to 2", () => {
      expect(parseConfig({}).autoHealAfterCycles).toBe(2);
    });

    it("accepts 1", () => {
      expect(parseConfig({ autoHealAfterCycles: 1 }).autoHealAfterCycles).toBe(1);
    });

    it("accepts 5", () => {
      expect(parseConfig({ autoHealAfterCycles: 5 }).autoHealAfterCycles).toBe(5);
    });
  });

  describe("validation — autoHealAfterCycles", () => {
    it("throws on 0", () => {
      expect(() => parseConfig({ autoHealAfterCycles: 0 })).toThrow();
    });

    it("throws on negative", () => {
      expect(() => parseConfig({ autoHealAfterCycles: -1 })).toThrow();
    });

    it("throws on non-integer", () => {
      expect(() => parseConfig({ autoHealAfterCycles: 2.5 })).toThrow();
    });

    it("throws on non-number", () => {
      expect(() => parseConfig({ autoHealAfterCycles: "2" })).toThrow();
    });
  });

  describe("overrides — healLaunchArgs", () => {
    it('defaults to ["-p", "ok"]', () => {
      expect(parseConfig({}).healLaunchArgs).toEqual(["-p", "ok"]);
    });

    it("accepts a valid non-empty string array", () => {
      expect(parseConfig({ healLaunchArgs: ["-p", "hello"] }).healLaunchArgs).toEqual([
        "-p",
        "hello",
      ]);
    });
  });

  describe("validation — healLaunchArgs", () => {
    it("throws if not an array", () => {
      expect(() => parseConfig({ healLaunchArgs: "--version" })).toThrow(
        /healLaunchArgs: expected non-empty array of strings/,
      );
    });

    it("throws if empty array", () => {
      expect(() => parseConfig({ healLaunchArgs: [] })).toThrow(
        /healLaunchArgs: expected non-empty array of strings/,
      );
    });

    it("throws if element is not a string", () => {
      expect(() => parseConfig({ healLaunchArgs: ["-p", 42] })).toThrow(
        /healLaunchArgs\[1\]: expected string/,
      );
    });
  });

  describe("overrides — healLaunchTimeoutMs", () => {
    it("defaults to 60000", () => {
      expect(parseConfig({}).healLaunchTimeoutMs).toBe(60000);
    });

    it("accepts a valid positive number", () => {
      expect(parseConfig({ healLaunchTimeoutMs: 30000 }).healLaunchTimeoutMs).toBe(30000);
    });
  });

  describe("validation — healLaunchTimeoutMs", () => {
    it("throws on zero", () => {
      expect(() => parseConfig({ healLaunchTimeoutMs: 0 })).toThrow(
        /healLaunchTimeoutMs: expected positive finite number/,
      );
    });

    it("throws on negative", () => {
      expect(() => parseConfig({ healLaunchTimeoutMs: -1 })).toThrow(
        /healLaunchTimeoutMs: expected positive finite number/,
      );
    });

    it("throws on non-finite / NaN / non-number", () => {
      expect(() => parseConfig({ healLaunchTimeoutMs: Infinity })).toThrow(
        /healLaunchTimeoutMs: expected positive finite number/,
      );
      expect(() => parseConfig({ healLaunchTimeoutMs: NaN })).toThrow(
        /healLaunchTimeoutMs: expected positive finite number/,
      );
      expect(() => parseConfig({ healLaunchTimeoutMs: "60000" })).toThrow(
        /healLaunchTimeoutMs: expected positive finite number/,
      );
    });
  });
});
