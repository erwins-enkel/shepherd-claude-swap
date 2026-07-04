import { describe, expect, it } from "bun:test";
import { buildStatus } from "../src/status";
import type { LastSpawn } from "../src/status";
import type { PoolAccount } from "../src/accounts";
import type { SelectionState } from "../src/selection";
import type { HealRecord, HealRestoreFailure } from "../src/prewarm";
import { parseConfig } from "../src/config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccount(number: number, opts: Partial<PoolAccount> = {}): PoolAccount {
  return {
    number,
    email: `acct${number}@example.com`,
    usable: true,
    rateLimited: false,
    reason: null,
    fiveHourPct: 10,
    sevenDayPct: 20,
    fiveHourResetsAt: null,
    sevenDayResetsAt: null,
    fiveHourResetClock: null,
    sevenDayResetClock: null,
    fiveHourResetCountdown: null,
    sevenDayResetCountdown: null,
    active: true,
    usageUnavailable: false,
    scopedWindows: [],
    ...opts,
  };
}

const cfg = parseConfig({});
const baseState: SelectionState = { cursor: 3, assignments: { abc: 1 } };
const pool: PoolAccount[] = [makeAccount(1), makeAccount(2)];
const ready = new Set([1]);

const lastSpawn: LastSpawn = {
  sessionId: "abc",
  accountNumber: 1,
  credentialDir: "/home/user/.local/share/claude-swap/sessions/1-acct1_example.com",
  at: "2024-01-01T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Required top-level keys
// ---------------------------------------------------------------------------

describe("buildStatus — required keys", () => {
  it("contains 'config' key", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    expect(s).toHaveProperty("config");
  });

  it("contains 'pool' key", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    expect(s).toHaveProperty("pool");
  });

  it("contains 'assignments' key", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    expect(s).toHaveProperty("assignments");
  });

  it("contains 'cursor' key", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    expect(s).toHaveProperty("cursor");
  });

  it("contains 'lastSpawn' key", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    expect(s).toHaveProperty("lastSpawn");
  });
});

// ---------------------------------------------------------------------------
// Config section
// ---------------------------------------------------------------------------

describe("buildStatus — config section", () => {
  it("config reflects cswapBin", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    const c = s["config"] as Record<string, unknown>;
    expect(c["cswapBin"]).toBe("cswap");
  });

  it("config reflects rateLimitPct", () => {
    const customCfg = parseConfig({ rateLimitPct: 80 });
    const s = buildStatus(customCfg, pool, ready, baseState, null, null, null, null);
    const c = s["config"] as Record<string, unknown>;
    expect(c["rateLimitPct"]).toBe(80);
  });

  it("config.strategy is 'round-robin' for default cfg", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    const c = s["config"] as Record<string, unknown>;
    expect(c["strategy"]).toBe("round-robin");
  });

  it("config.strategy is 'least-used' when parseConfig({ strategy: 'least-used' })", () => {
    const customCfg = parseConfig({ strategy: "least-used" });
    const s = buildStatus(customCfg, pool, ready, baseState, null, null, null, null);
    const c = s["config"] as Record<string, unknown>;
    expect(c["strategy"]).toBe("least-used");
  });
});

// ---------------------------------------------------------------------------
// Pool section
// ---------------------------------------------------------------------------

