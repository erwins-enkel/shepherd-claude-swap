import { describe, expect, it } from "bun:test";
import { buildUIView } from "../src/ui-view";
import type { PluginUINode } from "../types";
import type { PoolAccount } from "../src/accounts";
import type { SelectionState } from "../src/selection";
import type { LastSpawn } from "../src/status";
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
    fiveHourPct: 20,
    sevenDayPct: 30,
    active: true,
    ...opts,
  };
}

/** Walk the tree and collect all `type` values. */
function collectTypes(node: PluginUINode): string[] {
  const types: string[] = [node.type];
  for (const child of node.children ?? []) {
    types.push(...collectTypes(child));
  }
  return types;
}

/** Walk the tree and return all nodes with matching type. */
function findByType(node: PluginUINode, type: string): PluginUINode[] {
  const results: PluginUINode[] = [];
  if (node.type === type) results.push(node);
  for (const child of node.children ?? []) {
    results.push(...findByType(child, type));
  }
  return results;
}

const cfg = parseConfig({});
const cfgWith80Pct = parseConfig({ rateLimitPct: 80 });

const pool: PoolAccount[] = [
  makeAccount(1, { fiveHourPct: 40, sevenDayPct: 50 }), // ready, usable
  makeAccount(2, { rateLimited: true, fiveHourPct: 95, sevenDayPct: 99 }), // rate-limited
  makeAccount(3, { fiveHourPct: null, sevenDayPct: null }), // usable, warming (not in ready)
];
const ready = new Set([1]);
const baseState: SelectionState = {
  cursor: 2,
  assignments: { "session-abc": 1, "session-xyz": 2 },
};

const lastSpawn: LastSpawn = {
  sessionId: "session-abc",
  accountNumber: 1,
  credentialDir: "/home/user/.local/share/claude-swap/sessions/1-acct1_example.com",
  at: "2024-01-01T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Top-level structure
// ---------------------------------------------------------------------------

describe("buildUIView — top-level structure", () => {
  it("returns schemaVersion 1, slot settings-panel, title claude-swap", () => {
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null);
    expect(v.schemaVersion).toBe(1);
    expect(v.slot).toBe("settings-panel");
    expect(v.title).toBe("claude-swap");
  });

  it("root is a stack node", () => {
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null);
    expect(v.root.type).toBe("stack");
  });
});

// ---------------------------------------------------------------------------
// Required node types (acceptance criteria)
// ---------------------------------------------------------------------------

describe("buildUIView — required node types", () => {
  it("tree contains at least one meter node", () => {
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null);
    const types = collectTypes(v.root);
    expect(types).toContain("meter");
  });

  it("tree contains at least one badge node", () => {
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null);
    const types = collectTypes(v.root);
    expect(types).toContain("badge");
  });

  it("tree contains at least one table node", () => {
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null);
    const types = collectTypes(v.root);
    expect(types).toContain("table");
  });

  it("tree contains at least one key-value node", () => {
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null);
    const types = collectTypes(v.root);
    expect(types).toContain("key-value");
  });
});

// ---------------------------------------------------------------------------
// Badge tones
// ---------------------------------------------------------------------------

describe("buildUIView — badge tones", () => {
  it("ready account gets tone ok", () => {
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null);
    const badges = findByType(v.root, "badge");
    const readyBadge = badges.find((b) => b.props?.["label"] === "ready");
    expect(readyBadge?.props?.["tone"]).toBe("ok");
  });

  it("rate-limited account gets tone error", () => {
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null);
    const badges = findByType(v.root, "badge");
    const rlBadge = badges.find((b) => b.props?.["label"] === "rate-limited");
    expect(rlBadge?.props?.["tone"]).toBe("error");
  });

  it("usable-but-not-ready account gets warming tone warn", () => {
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null);
    const badges = findByType(v.root, "badge");
    const warmBadge = badges.find((b) => b.props?.["label"] === "warming");
    expect(warmBadge?.props?.["tone"]).toBe("warn");
  });

  it("unusable account gets tone neutral", () => {
    const unusablePool = [makeAccount(4, { usable: false, reason: "api_key" })];
    const v = buildUIView(cfg, unusablePool, new Set(), baseState, null, null);
    const badges = findByType(v.root, "badge");
    const neutralBadge = badges.find((b) => b.props?.["tone"] === "neutral");
    expect(neutralBadge).toBeTruthy();
    expect(neutralBadge?.props?.["label"]).toBe("api_key");
  });

  it("unusable account with null reason falls back to 'unusable'", () => {
    const unusablePool = [makeAccount(5, { usable: false, reason: null })];
    const v = buildUIView(cfg, unusablePool, new Set(), baseState, null, null);
    const badges = findByType(v.root, "badge");
    const neutralBadge = badges.find((b) => b.props?.["tone"] === "neutral");
    expect(neutralBadge?.props?.["label"]).toBe("unusable");
  });
});

// ---------------------------------------------------------------------------
// Meter tones
// ---------------------------------------------------------------------------

