import { describe, expect, it } from "bun:test";
import { buildUIView } from "../src/ui-view";
import type { PluginUINode } from "../types";
import type { PoolAccount } from "../src/accounts";
import type { SelectionState } from "../src/selection";
import type { LastSpawn } from "../src/status";
import { parseConfig } from "../src/config";
import { History, CHART_WINDOW, MAX_DETAILED_ACCOUNTS } from "../src/history";

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

// ---------------------------------------------------------------------------
// Tree-budget helpers
// ---------------------------------------------------------------------------

function collectAllArrayLengths(val: unknown): number[] {
  if (Array.isArray(val)) {
    return [val.length, ...val.flatMap(collectAllArrayLengths)];
  }
  if (typeof val === "object" && val !== null) {
    return Object.values(val as Record<string, unknown>).flatMap(collectAllArrayLengths);
  }
  return [];
}

function treeStats(node: PluginUINode): { nodeCount: number; maxArrayLen: number; depth: number } {
  const arrayLens: number[] = [];
  if (node.props) {
    for (const val of Object.values(node.props)) {
      arrayLens.push(...collectAllArrayLengths(val));
    }
  }
  const children = node.children ?? [];
  arrayLens.push(children.length);

  let nodeCount = 1;
  let depth = 1;
  for (const child of children) {
    const cs = treeStats(child);
    nodeCount += cs.nodeCount;
    arrayLens.push(cs.maxArrayLen);
    depth = Math.max(depth, 1 + cs.depth);
  }
  return { nodeCount, maxArrayLen: Math.max(0, ...arrayLens), depth };
}

// ---------------------------------------------------------------------------
// Graphical widgets — new node types present
// ---------------------------------------------------------------------------

describe("buildUIView — new graphical node types", () => {
  it("contains gauge, sparkline, time-series, bar-chart, timeline", () => {
    const h = new History();
    h.recordQuota(pool);
    h.recordSpawn({ sessionId: "session-abc", accountNumber: 1, at: "2024-01-01T00:00:00.000Z" });
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null, h);
    const types = collectTypes(v.root);
    expect(types).toContain("gauge");
    expect(types).toContain("sparkline");
    expect(types).toContain("time-series");
    expect(types).toContain("bar-chart");
    expect(types).toContain("timeline");
  });
});

// ---------------------------------------------------------------------------
// Graphical widgets — retained flat node types
// ---------------------------------------------------------------------------

describe("buildUIView — flat node types still present alongside graphical", () => {
  it("contains stack, text, badge, meter, table, key-value, callout", () => {
    const h = new History();
    h.recordQuota(pool);
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, "oops", h);
    const types = collectTypes(v.root);
    expect(types).toContain("stack");
    expect(types).toContain("text");
    expect(types).toContain("badge");
    expect(types).toContain("meter");
    expect(types).toContain("table");
    expect(types).toContain("key-value");
    expect(types).toContain("callout");
  });
});

// ---------------------------------------------------------------------------
// Graphical widgets — prop shapes
// ---------------------------------------------------------------------------

describe("buildUIView — graphical prop shapes", () => {
  it("gauge has numeric value and max===100", () => {
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null);
    const gauges = findByType(v.root, "gauge");
    expect(gauges.length).toBeGreaterThan(0);
    for (const g of gauges) {
      expect(typeof g.props?.["value"]).toBe("number");
      expect(g.props?.["max"]).toBe(100);
    }
  });

  it("sparkline points is an array", () => {
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null);
    const sparklines = findByType(v.root, "sparkline");
    expect(sparklines.length).toBeGreaterThan(0);
    expect(Array.isArray(sparklines[0]?.props?.["points"])).toBe(true);
  });

  it("time-series series is a non-empty array with label/tone/points", () => {
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null);
    const ts = findByType(v.root, "time-series");
    expect(ts.length).toBeGreaterThan(0);
    const series = ts[0]?.props?.["series"] as Array<{
      label: string;
      tone: string;
      points: number[];
    }>;
    expect(Array.isArray(series)).toBe(true);
    expect(series.length).toBeGreaterThan(0);
    for (const s of series) {
      expect(typeof s.label).toBe("string");
      expect(typeof s.tone).toBe("string");
      expect(Array.isArray(s.points)).toBe(true);
    }
  });

  it("bar-chart bars entries have label/value/tone", () => {
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null);
    const charts = findByType(v.root, "bar-chart");
    expect(charts.length).toBeGreaterThan(0);
    const bars = charts[0]?.props?.["bars"] as Array<{
      label: string;
      value: number;
      tone: string;
    }>;
    expect(Array.isArray(bars)).toBe(true);
    for (const b of bars) {
      expect(typeof b.label).toBe("string");
      expect(typeof b.value).toBe("number");
      expect(typeof b.tone).toBe("string");
    }
  });

  it("timeline events entry at equals spawn timestamp and label contains #account", () => {
    const h = new History();
    const spawnAt = "2024-06-01T12:00:00.000Z";
    h.recordSpawn({ sessionId: "s1", accountNumber: 7, at: spawnAt });
    const singlePool = [makeAccount(7)];
    const v = buildUIView(
      cfg,
      singlePool,
      new Set([7]),
      { cursor: 0, assignments: {} },
      null,
      null,
      h,
    );
    const timelines = findByType(v.root, "timeline");
    expect(timelines.length).toBeGreaterThan(0);
    const events = timelines[0]?.props?.["events"] as Array<{ at: string; label: string }>;
    expect(events.length).toBe(1);
    expect(events[0]?.at).toBe(spawnAt);
    expect(events[0]?.label).toContain("#7");
  });
});