describe("buildStatus — pool section", () => {
  it("pool is an array with same length as input pool", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    const p = s["pool"] as unknown[];
    expect(Array.isArray(p)).toBe(true);
    expect(p).toHaveLength(pool.length);
  });

  it("each pool entry has number, email, usable, rateLimited, fiveHourPct, sevenDayPct, ready, usageUnavailable", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    const p = s["pool"] as Record<string, unknown>[];
    for (const entry of p) {
      expect(entry).toHaveProperty("number");
      expect(entry).toHaveProperty("email");
      expect(entry).toHaveProperty("usable");
      expect(entry).toHaveProperty("rateLimited");
      expect(entry).toHaveProperty("fiveHourPct");
      expect(entry).toHaveProperty("sevenDayPct");
      expect(entry).toHaveProperty("ready");
      expect(entry).toHaveProperty("usageUnavailable");
      expect(entry).toHaveProperty("fiveHourResetsAt");
      expect(entry).toHaveProperty("sevenDayResetsAt");
    }
  });

  it("pool entry carries resetsAt values (ISO or null)", () => {
    const withReset = makeAccount(1, {
      fiveHourResetsAt: "2026-06-27T20:00:00.277424+00:00",
      sevenDayResetsAt: null,
    });
    const s = buildStatus(cfg, [withReset], new Set([1]), baseState, null, null, null, null);
    const p = s["pool"] as Record<string, unknown>[];
    expect(p[0]?.["fiveHourResetsAt"]).toBe("2026-06-27T20:00:00.277424+00:00");
    expect(p[0]?.["sevenDayResetsAt"]).toBeNull();
  });

  it("pool entry 'ready' reflects ready Set: acct 1 ready, acct 2 not ready", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    const p = s["pool"] as Record<string, unknown>[];
    const a1 = p.find((e) => e["number"] === 1);
    const a2 = p.find((e) => e["number"] === 2);
    expect(a1?.["ready"]).toBe(true);
    expect(a2?.["ready"]).toBe(false);
  });

  it("pool entry 'ready' is boolean (not a Set)", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    const p = s["pool"] as Record<string, unknown>[];
    for (const entry of p) {
      expect(typeof entry["ready"]).toBe("boolean");
    }
  });

  it("pool entry has correct pct values", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    const p = s["pool"] as Record<string, unknown>[];
    const a1 = p.find((e) => e["number"] === 1);
    expect(a1?.["fiveHourPct"]).toBe(10);
    expect(a1?.["sevenDayPct"]).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// State: assignments and cursor
// ---------------------------------------------------------------------------

describe("buildStatus — assignments and cursor", () => {
  it("assignments reflects current state.assignments", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    expect(s["assignments"]).toEqual({ abc: 1 });
  });

  it("cursor reflects current state.cursor", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    expect(s["cursor"]).toBe(3);
  });

  it("empty assignments → empty object", () => {
    const state: SelectionState = { cursor: 0, assignments: {} };
    const s = buildStatus(cfg, pool, ready, state, null, null, null, null);
    expect(s["assignments"]).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// lastSpawn
// ---------------------------------------------------------------------------

describe("buildStatus — lastSpawn", () => {
  it("lastSpawn is null when null passed", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    expect(s["lastSpawn"]).toBeNull();
  });

  it("lastSpawn reflects passed value", () => {
    const s = buildStatus(cfg, pool, ready, baseState, lastSpawn, null, null, null);
    expect(s["lastSpawn"]).toEqual(lastSpawn);
  });

  it("lastSpawn contains sessionId, accountNumber, credentialDir, at", () => {
    const s = buildStatus(cfg, pool, ready, baseState, lastSpawn, null, null, null);
    const ls = s["lastSpawn"] as Record<string, unknown>;
    expect(ls["sessionId"]).toBe("abc");
    expect(ls["accountNumber"]).toBe(1);
    expect(ls["credentialDir"]).toBeTruthy();
    expect(ls["at"]).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// lastError (PRD §10 criterion 6 — diagnosability)
// ---------------------------------------------------------------------------

describe("buildStatus — lastError", () => {
  it("contains 'lastError' key", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    expect(s).toHaveProperty("lastError");
  });

  it("lastError is null when null passed", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    expect(s["lastError"]).toBeNull();
  });

  it("lastError reflects passed message", () => {
    const s = buildStatus(
      cfg,
      pool,
      ready,
      baseState,
      null,
      "cswap --list --json exited with code 127",
      null,
      null,
    );
    expect(s["lastError"]).toBe("cswap --list --json exited with code 127");
  });
});

// ---------------------------------------------------------------------------
// JSON cleanliness
// ---------------------------------------------------------------------------

describe("buildStatus — JSON cleanliness", () => {
  it("JSON.stringify round-trips without error", () => {
    const s = buildStatus(cfg, pool, ready, baseState, lastSpawn, null, null, null);
    expect(() => JSON.stringify(s)).not.toThrow();
  });

  it("JSON.parse(JSON.stringify(...)) deeply equals original", () => {
    const s = buildStatus(cfg, pool, ready, baseState, lastSpawn, null, null, null);
    const roundTripped = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
    expect(roundTripped).toEqual(s);
  });

  it("no undefined values anywhere in the output", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    const serialized = JSON.stringify(s);
    // JSON.stringify drops undefined keys; if the round-trip equals the original,
    // there are no undefined values leaking into the keys
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    expect(Object.keys(parsed).length).toBe(Object.keys(s).length);
  });

  it("no Set instances in the output (ready is converted to booleans)", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    const serialized = JSON.stringify(s);
    // Sets serialize as {} in JSON; if 'ready' were a Set it would be {}
    // Verify 'ready' per pool entry is a boolean (already checked), and
    // no top-level Set appears
    expect(serialized).not.toContain('"ready":{}');
  });
});

// ---------------------------------------------------------------------------
// lastHeal + restoreFailure
// ---------------------------------------------------------------------------

describe("buildStatus — lastHeal and restoreFailure", () => {
  const sampleHeal: HealRecord = {
    at: "2026-06-29T10:00:00.000Z",
    target: 2,
    outcome: "healed",
    restoreFailed: false,
  };

  const sampleRestoreFailure: HealRestoreFailure = {
    at: "2026-06-29T10:01:00.000Z",
    intendedActive: 99,
    landedActive: 2,
  };

  it("contains 'lastHeal' key", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    expect(s).toHaveProperty("lastHeal");
  });

  it("contains 'restoreFailure' key", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    expect(s).toHaveProperty("restoreFailure");
  });

  it("lastHeal is null when null passed", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    expect(s["lastHeal"]).toBeNull();
  });

  it("restoreFailure is null when null passed", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    expect(s["restoreFailure"]).toBeNull();
  });

  it("lastHeal reflects passed HealRecord", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, sampleHeal, null);
    expect(s["lastHeal"]).toEqual(sampleHeal);
  });

  it("restoreFailure reflects passed HealRestoreFailure", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, sampleRestoreFailure);
    expect(s["restoreFailure"]).toEqual(sampleRestoreFailure);
  });

  it("config contains autoHeal", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    const c = s["config"] as Record<string, unknown>;
    expect(c).toHaveProperty("autoHeal");
    expect(typeof c["autoHeal"]).toBe("boolean");
  });

  it("config.autoHeal is true for default cfg", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    const c = s["config"] as Record<string, unknown>;
    expect(c["autoHeal"]).toBe(true);
  });

  it("config.autoHeal is false when parseConfig({ autoHeal: false })", () => {
    const customCfg = parseConfig({ autoHeal: false });
    const s = buildStatus(customCfg, pool, ready, baseState, null, null, null, null);
    const c = s["config"] as Record<string, unknown>;
    expect(c["autoHeal"]).toBe(false);
  });

  it("config contains autoHealAfterCycles", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null, null, null, null);
    const c = s["config"] as Record<string, unknown>;
    expect(c).toHaveProperty("autoHealAfterCycles");
    expect(typeof c["autoHealAfterCycles"]).toBe("number");
  });

  it("config.autoHealAfterCycles reflects the configured value", () => {
    const customCfg = parseConfig({ autoHealAfterCycles: 5 });
    const s = buildStatus(customCfg, pool, ready, baseState, null, null, null, null);
    const c = s["config"] as Record<string, unknown>;
    expect(c["autoHealAfterCycles"]).toBe(5);
  });
});