describe("buildUIView — meter tones", () => {
  it("meter tone is error when pct >= rateLimitPct", () => {
    // acct2 has fiveHourPct 95, cfg.rateLimitPct = 100 → ok; use cfgWith80Pct → error
    const v = buildUIView(cfgWith80Pct, pool, ready, baseState, lastSpawn, null);
    const meters = findByType(v.root, "meter");
    const errorMeters = meters.filter((m) => m.props?.["tone"] === "error");
    expect(errorMeters.length).toBeGreaterThan(0);
  });

  it("meter tone is ok when pct < rateLimitPct", () => {
    // acct1 has fiveHourPct 40, sevenDayPct 50 < rateLimitPct 100 → ok
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null);
    const meters = findByType(v.root, "meter");
    const acct1Meters = meters.filter((m) => {
      const val = m.props?.["value"];
      return val === 40 || val === 50;
    });
    for (const m of acct1Meters) {
      expect(m.props?.["tone"]).toBe("ok");
    }
  });

  it("null pct renders value 0 and caption n/a", () => {
    const nullPool = [makeAccount(9, { fiveHourPct: null, sevenDayPct: null })];
    const v = buildUIView(cfg, nullPool, new Set([9]), baseState, null, null);
    const meters = findByType(v.root, "meter");
    for (const m of meters) {
      expect(m.props?.["value"]).toBe(0);
      expect(m.props?.["caption"]).toBe("n/a");
    }
  });
});

// ---------------------------------------------------------------------------
// Assignments table
// ---------------------------------------------------------------------------

describe("buildUIView — assignments table", () => {
  it("table rows match state.assignments", () => {
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null);
    const tables = findByType(v.root, "table");
    expect(tables.length).toBeGreaterThan(0);
    const rows = tables[0]?.props?.["rows"] as string[][];
    expect(rows).toHaveLength(2);
    const sessionIds = rows.map((r) => r[0]);
    expect(sessionIds).toContain("session-abc");
    expect(sessionIds).toContain("session-xyz");
    const accountVals = rows.map((r) => r[1]);
    expect(accountVals).toContain("#1");
    expect(accountVals).toContain("#2");
  });

  it("empty assignments → table with empty rows", () => {
    const emptyState: SelectionState = { cursor: 0, assignments: {} };
    const v = buildUIView(cfg, pool, ready, emptyState, null, null);
    const tables = findByType(v.root, "table");
    const rows = tables[0]?.props?.["rows"] as unknown[];
    expect(rows).toHaveLength(0);
  });

  it("table has columns Session and Account", () => {
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null);
    const tables = findByType(v.root, "table");
    const cols = tables[0]?.props?.["columns"] as string[];
    expect(cols).toEqual(["Session", "Account"]);
  });
});

// ---------------------------------------------------------------------------
// lastSpawn
// ---------------------------------------------------------------------------

describe("buildUIView — lastSpawn", () => {
  it("lastSpawn present → key-value with session/account/at", () => {
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null);
    const kvs = findByType(v.root, "key-value");
    const spawnKv = kvs.find((kv) => {
      const pairs = kv.props?.["pairs"] as Array<{ key: string; value: string }>;
      return pairs?.some((p) => p.key === "session");
    });
    expect(spawnKv).toBeTruthy();
    const pairs = spawnKv?.props?.["pairs"] as Array<{ key: string; value: string }>;
    const keys = pairs.map((p) => p.key);
    expect(keys).toContain("session");
    expect(keys).toContain("account");
    expect(keys).toContain("at");
  });

  it("lastSpawn null → text 'No spawns yet'", () => {
    const v = buildUIView(cfg, pool, ready, baseState, null, null);
    const textNodes = findByType(v.root, "text");
    const noSpawnText = textNodes.find((t) => t.props?.["content"] === "No spawns yet");
    expect(noSpawnText).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// lastError callout
// ---------------------------------------------------------------------------

describe("buildUIView — lastError", () => {
  it("lastError present → callout node with tone error and matching text", () => {
    const errMsg = "cswap --list exited with code 127";
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, errMsg);
    const callouts = findByType(v.root, "callout");
    expect(callouts.length).toBeGreaterThan(0);
    expect(callouts[0]?.props?.["tone"]).toBe("error");
    expect(callouts[0]?.props?.["text"]).toBe(errMsg);
  });

  it("lastError null → no callout node", () => {
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null);
    const callouts = findByType(v.root, "callout");
    expect(callouts.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Empty pool
// ---------------------------------------------------------------------------

describe("buildUIView — empty pool", () => {
  it("empty pool → text 'No accounts'", () => {
    const v = buildUIView(cfg, [], new Set(), baseState, null, null);
    const textNodes = findByType(v.root, "text");
    const noAcctsText = textNodes.find((t) => t.props?.["content"] === "No accounts");
    expect(noAcctsText).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// JSON cleanliness
// ---------------------------------------------------------------------------

describe("buildUIView — JSON cleanliness", () => {
  it("JSON.stringify doesn't throw", () => {
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, "some error");
    expect(() => JSON.stringify(v)).not.toThrow();
  });

  it("round-trips through JSON.parse", () => {
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null);
    const rt = JSON.parse(JSON.stringify(v)) as typeof v;
    expect(rt).toEqual(v);
  });
});