// ---------------------------------------------------------------------------
// Graphical widgets — bar-chart load counts
// ---------------------------------------------------------------------------

describe("buildUIView — bar-chart load counts", () => {
  it("bar for #1 has value 2, #2 has value 1 with assignments {a:1, b:1, c:2}", () => {
    const twoPool = [makeAccount(1), makeAccount(2)];
    const assignState: SelectionState = { cursor: 0, assignments: { a: 1, b: 1, c: 2 } };
    const v = buildUIView(cfg, twoPool, new Set([1, 2]), assignState, null, null);
    const charts = findByType(v.root, "bar-chart");
    const bars = charts[0]?.props?.["bars"] as Array<{
      label: string;
      value: number;
      tone: string;
    }>;
    const bar1 = bars.find((b) => b.label === "#1");
    const bar2 = bars.find((b) => b.label === "#2");
    expect(bar1?.value).toBe(2);
    expect(bar2?.value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Graphical widgets — overflow cap
// ---------------------------------------------------------------------------

describe("buildUIView — overflow cap at MAX_DETAILED_ACCOUNTS", () => {
  it("20-account pool: 16 badges, 16 sparklines, and exactly one '+4 more accounts' text", () => {
    const bigPool = Array.from({ length: 20 }, (_, i) => makeAccount(i + 1));
    const v = buildUIView(cfg, bigPool, new Set(), { cursor: 0, assignments: {} }, null, null);
    const badges = findByType(v.root, "badge");
    expect(badges.length).toBe(16);
    const sparklines = findByType(v.root, "sparkline");
    expect(sparklines.length).toBe(16);
    const texts = findByType(v.root, "text");
    const overflowTexts = texts.filter((t) => t.props?.["content"] === "+4 more accounts");
    expect(overflowTexts.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Graphical widgets — downsample applied
// ---------------------------------------------------------------------------

describe("buildUIView — downsample applied to sparkline points", () => {
  it("recording >CHART_WINDOW samples yields sparkline.points.length <= CHART_WINDOW, last value matches last sample", () => {
    const h = new History();
    const singlePool = [makeAccount(1)];
    // Record 100 samples, last five=77
    for (let i = 0; i < 99; i++) {
      h.recordQuota([makeAccount(1, { fiveHourPct: i % 50, sevenDayPct: 0 })]);
    }
    h.recordQuota([makeAccount(1, { fiveHourPct: 77, sevenDayPct: 0 })]);
    const v = buildUIView(
      cfg,
      singlePool,
      new Set([1]),
      { cursor: 0, assignments: {} },
      null,
      null,
      h,
    );
    const sparklines = findByType(v.root, "sparkline");
    const pts = sparklines[0]?.props?.["points"] as number[];
    expect(pts.length).toBeLessThanOrEqual(CHART_WINDOW);
    expect(pts[pts.length - 1]).toBe(77);
  });
});

// ---------------------------------------------------------------------------
// Graphical widgets — FULL-ring joint budget
// ---------------------------------------------------------------------------

describe("buildUIView — FULL-ring joint budget", () => {
  it("40-account pool, full rings: total nodes <=256, maxArrayLen <=500, depth <=16, JSON <=64KiB", () => {
    const bigPool = Array.from({ length: 40 }, (_, i) =>
      makeAccount(i + 1, { fiveHourPct: 50, sevenDayPct: 60 }),
    );
    const h = new History();
    // Record 288 quota samples for each of the first MAX_DETAILED_ACCOUNTS accounts
    for (let s = 0; s < 288; s++) {
      h.recordQuota(
        bigPool.slice(0, MAX_DETAILED_ACCOUNTS).map((a) => ({ ...a, fiveHourPct: s % 100 })),
      );
    }
    // Record 50 spawns
    for (let s = 0; s < 50; s++) {
      h.recordSpawn({
        sessionId: `sess-${s}`,
        accountNumber: (s % MAX_DETAILED_ACCOUNTS) + 1,
        at: new Date(s * 1000).toISOString(),
      });
    }
    const v = buildUIView(cfg, bigPool, new Set(), { cursor: 0, assignments: {} }, null, null, h);
    const stats = treeStats(v.root);
    expect(stats.nodeCount).toBeLessThanOrEqual(256);
    expect(stats.maxArrayLen).toBeLessThanOrEqual(500);
    expect(stats.depth).toBeLessThanOrEqual(16);
    expect(Buffer.byteLength(JSON.stringify(v), "utf8")).toBeLessThanOrEqual(64 * 1024);
  });
});

// ---------------------------------------------------------------------------
// Graphical widgets — empty-history behavior
// ---------------------------------------------------------------------------

describe("buildUIView — empty history", () => {
  it("fresh History: timeline present with events.length===0, time-series present, bar-chart present", () => {
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null, new History());
    const timelines = findByType(v.root, "timeline");
    expect(timelines.length).toBeGreaterThan(0);
    const events = timelines[0]?.props?.["events"] as unknown[];
    expect(events.length).toBe(0);
    expect(findByType(v.root, "time-series").length).toBeGreaterThan(0);
    expect(findByType(v.root, "bar-chart").length).toBeGreaterThan(0);
  });
});
