import { describe, expect, it } from "bun:test";
import { buildStatus } from "../src/status";
import type { LastSpawn } from "../src/status";
import type { PoolAccount } from "../src/accounts";
import type { SelectionState } from "../src/selection";
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
    active: true,
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
    const s = buildStatus(cfg, pool, ready, baseState, null);
    expect(s).toHaveProperty("config");
  });

  it("contains 'pool' key", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null);
    expect(s).toHaveProperty("pool");
  });

  it("contains 'assignments' key", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null);
    expect(s).toHaveProperty("assignments");
  });

  it("contains 'cursor' key", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null);
    expect(s).toHaveProperty("cursor");
  });

  it("contains 'lastSpawn' key", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null);
    expect(s).toHaveProperty("lastSpawn");
  });
});

// ---------------------------------------------------------------------------
// Config section
// ---------------------------------------------------------------------------

describe("buildStatus — config section", () => {
  it("config reflects cswapBin", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null);
    const c = s["config"] as Record<string, unknown>;
    expect(c["cswapBin"]).toBe("cswap");
  });

  it("config reflects rateLimitPct", () => {
    const customCfg = parseConfig({ rateLimitPct: 80 });
    const s = buildStatus(customCfg, pool, ready, baseState, null);
    const c = s["config"] as Record<string, unknown>;
    expect(c["rateLimitPct"]).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// Pool section
// ---------------------------------------------------------------------------

describe("buildStatus — pool section", () => {
  it("pool is an array with same length as input pool", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null);
    const p = s["pool"] as unknown[];
    expect(Array.isArray(p)).toBe(true);
    expect(p).toHaveLength(pool.length);
  });

  it("each pool entry has number, email, usable, rateLimited, fiveHourPct, sevenDayPct, ready", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null);
    const p = s["pool"] as Record<string, unknown>[];
    for (const entry of p) {
      expect(entry).toHaveProperty("number");
      expect(entry).toHaveProperty("email");
      expect(entry).toHaveProperty("usable");
      expect(entry).toHaveProperty("rateLimited");
      expect(entry).toHaveProperty("fiveHourPct");
      expect(entry).toHaveProperty("sevenDayPct");
      expect(entry).toHaveProperty("ready");
    }
  });

  it("pool entry 'ready' reflects ready Set: acct 1 ready, acct 2 not ready", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null);
    const p = s["pool"] as Record<string, unknown>[];
    const a1 = p.find((e) => e["number"] === 1);
    const a2 = p.find((e) => e["number"] === 2);
    expect(a1?.["ready"]).toBe(true);
    expect(a2?.["ready"]).toBe(false);
  });

  it("pool entry 'ready' is boolean (not a Set)", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null);
    const p = s["pool"] as Record<string, unknown>[];
    for (const entry of p) {
      expect(typeof entry["ready"]).toBe("boolean");
    }
  });

  it("pool entry has correct pct values", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null);
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
    const s = buildStatus(cfg, pool, ready, baseState, null);
    expect(s["assignments"]).toEqual({ abc: 1 });
  });

  it("cursor reflects current state.cursor", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null);
    expect(s["cursor"]).toBe(3);
  });

  it("empty assignments → empty object", () => {
    const state: SelectionState = { cursor: 0, assignments: {} };
    const s = buildStatus(cfg, pool, ready, state, null);
    expect(s["assignments"]).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// lastSpawn
// ---------------------------------------------------------------------------

describe("buildStatus — lastSpawn", () => {
  it("lastSpawn is null when null passed", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null);
    expect(s["lastSpawn"]).toBeNull();
  });

  it("lastSpawn reflects passed value", () => {
    const s = buildStatus(cfg, pool, ready, baseState, lastSpawn);
    expect(s["lastSpawn"]).toEqual(lastSpawn);
  });

  it("lastSpawn contains sessionId, accountNumber, credentialDir, at", () => {
    const s = buildStatus(cfg, pool, ready, baseState, lastSpawn);
    const ls = s["lastSpawn"] as Record<string, unknown>;
    expect(ls["sessionId"]).toBe("abc");
    expect(ls["accountNumber"]).toBe(1);
    expect(ls["credentialDir"]).toBeTruthy();
    expect(ls["at"]).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// JSON cleanliness
// ---------------------------------------------------------------------------

describe("buildStatus — JSON cleanliness", () => {
  it("JSON.stringify round-trips without error", () => {
    const s = buildStatus(cfg, pool, ready, baseState, lastSpawn);
    expect(() => JSON.stringify(s)).not.toThrow();
  });

  it("JSON.parse(JSON.stringify(...)) deeply equals original", () => {
    const s = buildStatus(cfg, pool, ready, baseState, lastSpawn);
    const roundTripped = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
    expect(roundTripped).toEqual(s);
  });

  it("no undefined values anywhere in the output", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null);
    const serialized = JSON.stringify(s);
    // JSON.stringify drops undefined keys; if the round-trip equals the original,
    // there are no undefined values leaking into the keys
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    expect(Object.keys(parsed).length).toBe(Object.keys(s).length);
  });

  it("no Set instances in the output (ready is converted to booleans)", () => {
    const s = buildStatus(cfg, pool, ready, baseState, null);
    const serialized = JSON.stringify(s);
    // Sets serialize as {} in JSON; if 'ready' were a Set it would be {}
    // Verify 'ready' per pool entry is a boolean (already checked), and
    // no top-level Set appears
    expect(serialized).not.toContain('"ready":{}');
  });
});
