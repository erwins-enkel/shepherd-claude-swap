import { describe, expect, it } from "bun:test";
import { buildUIView } from "../src/ui-view";
import type { PluginUINode } from "../types";
import type { PoolAccount, ScopedWindow, SpendInfo } from "../src/accounts";
import type { SelectionState } from "../src/selection";
import type { LastSpawn } from "../src/status";
import type { HealRecord, HealRestoreFailure } from "../src/prewarm";
import { parseConfig } from "../src/config";
import type { ResolvedConfig } from "../src/config";
import {
  History,
  CHART_WINDOW,
  MAX_DETAILED_ACCOUNTS,
  QUOTA_RING_CAP,
  SPAWN_RING_CAP,
} from "../src/history";

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
    fiveHourResetsAt: null,
    sevenDayResetsAt: null,
    fiveHourResetClock: null,
    sevenDayResetClock: null,
    fiveHourResetCountdown: null,
    sevenDayResetCountdown: null,
    active: true,
    usageUnavailable: false,
    cswapDisabled: false,
    alias: null,
    organizationName: null,
    usageAgeSeconds: null,
    spend: null,
    sevenDayPace: { expectedPct: null, aheadOfPace: false },
    scopedWindows: [],
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
  makeAccount(1, { active: false, fiveHourPct: 40, sevenDayPct: 50 }), // ready, usable
  makeAccount(2, { active: false, rateLimited: true, fiveHourPct: 95, sevenDayPct: 99 }), // rate-limited
  makeAccount(3, { active: false, fiveHourPct: 30, sevenDayPct: 40 }), // usable, warming (not in ready)
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
    const unusablePool = [makeAccount(4, { active: false, usable: false, reason: "api_key" })];
    const v = buildUIView(cfg, unusablePool, new Set(), baseState, null, null);
    const badges = findByType(v.root, "badge");
    // Identity badges are also neutral, so locate the status badge by its label.
    const statusBadge = badges.find((b) => b.props?.["label"] === "api_key");
    expect(statusBadge).toBeTruthy();
    expect(statusBadge?.props?.["tone"]).toBe("neutral");
  });

  it("unusable account with null reason falls back to 'unusable'", () => {
    const unusablePool = [makeAccount(5, { active: false, usable: false, reason: null })];
    const v = buildUIView(cfg, unusablePool, new Set(), baseState, null, null);
    const badges = findByType(v.root, "badge");
    // Identity badges are also neutral, so locate the status badge by its label.
    const statusBadge = badges.find((b) => b.props?.["label"] === "unusable");
    expect(statusBadge).toBeTruthy();
    expect(statusBadge?.props?.["tone"]).toBe("neutral");
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

  it("caption appends 'resets <clock> (<countdown>)' when reset data present", () => {
    const resetPool = [
      makeAccount(7, {
        fiveHourPct: 93,
        fiveHourResetClock: "22:00",
        fiveHourResetCountdown: "1h 43m",
      }),
    ];
    const v = buildUIView(cfg, resetPool, new Set([7]), baseState, null, null);
    const captions = findByType(v.root, "meter").map((m) => m.props?.["caption"]);
    expect(captions).toContain("93% · resets 22:00 (1h 43m)");
  });

  it("caption shows clock without empty parens when countdown is missing", () => {
    const resetPool = [
      makeAccount(8, {
        fiveHourPct: 50,
        fiveHourResetClock: "22:00",
        fiveHourResetCountdown: null,
      }),
    ];
    const v = buildUIView(cfg, resetPool, new Set([8]), baseState, null, null);
    const captions = findByType(v.root, "meter").map((m) => m.props?.["caption"]);
    expect(captions).toContain("50% · resets 22:00");
  });

  it("no reset suffix when clock is absent (caption stays bare pct)", () => {
    const noClockPool = [makeAccount(6, { fiveHourPct: 40, fiveHourResetClock: null })];
    const v = buildUIView(cfg, noClockPool, new Set([6]), baseState, null, null);
    const captions = findByType(v.root, "meter").map((m) => m.props?.["caption"]);
    expect(captions).toContain("40%");
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
// Quota-unknown account
// ---------------------------------------------------------------------------

describe("buildUIView — quota-unknown account", () => {
  const unknownPool = [
    makeAccount(10, {
      active: false,
      usageUnavailable: true,
      cswapDisabled: false,
      alias: null,
      organizationName: null,
      usageAgeSeconds: null,
      spend: null,
      sevenDayPace: { expectedPct: null, aheadOfPace: false },
      fiveHourPct: null,
      sevenDayPct: null,
    }),
  ];

  it("badge label is 'quota unknown'", () => {
    const v = buildUIView(cfg, unknownPool, new Set(), baseState, null, null);
    const badges = findByType(v.root, "badge");
    const unknownBadge = badges.find((b) => b.props?.["label"] === "quota unknown");
    expect(unknownBadge).toBeTruthy();
    expect(unknownBadge?.props?.["tone"]).toBe("warn");
  });

  it("'quota unknown — deprioritized; re-checked next refresh' text node is present", () => {
    const v = buildUIView(cfg, unknownPool, new Set(), baseState, null, null);
    const texts = findByType(v.root, "text");
    const found = texts.find(
      (t) => t.props?.["content"] === "quota unknown — deprioritized; re-checked next refresh",
    );
    expect(found).toBeTruthy();
  });

  it("no meter node for quota-unknown account", () => {
    const v = buildUIView(cfg, unknownPool, new Set(), baseState, null, null);
    const meters = findByType(v.root, "meter");
    expect(meters.length).toBe(0);
  });

  it("no gauge node for quota-unknown account", () => {
    const v = buildUIView(cfg, unknownPool, new Set(), baseState, null, null);
    const gauges = findByType(v.root, "gauge");
    expect(gauges.length).toBe(0);
  });

  it("no sparkline node for quota-unknown account", () => {
    const v = buildUIView(cfg, unknownPool, new Set(), baseState, null, null);
    const sparklines = findByType(v.root, "sparkline");
    expect(sparklines.length).toBe(0);
  });

  it("quota-unknown account absent from time-series series", () => {
    const v = buildUIView(cfg, unknownPool, new Set(), baseState, null, null);
    const ts = findByType(v.root, "time-series");
    const series = ts[0]?.props?.["series"] as Array<{ label: string }>;
    const inSeries = series?.some((s) => s.label === "#10");
    expect(inSeries).toBeFalsy();
    expect(series?.length).toBe(0);
  });

  it("badge precedence: quota-unknown account in ready set shows 'quota unknown', not 'ready'", () => {
    const v = buildUIView(cfg, unknownPool, new Set([10]), baseState, null, null);
    const badges = findByType(v.root, "badge");
    const readyBadge = badges.find((b) => b.props?.["label"] === "ready");
    expect(readyBadge).toBeUndefined();
    const unknownBadge = badges.find((b) => b.props?.["label"] === "quota unknown");
    expect(unknownBadge).toBeTruthy();
  });

  it("time-series caption mentions hidden count when unavailable accounts omitted", () => {
    const mixedPool = [makeAccount(1, { fiveHourPct: 10, sevenDayPct: 10 }), ...unknownPool];
    const v = buildUIView(cfg, mixedPool, new Set(), baseState, null, null);
    const ts = findByType(v.root, "time-series");
    const caption = ts[0]?.props?.["caption"] as string;
    expect(caption).toContain("hidden: quota unknown");
  });
});

// ---------------------------------------------------------------------------
// Primary badge (active account)
// ---------------------------------------------------------------------------

describe("buildUIView — primary account (active: true)", () => {
  const primaryPool = [makeAccount(11, { active: true, fiveHourPct: 40, sevenDayPct: 50 })];

  it("active account status badge has label 'primary'", () => {
    const v = buildUIView(cfg, primaryPool, new Set(), baseState, null, null);
    const badges = findByType(v.root, "badge");
    const primaryBadge = badges.find((b) => b.props?.["label"] === "primary");
    expect(primaryBadge).toBeTruthy();
  });

  it("primary badge has tone 'info' (visually distinct from neutral identity badge)", () => {
    const v = buildUIView(cfg, primaryPool, new Set(), baseState, null, null);
    const badges = findByType(v.root, "badge");
    const primaryBadge = badges.find((b) => b.props?.["label"] === "primary");
    expect(primaryBadge?.props?.["tone"]).toBe("info");
  });

  it("active account does NOT show 'warming' badge even when usable-not-ready", () => {
    const v = buildUIView(cfg, primaryPool, new Set(), baseState, null, null);
    const badges = findByType(v.root, "badge");
    const warmingBadge = badges.find((b) => b.props?.["label"] === "warming");
    expect(warmingBadge).toBeUndefined();
  });

  it("active account with pct (not usageUnavailable) still emits meter nodes", () => {
    const v = buildUIView(cfg, primaryPool, new Set([11]), baseState, null, null);
    const meters = findByType(v.root, "meter");
    expect(meters.length).toBeGreaterThan(0);
  });

  it("active + usageUnavailable quota-unknown note says 'primary account (excluded from rotation)'", () => {
    const activeUnknownPool = [
      makeAccount(12, {
        active: true,
        usageUnavailable: true,
        cswapDisabled: false,
        alias: null,
        organizationName: null,
        usageAgeSeconds: null,
        spend: null,
        sevenDayPace: { expectedPct: null, aheadOfPace: false },
        fiveHourPct: null,
        sevenDayPct: null,
      }),
    ];
    const v = buildUIView(cfg, activeUnknownPool, new Set(), baseState, null, null);
    const texts = findByType(v.root, "text");
    const found = texts.find(
      (t) => t.props?.["content"] === "quota unknown — primary account (excluded from rotation)",
    );
    expect(found).toBeTruthy();
  });

  it("active + usageUnavailable note does NOT say 'deprioritized'", () => {
    const activeUnknownPool = [
      makeAccount(12, {
        active: true,
        usageUnavailable: true,
        cswapDisabled: false,
        alias: null,
        organizationName: null,
        usageAgeSeconds: null,
        spend: null,
        sevenDayPace: { expectedPct: null, aheadOfPace: false },
        fiveHourPct: null,
        sevenDayPct: null,
      }),
    ];
    const v = buildUIView(cfg, activeUnknownPool, new Set(), baseState, null, null);
    const texts = findByType(v.root, "text");
    const deprioritizedText = texts.find(
      (t) =>
        typeof t.props?.["content"] === "string" &&
        (t.props["content"] as string).includes("deprioritized"),
    );
    expect(deprioritizedText).toBeUndefined();
  });

  it("regression: non-active ready account still shows 'ready' badge", () => {
    const nonActivePool = [makeAccount(13, { active: false, fiveHourPct: 40, sevenDayPct: 50 })];
    const v = buildUIView(cfg, nonActivePool, new Set([13]), baseState, null, null);
    const badges = findByType(v.root, "badge");
    const readyBadge = badges.find((b) => b.props?.["label"] === "ready");
    expect(readyBadge).toBeTruthy();
    expect(readyBadge?.props?.["tone"]).toBe("ok");
  });

  it("regression: non-active usable-not-ready account still shows 'warming' badge", () => {
    const nonActivePool = [makeAccount(14, { active: false, fiveHourPct: 40, sevenDayPct: 50 })];
    const v = buildUIView(cfg, nonActivePool, new Set(), baseState, null, null);
    const badges = findByType(v.root, "badge");
    const warmingBadge = badges.find((b) => b.props?.["label"] === "warming");
    expect(warmingBadge).toBeTruthy();
    expect(warmingBadge?.props?.["tone"]).toBe("warn");
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
  it("contains stack, text, badge, meter, key-value, callout", () => {
    const h = new History();
    h.recordQuota(pool);
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, "oops", h);
    const types = collectTypes(v.root);
    expect(types).toContain("stack");
    expect(types).toContain("text");
    expect(types).toContain("badge");
    expect(types).toContain("meter");
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
  it("20-account pool: 48 badges, 16 sparklines, and exactly one '+4 more accounts' text", () => {
    const bigPool = Array.from({ length: 20 }, (_, i) => makeAccount(i + 1));
    const v = buildUIView(cfg, bigPool, new Set(), { cursor: 0, assignments: {} }, null, null);
    const badges = findByType(v.root, "badge");
    // 16 detailed accounts × (flat identity + flat status + graphical identity) = 48.
    expect(badges.length).toBe(48);
    const sparklines = findByType(v.root, "sparkline");
    expect(sparklines.length).toBe(16);
    const texts = findByType(v.root, "text");
    const overflowTexts = texts.filter((t) => t.props?.["content"] === "+4 more accounts");
    expect(overflowTexts.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Account identity badges + on-bar label prefix
// ---------------------------------------------------------------------------

describe("buildUIView — account identity attribution", () => {
  const emptyState: SelectionState = { cursor: 0, assignments: {} };

  it("normal account: neutral identity badge emitted in both flat and graphical sections", () => {
    const v = buildUIView(cfg, [makeAccount(1)], new Set([1]), emptyState, null, null);
    const idBadges = findByType(v.root, "badge").filter(
      (b) => b.props?.["label"] === "#1 acct1@example.com",
    );
    expect(idBadges.length).toBe(2); // flat Pool header + graphical normal header
    for (const b of idBadges) expect(b.props?.["tone"]).toBe("neutral");
  });

  it("quota-unknown account: identity badge in BOTH sections (covers the graphical usageUnavailable branch)", () => {
    const unknownPool = [
      makeAccount(10, { usageUnavailable: true, fiveHourPct: null, sevenDayPct: null }),
    ];
    const v = buildUIView(cfg, unknownPool, new Set(), emptyState, null, null);
    const idBadges = findByType(v.root, "badge").filter(
      (b) => b.props?.["label"] === "#10 acct10@example.com",
    );
    // One from the flat Pool header, one from the graphical quota-unknown branch (line 178).
    // A missed conversion in that branch would drop this to 1.
    expect(idBadges.length).toBe(2);
    // Quota-unknown rows carry no bars, so the identity badge is the only attribution.
    expect(findByType(v.root, "meter").length).toBe(0);
    expect(findByType(v.root, "gauge").length).toBe(0);
  });

  it("normal account: meter and gauge labels are prefixed with the account number", () => {
    const v = buildUIView(cfg, [makeAccount(1)], new Set([1]), emptyState, null, null);
    const meter = findByType(v.root, "meter").find((m) => m.props?.["label"] === "#1 · 5h");
    expect(meter).toBeTruthy();
    const gauge = findByType(v.root, "gauge").find((g) => g.props?.["label"] === "#1 · 5h");
    expect(gauge).toBeTruthy();
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

// ---------------------------------------------------------------------------
// "Make primary" action-button picker (issue #21)
// ---------------------------------------------------------------------------

// Both action-button features gate the same host capability; "pre-#1209 host" turns both off.
const cfgButtonsOff = parseConfig({ makePrimaryButtons: false, rotationButtons: false });

/** action-button nodes whose label matches (used to isolate one feature's buttons from another's,
 *  since Make-primary and rotation toggles both render as `action-button`). */
function buttonsByLabel(root: PluginUINode, label: string): PluginUINode[] {
  return findByType(root, "action-button").filter((b) => b.props?.["label"] === label);
}

// Mixed pool exercising every eligibility branch.
const pickerPool: PoolAccount[] = [
  makeAccount(1, { active: true }), // active/primary — never gets a button
  makeAccount(2, { active: false, fiveHourPct: 40, sevenDayPct: 50 }), // eligible (usable, ready)
  makeAccount(3, { active: false, rateLimited: true, fiveHourPct: 95, sevenDayPct: 99 }), // rate-limited
  makeAccount(4, { active: false, usable: false, reason: "no_credentials" }), // unusable
  makeAccount(5, {
    active: false,
    fiveHourPct: null,
    sevenDayPct: null,
    usageUnavailable: true,
    cswapDisabled: false,
    alias: null,
    organizationName: null,
    usageAgeSeconds: null,
    spend: null,
    sevenDayPace: { expectedPct: null, aheadOfPace: false },
  }), // quota-unknown but usable — INTENTIONALLY eligible
];
const pickerReady = new Set([2]);

// Make-primary-only config: rotation buttons off so this picker's buttons are isolated.
const cfgMakePrimaryOnly = parseConfig({ rotationButtons: false });

describe("buildUIView — Make primary picker", () => {
  it("emits an action-button only for eligible non-primary accounts (usable, not rate-limited)", () => {
    const v = buildUIView(cfgMakePrimaryOnly, pickerPool, pickerReady, baseState, null, null);
    const buttons = buttonsByLabel(v.root, "Make primary");
    const accounts = buttons.map((b) => (b.props?.["body"] as { account: number }).account).sort();
    // #2 (ready) and #5 (quota-unknown but usable) are eligible; #1 active, #3 rate-limited, #4 unusable.
    expect(accounts).toEqual([2, 5]);
  });

  it("a quota-unknown but usable account is eligible (reporting gap, not unusability)", () => {
    const v = buildUIView(cfgMakePrimaryOnly, pickerPool, pickerReady, baseState, null, null);
    const accounts = buttonsByLabel(v.root, "Make primary").map(
      (b) => (b.props?.["body"] as { account: number }).account,
    );
    expect(accounts).toContain(5);
  });

  it("never emits a button for the active (primary), rate-limited, or unusable account", () => {
    const v = buildUIView(cfgMakePrimaryOnly, pickerPool, pickerReady, baseState, null, null);
    const accounts = buttonsByLabel(v.root, "Make primary").map(
      (b) => (b.props?.["body"] as { account: number }).account,
    );
    expect(accounts).not.toContain(1);
    expect(accounts).not.toContain(3);
    expect(accounts).not.toContain(4);
  });

  it("button carries the correct shape: POST switch-primary, specific mode, confirm, neutral tone", () => {
    const v = buildUIView(cfgMakePrimaryOnly, pickerPool, pickerReady, baseState, null, null);
    const button = buttonsByLabel(v.root, "Make primary").find(
      (b) => (b.props?.["body"] as { account: number }).account === 2,
    );
    expect(button).toBeDefined();
    expect(button?.props).toMatchObject({
      label: "Make primary",
      tone: "neutral",
      route: { method: "POST", path: "switch-primary" },
      body: { mode: "specific", account: 2 },
      confirm: "Make this the primary account?",
    });
  });

  it("uses a bare route path (no leading slash, host-resolved under the plugin namespace)", () => {
    const v = buildUIView(cfgMakePrimaryOnly, pickerPool, pickerReady, baseState, null, null);
    for (const b of buttonsByLabel(v.root, "Make primary")) {
      const path = (b.props?.["route"] as { path: string }).path;
      expect(path.startsWith("/")).toBe(false);
      expect(path).toBe("switch-primary");
    }
  });

  it("emits no action-button anywhere when both button flags are false (pre-#1209 escape hatch)", () => {
    const v = buildUIView(cfgButtonsOff, pickerPool, pickerReady, baseState, null, null);
    expect(findByType(v.root, "action-button").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// "Take out of rotation" / "Return to rotation" toggle
// ---------------------------------------------------------------------------

// Rotation-only config so this toggle's buttons are isolated from Make-primary buttons.
const cfgRotationOnly = parseConfig({ makePrimaryButtons: false });

/** Account numbers carried by the rotation buttons of the given label. */
function rotationAccounts(root: PluginUINode, label: string): number[] {
  return buttonsByLabel(root, label)
    .map((b) => (b.props?.["body"] as { account: number }).account)
    .sort((a, b) => a - b);
}

describe("buildUIView — rotation toggle", () => {
  it("offers 'Take out of rotation' for every non-active account (broad scope) when set is empty", () => {
    const v = buildUIView(cfgRotationOnly, pickerPool, pickerReady, baseState, null, null);
    // #2 usable, #3 rate-limited, #4 unusable, #5 quota-unknown — all non-active → eligible; #1 active → none.
    expect(rotationAccounts(v.root, "Take out of rotation")).toEqual([2, 3, 4, 5]);
    expect(rotationAccounts(v.root, "Return to rotation")).toEqual([]);
  });

  it("'Take out of rotation' carries POST set-rotation, inRotation:false, confirm, warn tone", () => {
    const v = buildUIView(cfgRotationOnly, pickerPool, pickerReady, baseState, null, null);
    const button = buttonsByLabel(v.root, "Take out of rotation").find(
      (b) => (b.props?.["body"] as { account: number }).account === 2,
    );
    expect(button?.props).toMatchObject({
      label: "Take out of rotation",
      tone: "warn",
      route: { method: "POST", path: "set-rotation" },
      body: { account: 2, inRotation: false },
      confirm: "Take this account out of rotation?",
    });
  });

  it("a set member gets 'Return to rotation' (no confirm) and not 'Take out of rotation'", () => {
    const v = buildUIView(
      cfgRotationOnly,
      pickerPool,
      pickerReady,
      baseState,
      null,
      null,
      undefined,
      null,
      null,
      new Set([3]),
    );
    expect(rotationAccounts(v.root, "Return to rotation")).toEqual([3]);
    expect(rotationAccounts(v.root, "Take out of rotation")).toEqual([2, 4, 5]);
    const ret = buttonsByLabel(v.root, "Return to rotation")[0];
    expect(ret?.props).toMatchObject({
      label: "Return to rotation",
      tone: "ok",
      route: { method: "POST", path: "set-rotation" },
      body: { account: 3, inRotation: true },
    });
    expect(ret?.props?.["confirm"]).toBeUndefined();
  });

  it("shows 'Return to rotation' for an account that is both in the set AND active (clearable flag)", () => {
    const v = buildUIView(
      cfgRotationOnly,
      pickerPool,
      pickerReady,
      baseState,
      null,
      null,
      undefined,
      null,
      null,
      new Set([1]),
    );
    expect(rotationAccounts(v.root, "Return to rotation")).toEqual([1]);
  });

  it("config-excluded account (excludeSlots) gets neither button, even when in the set", () => {
    const cfgExcluded = parseConfig({ makePrimaryButtons: false, excludeSlots: [4] });
    const v = buildUIView(
      cfgExcluded,
      pickerPool,
      pickerReady,
      baseState,
      null,
      null,
      undefined,
      null,
      null,
      new Set([4]),
    );
    expect(rotationAccounts(v.root, "Return to rotation")).not.toContain(4);
    expect(rotationAccounts(v.root, "Take out of rotation")).not.toContain(4);
  });

  it("not-in-include accounts (includeSlots) get no rotation button", () => {
    const cfgInclude = parseConfig({ makePrimaryButtons: false, includeSlots: [1, 2] });
    const v = buildUIView(cfgInclude, pickerPool, pickerReady, baseState, null, null);
    // Only #2 is a non-active in-include account → eligible; #3/#4/#5 are not-in-include.
    expect(rotationAccounts(v.root, "Take out of rotation")).toEqual([2]);
  });

  it("emits no rotation button when rotationButtons is false", () => {
    const cfgOff = parseConfig({ makePrimaryButtons: false, rotationButtons: false });
    const v = buildUIView(cfgOff, pickerPool, pickerReady, baseState, null, null);
    expect(buttonsByLabel(v.root, "Take out of rotation")).toHaveLength(0);
    expect(buttonsByLabel(v.root, "Return to rotation")).toHaveLength(0);
  });

  it("config key-value block includes rotationButtons", () => {
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null);
    const kv = findByType(v.root, "key-value")[0];
    const pairs = kv?.props?.["pairs"] as { key: string; value: string }[];
    expect(pairs.some((p) => p.key === "rotationButtons")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scoped weekly windows (Fable etc.)
// ---------------------------------------------------------------------------

describe("buildUIView — scoped weekly windows", () => {
  const emptyState: SelectionState = { cursor: 0, assignments: {} };

  it("scoped window renders a pool meter and a matching Graphics gauge with label/value/caption", () => {
    const scopedPool = [
      makeAccount(1, {
        scopedWindows: [
          {
            name: "Fable",
            pct: 39,
            resetsAt: null,
            resetClock: "Jul 8 08:59",
            resetCountdown: "3d 22h",
            expectedPct: null,
            aheadOfPace: false,
          },
        ],
      }),
    ];
    const v = buildUIView(cfg, scopedPool, new Set([1]), emptyState, null, null);
    const meter = findByType(v.root, "meter").find((m) => m.props?.["label"] === "#1 · Fable wk");
    expect(meter).toBeTruthy();
    expect(meter?.props?.["value"]).toBe(39);
    expect(meter?.props?.["max"]).toBe(100);
    expect(meter?.props?.["caption"]).toBe("39% · resets Jul 8 08:59 (3d 22h)");

    const gauge = findByType(v.root, "gauge").find((g) => g.props?.["label"] === "#1 · Fable wk");
    expect(gauge).toBeTruthy();
    expect(gauge?.props?.["value"]).toBe(39);
    expect(gauge?.props?.["max"]).toBe(100);
    expect(gauge?.props?.["caption"]).toBe("39% · resets Jul 8 08:59 (3d 22h)");
  });

  it("scoped window with null clock/countdown renders caption as bare pct", () => {
    const scopedPool = [
      makeAccount(2, {
        scopedWindows: [
          {
            name: "Fable",
            pct: 39,
            resetsAt: null,
            resetClock: null,
            resetCountdown: null,
            expectedPct: null,
            aheadOfPace: false,
          },
        ],
      }),
    ];
    const v = buildUIView(cfg, scopedPool, new Set([2]), emptyState, null, null);
    const meter = findByType(v.root, "meter").find((m) => m.props?.["label"] === "#2 · Fable wk");
    expect(meter?.props?.["caption"]).toBe("39%");
    const gauge = findByType(v.root, "gauge").find((g) => g.props?.["label"] === "#2 · Fable wk");
    expect(gauge?.props?.["caption"]).toBe("39%");
  });

  it("scoped window pct >= rateLimitPct gets tone error; below gets tone ok", () => {
    const scopedPool = [
      makeAccount(3, {
        scopedWindows: [
          {
            name: "Fable",
            pct: 85,
            resetsAt: null,
            resetClock: null,
            resetCountdown: null,
            expectedPct: null,
            aheadOfPace: false,
          },
        ],
      }),
      makeAccount(4, {
        scopedWindows: [
          {
            name: "Fable",
            pct: 10,
            resetsAt: null,
            resetClock: null,
            resetCountdown: null,
            expectedPct: null,
            aheadOfPace: false,
          },
        ],
      }),
    ];
    const v = buildUIView(cfgWith80Pct, scopedPool, new Set([3, 4]), emptyState, null, null);
    const meterHigh = findByType(v.root, "meter").find(
      (m) => m.props?.["label"] === "#3 · Fable wk",
    );
    expect(meterHigh?.props?.["tone"]).toBe("error");
    const meterLow = findByType(v.root, "meter").find(
      (m) => m.props?.["label"] === "#4 · Fable wk",
    );
    expect(meterLow?.props?.["tone"]).toBe("ok");

    const gaugeHigh = findByType(v.root, "gauge").find(
      (g) => g.props?.["label"] === "#3 · Fable wk",
    );
    expect(gaugeHigh?.props?.["tone"]).toBe("error");
    const gaugeLow = findByType(v.root, "gauge").find(
      (g) => g.props?.["label"] === "#4 · Fable wk",
    );
    expect(gaugeLow?.props?.["tone"]).toBe("ok");
  });

  it("empty scopedWindows renders identical node tree to before this change (no extra meters/gauges)", () => {
    const v = buildUIView(cfg, [makeAccount(1)], new Set([1]), emptyState, null, null);
    const meters = findByType(v.root, "meter");
    expect(meters.length).toBe(2); // 5h + 7d only
    expect(meters.map((m) => m.props?.["label"])).toEqual(["#1 · 5h", "#1 · 7d"]);
    const gauges = findByType(v.root, "gauge");
    expect(gauges.length).toBe(2);
    expect(gauges.map((g) => g.props?.["label"])).toEqual(["#1 · 5h", "#1 · 7d"]);
  });
});

// ---------------------------------------------------------------------------
// autoHeal config pair + lastHeal section + restoreFailure callout
// ---------------------------------------------------------------------------

describe("buildUIView — heal integration", () => {
  const sampleHeal: HealRecord = {
    at: "2026-06-29T10:00:00.000Z",
    target: 3,
    outcome: "healed",
    restoreFailed: false,
  };

  const sampleRestoreFailure: HealRestoreFailure = {
    at: "2026-06-29T10:01:00.000Z",
    intendedActive: 99,
    landedActive: 2,
  };

  it("config key-value contains autoHeal + autoHealAfterCycles pairs", () => {
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null);
    const kvs = findByType(v.root, "key-value");
    const configKv = kvs[0]!;
    const pairs = configKv.props?.["pairs"] as Array<{ key: string; value: string }>;
    const autoHealPair = pairs.find((p) => p.key === "autoHeal");
    expect(autoHealPair).toBeTruthy();
    expect(autoHealPair?.value).toBe("true");
    const cyclesPair = pairs.find((p) => p.key === "autoHealAfterCycles");
    expect(cyclesPair).toBeTruthy();
    expect(cyclesPair?.value).toBe("2");
  });

  it("lastHeal null → 'No heals yet' text node", () => {
    const v = buildUIView(cfg, pool, ready, baseState, lastSpawn, null, undefined, null, null);
    const texts = findByType(v.root, "text");
    const noHealsText = texts.find((t) => t.props?.["content"] === "No heals yet");
    expect(noHealsText).toBeTruthy();
  });

  it("lastHeal non-null → 'Last heal' header + key-value with target/outcome/at", () => {
    const v = buildUIView(
      cfg,
      pool,
      ready,
      baseState,
      lastSpawn,
      null,
      undefined,
      sampleHeal,
      null,
    );
    const texts = findByType(v.root, "text");
    const header = texts.find(
      (t) => t.props?.["content"] === "Last heal" && t.props?.["weight"] === "bold",
    );
    expect(header).toBeTruthy();

    const kvs = findByType(v.root, "key-value");
    const healKv = kvs.find((kv) => {
      const pairs = kv.props?.["pairs"] as Array<{ key: string; value: string }>;
      return pairs?.some((p) => p.key === "target");
    });
    expect(healKv).toBeTruthy();
    const pairs = healKv?.props?.["pairs"] as Array<{ key: string; value: string }>;
    const keys = pairs.map((p) => p.key);
    expect(keys).toContain("target");
    expect(keys).toContain("outcome");
    expect(keys).toContain("at");
    const targetPair = pairs.find((p) => p.key === "target");
    expect(targetPair?.value).toBe("#3");
  });

  it("restoreFailure null → no restore-failure callout", () => {
    const v = buildUIView(cfg, pool, ready, baseState, null, null, undefined, null, null);
    const callouts = findByType(v.root, "callout");
    const restoreCallout = callouts.find(
      (c) =>
        typeof c.props?.["text"] === "string" &&
        (c.props["text"] as string).includes("auto-heal could not restore"),
    );
    expect(restoreCallout).toBeUndefined();
  });

  it("restoreFailure non-null → error callout mentioning intendedActive and landedActive", () => {
    const v = buildUIView(
      cfg,
      pool,
      ready,
      baseState,
      null,
      null,
      undefined,
      null,
      sampleRestoreFailure,
    );
    const callouts = findByType(v.root, "callout");
    const restoreCallout = callouts.find(
      (c) =>
        typeof c.props?.["text"] === "string" &&
        (c.props["text"] as string).includes("auto-heal could not restore"),
    );
    expect(restoreCallout).toBeTruthy();
    expect(restoreCallout?.props?.["tone"]).toBe("error");
    const text = restoreCallout?.props?.["text"] as string;
    expect(text).toContain("#99");
    expect(text).toContain("2");
  });
});

// ---------------------------------------------------------------------------
// cswap-disabled rows: no button, and the identity label carries the reason.
//
// The status badge cannot carry it — buildStatusBadge short-circuits on
// `active` then `usageUnavailable`, and classifyPool orders non-ok usageStatus
// ahead of the cswap-disabled branch. Those rows would otherwise show no button
// and no hint that `cswap enable <n>` is the lever.
// ---------------------------------------------------------------------------

/** Every identity-badge label in the view (both the flat and graphical sections). */
function identityLabels(root: PluginUINode): string[] {
  return findByType(root, "badge")
    .map((b) => String(b.props?.["label"] ?? ""))
    .filter((l) => l.startsWith("#"));
}

describe("buildUIView — cswap-disabled rows", () => {
  const parked = (over: Partial<PoolAccount> = {}): PoolAccount[] => [
    makeAccount(1, { active: true }),
    makeAccount(2, {
      active: false,
      usable: false,
      reason: "cswap-disabled",
      cswapDisabled: true,
      ...over,
    }),
  ];

  it("renders neither rotation button for a cswap-disabled account", () => {
    const v = buildUIView(cfgRotationOnly, parked(), new Set(), baseState, null, null);
    expect(rotationAccounts(v.root, "Take out of rotation")).toEqual([]);
    expect(rotationAccounts(v.root, "Return to rotation")).toEqual([]);
  });

  it("marks the identity label so the lever is discoverable", () => {
    const v = buildUIView(cfgRotationOnly, parked(), new Set(), baseState, null, null);
    const marked = identityLabels(v.root).filter((l) => l.includes("cswap-disabled"));
    // Both the flat pool row and the graphical section carry it.
    expect(marked.length).toBeGreaterThanOrEqual(1);
    for (const l of marked) expect(l).toContain("#2 acct2@example.com");
  });

  it("marks an ACTIVE cswap-disabled row, whose badge reads 'primary'", () => {
    const v = buildUIView(
      cfgRotationOnly,
      [makeAccount(1, { active: true, cswapDisabled: true })],
      new Set(),
      baseState,
      null,
      null,
    );
    const badges = findByType(v.root, "badge").map((b) => String(b.props?.["label"] ?? ""));
    expect(badges).toContain("primary");
    expect(identityLabels(v.root).some((l) => l.includes("cswap-disabled"))).toBe(true);
  });

  it("marks a quota-unknown cswap-disabled row, whose badge reads its status", () => {
    const v = buildUIView(
      cfgRotationOnly,
      parked({ usageUnavailable: true, fiveHourPct: null, sevenDayPct: null }),
      new Set(),
      baseState,
      null,
      null,
    );
    expect(identityLabels(v.root).some((l) => l.includes("cswap-disabled"))).toBe(true);
  });

  it("leaves an ordinary row's label unmarked", () => {
    const v = buildUIView(
      cfgRotationOnly,
      [makeAccount(1, { active: false })],
      new Set(),
      baseState,
      null,
      null,
    );
    expect(identityLabels(v.root).some((l) => l.includes("cswap-disabled"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 0.23 display fields: spend, pace, usage age, alias/org labels.
// ---------------------------------------------------------------------------

const SPEND: SpendInfo = {
  used: 100.33,
  limit: 100,
  pct: 100,
  currency: "EUR",
  resetClock: null,
  resetCountdown: null,
};

/** Every meter/gauge caption in the view. */
function captions(root: PluginUINode): string[] {
  return [...findByType(root, "meter"), ...findByType(root, "gauge")].map((n) =>
    String(n.props?.["caption"] ?? ""),
  );
}

/** Labels of every meter/gauge in the view. */
function widgetLabels(root: PluginUINode): string[] {
  return [...findByType(root, "meter"), ...findByType(root, "gauge")].map((n) =>
    String(n.props?.["label"] ?? ""),
  );
}

describe("buildUIView — spend", () => {
  it("renders a spend meter and gauge for a small pool", () => {
    const v = buildUIView(
      cfg,
      [makeAccount(1, { spend: SPEND })],
      new Set(),
      baseState,
      null,
      null,
    );
    expect(widgetLabels(v.root).filter((l) => l.includes("· spend")).length).toBe(2);
    expect(captions(v.root).some((c) => c.includes("100.33/100.00 EUR"))).toBe(true);
  });

  it("uses cswap's pct verbatim rather than used/limit", () => {
    // used/limit would read 100.33% — the plugin must never divide.
    const v = buildUIView(
      cfg,
      [makeAccount(1, { spend: SPEND })],
      new Set(),
      baseState,
      null,
      null,
    );
    const spendWidgets = [...findByType(v.root, "meter"), ...findByType(v.root, "gauge")].filter(
      (n) => String(n.props?.["label"]).includes("· spend"),
    );
    expect(spendWidgets.length).toBeGreaterThan(0);
    for (const w of spendWidgets) expect(w.props?.["value"]).toBe(100);
  });

  it("tones a maxed spend budget as error", () => {
    const v = buildUIView(
      cfg,
      [makeAccount(1, { spend: SPEND })],
      new Set(),
      baseState,
      null,
      null,
    );
    const w = [...findByType(v.root, "meter")].find((n) =>
      String(n.props?.["label"]).includes("· spend"),
    );
    expect(w?.props?.["tone"]).toBe("error");
  });

  it("renders nothing at all when the account has no spend plan", () => {
    const v = buildUIView(cfg, [makeAccount(1)], new Set(), baseState, null, null);
    expect(widgetLabels(v.root).some((l) => l.includes("· spend"))).toBe(false);
    // "no plan" is not "unknown" — there must be no n/a placeholder either.
    expect(collectTypes(v.root).join()).not.toContain("spend");
  });

  it("still renders spend on a quota-unknown row — a different, known axis", () => {
    const v = buildUIView(
      cfg,
      [
        makeAccount(1, {
          usageUnavailable: true,
          fiveHourPct: null,
          sevenDayPct: null,
          spend: SPEND,
        }),
      ],
      new Set(),
      baseState,
      null,
      null,
    );
    expect(widgetLabels(v.root).filter((l) => l.includes("· spend")).length).toBe(2);
    expect(
      findByType(v.root, "text").some((t) =>
        String(t.props?.["content"]).includes("quota unknown"),
      ),
    ).toBe(true);
  });

  it("folds spend into the identity label when the pool is too large for widgets", () => {
    // 16 accounts × 4 scoped windows: 16 × (15 + 8) = 368 > RICH_NODE_BUDGET.
    const big = Array.from({ length: 16 }, (_, i) =>
      makeAccount(i + 1, {
        active: false,
        spend: SPEND,
        scopedWindows: ["A", "B", "C", "D"].map((name) => ({
          name,
          pct: 10,
          resetsAt: null,
          resetClock: null,
          resetCountdown: null,
          expectedPct: null,
          aheadOfPace: false,
        })),
      }),
    );
    const v = buildUIView(cfg, big, new Set(), baseState, null, null);
    expect(widgetLabels(v.root).some((l) => l.includes("· spend"))).toBe(false);
    const badges = findByType(v.root, "badge").map((b) => String(b.props?.["label"] ?? ""));
    expect(badges.some((l) => l.includes("spend 100%"))).toBe(true);
  });
});

describe("buildUIView — spend reset suffix", () => {
  // cswap emits spend's reset trio only when the API supplies a reset instant, so the captured
  // sample has none — but all three are consumed through resetSuffix(), in both render paths.
  const WITH_RESET: SpendInfo = {
    used: 12.5,
    limit: 100,
    pct: 12.5,
    currency: "EUR",
    resetClock: "Aug 1 02:00",
    resetCountdown: "7d 4h",
  };

  it("renders the reset suffix on the rich meter and gauge", () => {
    const v = buildUIView(
      cfg,
      [makeAccount(1, { spend: WITH_RESET })],
      new Set(),
      baseState,
      null,
      null,
    );
    const spendCaptions = [...findByType(v.root, "meter"), ...findByType(v.root, "gauge")]
      .filter((n) => String(n.props?.["label"]).includes("· spend"))
      .map((n) => String(n.props?.["caption"]));
    expect(spendCaptions.length).toBe(2);
    for (const c of spendCaptions) expect(c).toContain("resets Aug 1 02:00 (7d 4h)");
  });

  it("renders it in the compact label segment too", () => {
    const big = Array.from({ length: 16 }, (_, i) =>
      makeAccount(i + 1, {
        active: false,
        spend: WITH_RESET,
        scopedWindows: ["A", "B", "C", "D"].map((name) => ({
          name,
          pct: 10,
          resetsAt: null,
          resetClock: null,
          resetCountdown: null,
          expectedPct: null,
          aheadOfPace: false,
        })),
      }),
    );
    const v = buildUIView(cfg, big, new Set(), baseState, null, null);
    const badges = findByType(v.root, "badge").map((b) => String(b.props?.["label"] ?? ""));
    expect(badges.some((l) => l.includes("resets Aug 1 02:00 (7d 4h)"))).toBe(true);
  });

  it("omits the suffix entirely when cswap sends no reset instant", () => {
    const v = buildUIView(
      cfg,
      [makeAccount(1, { spend: SPEND })],
      new Set(),
      baseState,
      null,
      null,
    );
    const caption = [...findByType(v.root, "meter")]
      .filter((n) => String(n.props?.["label"]).includes("· spend"))
      .map((n) => String(n.props?.["caption"]))[0];
    expect(caption).not.toContain("resets");
  });
});

describe("buildUIView — spend percentage is display-rounded", () => {
  // cswap pre-rounds the 5h/7d window pcts but passes spend.pct through from the API verbatim,
  // so it arrives at full float precision — the captured sample carries 1.3727272727272726.
  const RAW: SpendInfo = {
    used: 1.51,
    limit: 110,
    pct: 1.3727272727272726,
    currency: "EUR",
    resetClock: null,
    resetCountdown: null,
  };

  it("rounds in the rich caption", () => {
    const v = buildUIView(cfg, [makeAccount(1, { spend: RAW })], new Set(), baseState, null, null);
    const spendCaptions = [...findByType(v.root, "meter"), ...findByType(v.root, "gauge")]
      .filter((n) => String(n.props?.["label"]).includes("· spend"))
      .map((n) => String(n.props?.["caption"]));
    expect(spendCaptions.length).toBe(2);
    for (const c of spendCaptions) {
      expect(c).toContain("1.4%");
      expect(c).not.toContain("1.3727272727272726");
    }
  });

  it("rounds in the compact label segment", () => {
    // 16 accounts x 4 windows forces the compact path, where pct is interpolated into the badge.
    const big = Array.from({ length: 16 }, (_, i) =>
      makeAccount(i + 1, {
        active: false,
        spend: RAW,
        scopedWindows: ["A", "B", "C", "D"].map((name) => ({
          name,
          pct: 10,
          resetsAt: null,
          resetClock: null,
          resetCountdown: null,
          expectedPct: null,
          aheadOfPace: false,
        })),
      }),
    );
    const v = buildUIView(cfg, big, new Set(), baseState, null, null);
    const badges = findByType(v.root, "badge").map((b) => String(b.props?.["label"] ?? ""));
    expect(badges.some((l) => l.includes("spend 1.4%"))).toBe(true);
    expect(badges.some((l) => l.includes("1.3727272727272726"))).toBe(false);
  });

  it("formats used/limit at currency precision, so no bare float lands beside a rounded pct", () => {
    const longFloat: SpendInfo = { ...RAW, used: 1.3727272727272726, limit: 110 };
    const v = buildUIView(
      cfg,
      [makeAccount(1, { spend: longFloat })],
      new Set(),
      baseState,
      null,
      null,
    );
    const caption = [...findByType(v.root, "meter")]
      .filter((n) => String(n.props?.["label"]).includes("· spend"))
      .map((n) => String(n.props?.["caption"]))[0];
    expect(caption).toContain("1.37/110.00 EUR");
    expect(caption).not.toContain("1.3727272727272726");
  });

  it("keeps a whole percentage clean rather than forcing a decimal", () => {
    const v = buildUIView(
      cfg,
      [makeAccount(1, { spend: SPEND })],
      new Set(),
      baseState,
      null,
      null,
    );
    const caption = [...findByType(v.root, "meter")]
      .filter((n) => String(n.props?.["label"]).includes("· spend"))
      .map((n) => String(n.props?.["caption"]))[0];
    expect(caption).toContain("100%");
  });

  it("tones from the RAW pct, so a near-100 budget is not rounded up into error", () => {
    const nearly: SpendInfo = { ...RAW, pct: 99.96 };
    const v = buildUIView(
      cfg,
      [makeAccount(1, { spend: nearly })],
      new Set(),
      baseState,
      null,
      null,
    );
    const meter = [...findByType(v.root, "meter")].find((n) =>
      String(n.props?.["label"]).includes("· spend"),
    );
    expect(String(meter?.props?.["caption"])).toContain("100%");
    expect(meter?.props?.["tone"]).toBe("ok");
  });
});

describe("buildUIView — pace", () => {
  const ahead = { expectedPct: 36.7, aheadOfPace: true };

  it("annotates an ahead-of-pace 7-day window and lifts its tone to warn", () => {
    const v = buildUIView(
      cfg,
      [makeAccount(1, { sevenDayPct: 94, sevenDayPace: ahead })],
      new Set(),
      baseState,
      null,
      null,
    );
    expect(captions(v.root).some((c) => c.includes("ahead of pace") && c.includes("36.7%"))).toBe(
      true,
    );
    const sevenDay = findByType(v.root, "meter").find((n) =>
      String(n.props?.["label"]).includes("· 7d"),
    );
    expect(sevenDay?.props?.["tone"]).toBe("warn");
  });

  it("does not annotate a window that is on pace", () => {
    const v = buildUIView(
      cfg,
      [makeAccount(1, { sevenDayPct: 50 })],
      new Set(),
      baseState,
      null,
      null,
    );
    expect(captions(v.root).some((c) => c.includes("ahead of pace"))).toBe(false);
  });

  it("keeps error tone when a window is BOTH ahead of pace and at the limit", () => {
    const v = buildUIView(
      cfg,
      [makeAccount(1, { sevenDayPct: 100, sevenDayPace: ahead })],
      new Set(),
      baseState,
      null,
      null,
    );
    const sevenDay = findByType(v.root, "meter").find((n) =>
      String(n.props?.["label"]).includes("· 7d"),
    );
    expect(sevenDay?.props?.["tone"]).toBe("error");
  });

  it("annotates scoped weekly windows too", () => {
    const v = buildUIView(
      cfg,
      [
        makeAccount(1, {
          scopedWindows: [
            {
              name: "Fable",
              pct: 80,
              resetsAt: null,
              resetClock: null,
              resetCountdown: null,
              ...ahead,
            },
          ],
        }),
      ],
      new Set(),
      baseState,
      null,
      null,
    );
    const fable = findByType(v.root, "meter").find((n) =>
      String(n.props?.["label"]).includes("Fable"),
    );
    expect(String(fable?.props?.["caption"])).toContain("ahead of pace");
    expect(fable?.props?.["tone"]).toBe("warn");
  });
});

describe("buildUIView — usage freshness", () => {
  const label = (ageSeconds: number | null): string =>
    findByType(
      buildUIView(
        cfg,
        [makeAccount(1, { usageAgeSeconds: ageSeconds })],
        new Set(),
        baseState,
        null,
        null,
      ).root,
      "badge",
    )
      .map((b) => String(b.props?.["label"] ?? ""))
      .find((l) => l.startsWith("#1")) ?? "";

  it("stays silent below the 300s threshold", () => {
    expect(label(299)).not.toContain("usage");
    expect(label(0)).not.toContain("usage");
  });

  it("stays silent when the age is unknown", () => {
    expect(label(null)).not.toContain("usage");
  });

  it("reports above the threshold, qualified as of the last refresh", () => {
    expect(label(301)).toContain("usage 5m old (at last refresh)");
  });

  it("reports at exactly the threshold — the boundary is inclusive", () => {
    // Pins the README's "5 minutes or older" against the guard's `< STALE_USAGE_S`.
    expect(label(300)).toContain("usage 5m old (at last refresh)");
  });

  it("switches to hours for a long-stale measurement", () => {
    expect(label(2 * 3600)).toContain("usage 2h old (at last refresh)");
  });

  it("does not depend on refreshIntervalMs — that is a different clock", () => {
    // usageAgeSeconds measures how long cswap has served a stale snapshot; refreshIntervalMs is
    // how often we re-read it. Deriving the threshold from cfg could only ever suppress.
    const slow = parseConfig({ refreshIntervalMs: 3_600_000 });
    const v = buildUIView(
      slow,
      [makeAccount(1, { usageAgeSeconds: 600 })],
      new Set(),
      baseState,
      null,
      null,
    );
    const badge = findByType(v.root, "badge")
      .map((b) => String(b.props?.["label"] ?? ""))
      .find((l) => l.startsWith("#1"));
    expect(badge).toContain("usage 10m old");
  });
});

describe("buildUIView — identity labels", () => {
  it("renders an alias alongside the email, never instead of it", () => {
    // The email maps a row to its on-disk profile (sessions/<n>-<slug>/), so it must survive.
    const v = buildUIView(
      cfg,
      [makeAccount(1, { alias: "devbox" })],
      new Set(),
      baseState,
      null,
      null,
    );
    const badge = findByType(v.root, "badge")
      .map((b) => String(b.props?.["label"] ?? ""))
      .find((l) => l.startsWith("#1"));
    expect(badge).toContain("devbox (acct1@example.com)");
  });

  it("appends the organisation, which disambiguates accounts sharing an email", () => {
    const pool2 = [
      makeAccount(1, { active: false, email: "same@example.com", organizationName: "Org A" }),
      makeAccount(2, { active: false, email: "same@example.com", organizationName: "Org B" }),
    ];
    const v = buildUIView(cfg, pool2, new Set(), baseState, null, null);
    const badges = findByType(v.root, "badge").map((b) => String(b.props?.["label"] ?? ""));
    expect(badges.some((l) => l.startsWith("#1") && l.includes("Org A"))).toBe(true);
    expect(badges.some((l) => l.startsWith("#2") && l.includes("Org B"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validator budget — a GRID over accounts × scoped windows, not a hand-picked
// worst case.
//
// The host drops the ENTIRE view if any of four caps is exceeded, and the node
// count is a closed form in BOTH dimensions:
//
//   nodes(N, S) = BASE + Σ over min(N,16) accounts of perAccount(Sᵢ) + (N > 16 ? 1 : 0)
//   perAccount(S) = (rich ? 15 : 13) + (S ≥ 1 ? 2 : 0)
//     S = 1  → one meter (flat) + one gauge (graphics)
//     S ≥ 2  → one table (flat) + one worst-window gauge (graphics)   [issue #56]
//   BASE = 10. Last-spawn and last-heal always emit a node (placeholder when null), so they are
//   already inside it; only the two error callouts vary, giving a worst-case BASE of 12.
//
// The per-account cost is UNIFORM in S — folding makes any account with at least
// one scoped window cost the same +2 — so nothing here can exceed MAX_NODES.
// `S` is externally driven (cswap emits one weekly window per model), so any
// claim pinned at a single S is an overclaim — which is exactly the flaw in the
// shipped 40-account fixture below (it runs at S=0, the cheapest column).
//
// Every assertion in this block is at BASE 10: the grid passes null for both
// error callouts and is swept ONCE. The BASE-12 maximum (253) belongs to the
// ceiling fixture at the end of this block, the only place both callouts are set.
// ---------------------------------------------------------------------------

const MAX_NODES = 256;
const MAX_ARRAY = 500;
const MAX_DEPTH = 16;
const MAX_BYTES = 64 * 1024;

/** A pool of N accounts each carrying S scoped weekly windows, all display fields populated. */
function gridPool(n: number, s: number): PoolAccount[] {
  return Array.from({ length: n }, (_, i) =>
    makeAccount(i + 1, {
      active: false,
      fiveHourPct: 50,
      sevenDayPct: 60,
      alias: `account-alias-${i + 1}`,
      organizationName: `Example Organisation Number ${i + 1}`,
      usageAgeSeconds: 7200,
      spend: SPEND,
      sevenDayPace: { expectedPct: 36.7, aheadOfPace: true },
      scopedWindows: Array.from({ length: s }, (_, j) => ({
        name: `Model${j}`,
        pct: 10,
        resetsAt: null,
        resetClock: "Jul 29 08:59",
        resetCountdown: "4d 10h",
        expectedPct: 36.7,
        aheadOfPace: true,
      })),
    }),
  );
}

/** One heterogeneous pool: account i carries `sList[i]` scoped windows. The SINGLE parametrized
 *  builder for every non-uniform fixture below (mixed S, over-threshold placement, quota-unknown,
 *  long names), so ~8 near-identical hand-rolled pools do not trip `fallow`'s duplicates rule.
 *
 *  `active: false` is load-bearing, exactly as in `gridPool`: `makeAccount` defaults it to true,
 *  which suppresses BOTH action-buttons (`canMakePrimary` needs `!active`; `rotationButtonFor`
 *  returns null for the active account), costing 2 nodes per account and breaking every exact
 *  node-count equality here. */
function poolWith(
  sList: number[],
  opts: {
    window?: (accountIndex: number, j: number) => Partial<ScopedWindow>;
  } & Partial<PoolAccount> = {},
): PoolAccount[] {
  const { window, ...acctOpts } = opts;
  return sList.map((s, i) =>
    makeAccount(i + 1, {
      active: false,
      fiveHourPct: 50,
      sevenDayPct: 60,
      spend: SPEND,
      scopedWindows: Array.from({ length: s }, (_, j) => ({
        name: `Model${j}`,
        pct: 10,
        resetsAt: null,
        resetClock: "Jul 29 08:59",
        resetCountdown: "4d 10h",
        expectedPct: null,
        aheadOfPace: false,
        ...(window ? window(i, j) : {}),
      })),
      ...acctOpts,
    }),
  );
}

/** History filled to its retention caps — that is what populates the charts. */
function fullHistory(pool: PoolAccount[]): History {
  const h = new History();
  for (let i = 0; i < QUOTA_RING_CAP; i++) {
    h.recordQuota(
      pool.slice(0, MAX_DETAILED_ACCOUNTS).map((a) => ({ ...a, fiveHourPct: i % 100 })),
    );
  }
  for (let i = 0; i < SPAWN_RING_CAP; i++) {
    h.recordSpawn({
      sessionId: `session-${i}`,
      accountNumber: (i % MAX_DETAILED_ACCOUNTS) + 1,
      at: new Date(i * 1000).toISOString(),
    });
  }
  return h;
}

describe("buildUIView — four-cap budget grid", () => {
  const ACCOUNTS = [1, 3, 8, 12, 14, 16, 17, 20, 40];
  // S = 12 is past MAX_TABLE_ROWS (8): it is the only column where a folded account emits the
  // truncation row, i.e. 9 rows — the shape the folded byte worst case is measured from. Without it
  // the grid tops out at exactly 8 rows and never exercises the row cap at pool scale.
  const WINDOWS = [0, 1, 2, 3, 4, 6, 8, 12];

  /** Predicted node count; the closed form the rich/compact switch is derived from.
   *  The scoped-window term is UNIFORM: +2 for any account with at least one window, whether that
   *  is a meter+gauge pair (S = 1) or a table+worst-window-gauge pair (S >= 2). */
  const BASE_NODES = 10; // no error callouts present; each of the two would add one
  const predict = (n: number, s: number, rich: boolean): number =>
    BASE_NODES +
    Math.min(n, MAX_DETAILED_ACCOUNTS) * ((rich ? 15 : 13) + (s >= 1 ? 2 : 0)) +
    (n > MAX_DETAILED_ACCOUNTS ? 1 : 0);

  it("node count matches the closed form for every combination", () => {
    for (const n of ACCOUNTS) {
      for (const s of WINDOWS) {
        const pool = gridPool(n, s);
        const v = buildUIView(cfg, pool, new Set(), baseState, null, null, fullHistory(pool));
        const isRich = widgetLabels(v.root).some((l) => l.includes("· spend"));
        expect({ n, s, nodes: treeStats(v.root).nodeCount }).toEqual({
          n,
          s,
          nodes: predict(n, s, isRich),
        });
      }
    }
  });

  it("EVERY combination stays inside all four caps", () => {
    // Was gated on `if (!rich) continue`, which skipped the compact path entirely — and hid that
    // 16 x 8 exceeded MAX_BYTES on the pre-fold builder. Every combination is checked now.
    for (const n of ACCOUNTS) {
      for (const s of WINDOWS) {
        const pool = gridPool(n, s);
        const v = buildUIView(cfg, pool, new Set(), baseState, null, null, fullHistory(pool));
        const stats = treeStats(v.root);
        expect({ n, s, over: stats.nodeCount > MAX_NODES }).toEqual({ n, s, over: false });
        expect(stats.maxArrayLen).toBeLessThanOrEqual(MAX_ARRAY);
        expect(stats.depth).toBeLessThanOrEqual(MAX_DEPTH);
        expect(Buffer.byteLength(JSON.stringify(v), "utf8")).toBeLessThanOrEqual(MAX_BYTES);
      }
    }
  });

  it("no combination is over cap — the list a regression would re-populate", () => {
    // Was pinned to the pre-existing >=2-scoped-window overflow set with a "tracked as a follow-up"
    // comment. That overflow is fixed (issue #56): folding makes the per-account cost uniform in S,
    // so the list is empty and any regression re-populates it.
    const over: string[] = [];
    for (const n of ACCOUNTS) {
      for (const s of WINDOWS) {
        const pool = gridPool(n, s);
        const v = buildUIView(cfg, pool, new Set(), baseState, null, null, fullHistory(pool));
        if (treeStats(v.root).nodeCount > MAX_NODES) over.push(`${n}x${s}`);
      }
    }
    expect(over).toEqual([]);
  });

  it("grid maxima are exactly 251 overall and 251 on the folded path (BASE 10)", () => {
    // Sampled GRID maxima, not global bounds: the construction maximum (253 at BASE 12) is pinned
    // by the ceiling fixture below. Folded and overall coincide because the worst-window gauge
    // makes a folded account cost the same 15 as any other.
    let max = 0;
    let foldedMax = 0;
    for (const n of ACCOUNTS) {
      for (const s of WINDOWS) {
        const pool = gridPool(n, s);
        const nodes = treeStats(
          buildUIView(cfg, pool, new Set(), baseState, null, null, fullHistory(pool)).root,
        ).nodeCount;
        max = Math.max(max, nodes);
        if (s >= 2) foldedMax = Math.max(foldedMax, nodes);
      }
    }
    expect({ max, foldedMax }).toEqual({ max: 251, foldedMax: 251 });
  });

  it("the rich branch's own maximum is bounded by RICH_NODE_BUDGET, not by the account cap", () => {
    // The MAX_NODES proof leans on the shipped spend switch: a rich account costs up to 17, which
    // at 16 accounts would be 272. These two corners are where that gate actually binds, so a
    // budget bump admitting a 15th rich account fails here rather than silently re-opening the cap.
    const richNodes = (n: number, s: number) =>
      treeStats(
        buildUIView(
          cfg,
          gridPool(n, s),
          new Set(),
          baseState,
          null,
          null,
          fullHistory(gridPool(n, s)),
        ).root,
      ).nodeCount;
    expect(richNodes(14, 0)).toBe(220); // sigma 210, the rich branch's true maximum
    expect(richNodes(12, 1)).toBe(214); // sigma 204, its maximum with scoped windows present
  });

  it("folded byte corner: 16 accounts x 12 windows (9 rows each) stays under MAX_BYTES", () => {
    // The row cap bounds bytes, and this is the shape it is measured from: 16 rendered accounts
    // each emitting 8 window rows + the truncation row, plus 16 worst-window gauges. Asserted as a
    // BOUND with headroom, not an equality — byte counts shift with any label or format tweak.
    const pool = gridPool(16, 12);
    const v = buildUIView(cfg, pool, new Set(), baseState, null, "boom", fullHistory(pool));
    const bytes = Buffer.byteLength(JSON.stringify(v), "utf8");
    expect(bytes).toBeLessThanOrEqual(MAX_BYTES);
    expect(bytes).toBeLessThan(60_000); // measured ~54 000 B (83% of MAX_BYTES)
    expect(treeStats(v.root).maxArrayLen).toBeLessThanOrEqual(MAX_ARRAY);
  });

  it("construction ceiling: 17 accounts x S=1 with BOTH error callouts is exactly 253 nodes", () => {
    // The construction maximum, and the ONLY place both callouts are set (BASE 12 = 10 + 2).
    // Every S >= 1 is equally the corner — with the worst-window gauge any account carrying at
    // least one scoped window costs the same +2 — so S = 0 is the cheap column and S = 1 is chosen
    // here only because it is the smallest such shape. The 17th account is what adds the
    // "+N more accounts" node; see the 16-account variant below for the same shape without it.
    const pool = gridPool(17, 1);
    const v = buildUIView(cfg, pool, new Set(), baseState, null, "boom", fullHistory(pool), null, {
      at: "2026-07-25T10:00:00.000Z",
      intendedActive: 1,
      landedActive: 2,
    });
    const stats = treeStats(v.root);
    expect(stats.nodeCount).toBe(253);
    expect(stats.nodeCount).toBeLessThanOrEqual(MAX_NODES);
    expect(stats.maxArrayLen).toBeLessThanOrEqual(MAX_ARRAY);
    expect(stats.depth).toBeLessThanOrEqual(MAX_DEPTH);
    expect(Buffer.byteLength(JSON.stringify(v), "utf8")).toBeLessThanOrEqual(MAX_BYTES);
  });

  it("a 16-account pool of the same shape is 252 — no '+N more accounts' node", () => {
    // Separate fixture, NOT the 17-account pool truncated: at N = 16 nothing is collapsed, so the
    // truncation node is absent and the count is one lower.
    const pool = gridPool(16, 1);
    const v = buildUIView(cfg, pool, new Set(), baseState, null, "boom", fullHistory(pool), null, {
      at: "2026-07-25T10:00:00.000Z",
      intendedActive: 1,
      landedActive: 2,
    });
    expect(treeStats(v.root).nodeCount).toBe(252);
  });

  it("rich boundary (8 accounts, 4 windows) stays inside all four caps", () => {
    const pool = gridPool(8, 4);
    const v = buildUIView(cfg, pool, new Set(), baseState, null, "boom", fullHistory(pool));
    expect(widgetLabels(v.root).some((l) => l.includes("· spend"))).toBe(true);
    const stats = treeStats(v.root);
    expect(stats.nodeCount).toBeLessThanOrEqual(MAX_NODES);
    expect(stats.maxArrayLen).toBeLessThanOrEqual(MAX_ARRAY);
    expect(stats.depth).toBeLessThanOrEqual(MAX_DEPTH);
    expect(Buffer.byteLength(JSON.stringify(v), "utf8")).toBeLessThanOrEqual(MAX_BYTES);
  });
});

// ---------------------------------------------------------------------------
// Folded scoped-window rendering (issue #56)
//
// From two scoped windows up, an account's per-model windows collapse into ONE
// table in the flat pool section plus ONE worst-window gauge in the graphics
// section. Both rank by the same `worstFirst` key (tone severity, then pct,
// then cswap order), which is what guarantees the gauged window always has a
// row explaining it.
// ---------------------------------------------------------------------------

/** The scoped-window table of the first account that has one. */
function scopedTable(root: PluginUINode): PluginUINode | undefined {
  return findByType(root, "table").find((t) =>
    (t.props?.["columns"] as string[] | undefined)?.includes("model"),
  );
}

/** Rows of the scoped-window table, as raw cell arrays. */
function scopedRows(root: PluginUINode): string[][] {
  return (scopedTable(root)?.props?.["rows"] as string[][] | undefined) ?? [];
}

/** Scoped meters/gauges — everything except the 5h/7d/spend/trend widgets. */
function scopedWidgets(root: PluginUINode): PluginUINode[] {
  return [...findByType(root, "meter"), ...findByType(root, "gauge")].filter((n) =>
    String(n.props?.["label"] ?? "").includes(" wk"),
  );
}

describe("buildUIView — folded scoped windows", () => {
  const win = (over: Partial<ScopedWindow>): Partial<ScopedWindow> => over;

  it("one window renders a meter and a gauge, and no table", () => {
    const v = buildUIView(cfg, poolWith([1]), new Set(), baseState, null, null);
    expect(scopedTable(v.root)).toBeUndefined();
    expect(
      scopedWidgets(v.root)
        .map((n) => n.type)
        .sort(),
    ).toEqual(["gauge", "meter"]);
  });

  it("two windows fold: one table in the flat section, one gauge in the graphics section", () => {
    const v = buildUIView(cfg, poolWith([2]), new Set(), baseState, null, null);
    expect(findByType(v.root, "table").length).toBe(1);
    const widgets = scopedWidgets(v.root);
    expect(widgets.map((n) => n.type)).toEqual(["gauge"]); // no scoped meter survives the fold
    expect(scopedRows(v.root).length).toBe(2);
  });

  it("a quota-unknown account emits neither scoped widgets nor a table", () => {
    const v = buildUIView(
      cfg,
      poolWith([4], { usageUnavailable: true, fiveHourPct: null, sevenDayPct: null, spend: null }),
      new Set(),
      baseState,
      null,
      null,
    );
    expect(scopedTable(v.root)).toBeUndefined();
    expect(scopedWidgets(v.root)).toEqual([]);
  });

  it("cells: pct, reset instant, composed note, and empty cells where nothing applies", () => {
    const pool = poolWith([3], {
      window: (_, j) =>
        [
          // pace-only (60 < 80), both conditions (96 >= 80), and neither.
          win({ name: "Fable", pct: 60, expectedPct: 45, aheadOfPace: true }),
          win({ name: "Opus", pct: 96, expectedPct: 60, aheadOfPace: true }),
          win({ name: "Haiku", pct: 4, resetClock: null, resetCountdown: null }),
        ][j]!,
    });
    // cfgWith80Pct, not the default 100, so 96% is genuinely at/over the threshold.
    const rows = scopedRows(buildUIView(cfgWith80Pct, pool, new Set(), baseState, null, null).root);
    expect(rows).toEqual([
      ["#1 · Fable wk", "60%", "Jul 29 08:59 (4d 10h)", "ahead of pace (expected 45%)"],
      [
        "#1 · Opus wk",
        "96%",
        "Jul 29 08:59 (4d 10h)",
        "at/over rateLimitPct · ahead of pace (expected 60%)",
      ],
      // null clock ⇒ EMPTY resets cell (no "null", no placeholder); nothing applies ⇒ empty note
      ["#1 · Haiku wk", "4%", "", ""],
    ]);
  });

  it("a clock with no countdown renders the clock alone, without empty parens", () => {
    const pool = poolWith([2], { window: () => win({ resetCountdown: null }) });
    const rows = scopedRows(buildUIView(cfg, pool, new Set(), baseState, null, null).root);
    expect(rows[0]?.[2]).toBe("Jul 29 08:59");
  });
});

describe("buildUIView — worst-window gauge", () => {
  /** The single scoped gauge of a folded account. */
  const gauge = (pool: PoolAccount[], config: ResolvedConfig = cfg): PluginUINode | undefined =>
    scopedWidgets(buildUIView(config, pool, new Set(), baseState, null, null).root).find(
      (n) => n.type === "gauge",
    );

  it("selects the at/over-rateLimitPct window and tones it error", () => {
    const pool = poolWith([3], {
      window: (_, j) =>
        [
          { name: "A", pct: 50 },
          { name: "B", pct: 95 },
          { name: "C", pct: 60 },
        ][j]!,
    });
    const g = gauge(pool, cfgWith80Pct); // 95% is over an 80% threshold, not over the default 100%
    expect(g?.props?.["label"]).toBe("#1 · B wk");
    expect(g?.props?.["tone"]).toBe("error");
  });

  it("prefers a LOWER-pct ahead-of-pace window over a higher-pct ok one, and tones it warn", () => {
    // The case a max-pct rule would lose: the amber signal has no other carrier in the panel,
    // since scoped-window severity never reaches the status badge.
    const pool = poolWith([3], {
      window: (_, j) =>
        [
          { name: "A", pct: 80 },
          { name: "B", pct: 40, expectedPct: 20, aheadOfPace: true },
          { name: "C", pct: 85 },
        ][j]!,
    });
    const g = gauge(pool);
    expect(g?.props?.["label"]).toBe("#1 · B wk");
    expect(g?.props?.["tone"]).toBe("warn");
  });

  it("falls back to the highest pct when every window is ok", () => {
    const pool = poolWith([3], {
      window: (_, j) =>
        [
          { name: "A", pct: 10 },
          { name: "B", pct: 70 },
          { name: "C", pct: 30 },
        ][j]!,
    });
    expect(gauge(pool)?.props?.["label"]).toBe("#1 · B wk");
    expect(gauge(pool)?.props?.["tone"]).toBe("ok");
  });

  it("breaks a severity+pct tie by cswap emission order", () => {
    const pool = poolWith([3], {
      window: (_, j) =>
        [
          { name: "A", pct: 70 },
          { name: "B", pct: 70 },
          { name: "C", pct: 70 },
        ][j]!,
    });
    expect(gauge(pool)?.props?.["label"]).toBe("#1 · A wk");
  });
});

describe("buildUIView — row cap and truncation ordering", () => {
  // The DEFAULT rateLimitPct is 100, so threshold cases run against cfgWith80Pct and use pcts
  // that genuinely clear 80.
  const OVER = 95;
  /** Labels in the table's `model` column. */
  const models = (root: PluginUINode): string[] => scopedRows(root).map((r) => r[0]!);
  const gaugeLabel = (root: PluginUINode): string =>
    String(scopedWidgets(root).find((n) => n.type === "gauge")?.props?.["label"] ?? "");

  it("renders 8 window rows plus a full-width truncation row", () => {
    const v = buildUIView(cfg, poolWith([24]), new Set(), baseState, null, null);
    const rows = scopedRows(v.root);
    expect(rows.length).toBe(9);
    expect(rows[8]).toEqual(["+16 more windows", "", "", ""]);
    // Every row matches the column count — a short row renders short in PuiTable.
    const columns = scopedTable(v.root)?.props?.["columns"] as string[];
    for (const row of rows) expect(row.length).toBe(columns.length);
  });

  it("retains an at/over-threshold window that sits LAST in cswap order", () => {
    const pool = poolWith([12], { window: (_, j) => (j === 11 ? { pct: OVER } : { pct: 10 }) });
    const v = buildUIView(cfgWith80Pct, pool, new Set(), baseState, null, null);
    expect(models(v.root)).toContain("#1 · Model11 wk");
    expect(models(v.root)).toContain(gaugeLabel(v.root)); // gauge always has a row
  });

  it("retains an AHEAD-OF-PACE window that sits last, and gauges it warn", () => {
    // The tier a threshold-only partition would drop: 8 sub-threshold `ok` windows come first in
    // cswap order, so a positional slice truncates the sole `warn` window away — leaving amber with
    // no row, or no amber at all.
    const pool = poolWith([12], {
      window: (_, j) => (j === 11 ? { pct: 40, expectedPct: 20, aheadOfPace: true } : { pct: 10 }),
    });
    const v = buildUIView(cfg, pool, new Set(), baseState, null, null);
    expect(models(v.root)).toContain("#1 · Model11 wk");
    expect(gaugeLabel(v.root)).toBe("#1 · Model11 wk");
    expect(scopedWidgets(v.root)[0]?.props?.["tone"]).toBe("warn");
    expect(models(v.root)).toContain(gaugeLabel(v.root));
  });

  it("with more than 8 over-threshold windows, keeps the highest-pct one even if it is last", () => {
    // Within-tier ordering: a cswap-order-only partition would truncate away the very window the
    // gauge selects.
    const pool = poolWith([12], {
      window: (_, j) => ({ pct: j === 11 ? 99 : OVER }),
    });
    const v = buildUIView(cfgWith80Pct, pool, new Set(), baseState, null, null);
    expect(models(v.root)).toContain("#1 · Model11 wk");
    expect(gaugeLabel(v.root)).toBe("#1 · Model11 wk");
    expect(models(v.root)).toContain(gaugeLabel(v.root));
    for (const row of scopedRows(v.root).slice(0, 8)) {
      expect(row[3]).toContain("at/over rateLimitPct");
    }
  });

  it("displays retained rows in cswap emission order, not worst-first", () => {
    // 10 windows, only the LAST over threshold. Retention ranks it first and keeps 7 of the `ok`
    // ones (Model7/Model8 are dropped), but display order is cswap order — so Model9 reads last,
    // not first. Asserted as the exact sequence: a self-sort comparison would pass even if the
    // ordering were broken.
    const pool = poolWith([10], { window: (_, j) => (j === 9 ? { pct: OVER } : { pct: 10 }) });
    const v = buildUIView(cfgWith80Pct, pool, new Set(), baseState, null, null);
    expect(models(v.root)).toEqual([
      "#1 · Model0 wk",
      "#1 · Model1 wk",
      "#1 · Model2 wk",
      "#1 · Model3 wk",
      "#1 · Model4 wk",
      "#1 · Model5 wk",
      "#1 · Model6 wk",
      "#1 · Model9 wk",
      "+2 more windows",
    ]);
  });

  it("a 32-character model name still fits inside MAX_BYTES at pool scale", () => {
    const long = "x".repeat(32);
    const pool = poolWith(
      Array.from({ length: 16 }, () => 12),
      {
        window: (_, j) => ({ name: `${long}${j}` }),
      },
    );
    const v = buildUIView(cfg, pool, new Set(), baseState, null, "boom", fullHistory(pool));
    expect(Buffer.byteLength(JSON.stringify(v), "utf8")).toBeLessThanOrEqual(MAX_BYTES);
  });
});

describe("buildUIView — heterogeneous pool", () => {
  it("0, 1 and 4 windows in one pool each render their own way", () => {
    const pool = poolWith([0, 1, 4]);
    const v = buildUIView(cfg, pool, new Set(), baseState, null, null);
    const labelled = (n: number) =>
      scopedWidgets(v.root).filter((w) => String(w.props?.["label"]).startsWith(`#${n} `));
    expect(labelled(1)).toEqual([]); // S = 0 — nothing at all
    expect(
      labelled(2)
        .map((w) => w.type)
        .sort(),
    ).toEqual(["gauge", "meter"]); // S = 1 — both kept
    expect(labelled(3).map((w) => w.type)).toEqual(["gauge"]); // S = 4 — folded to one gauge
    expect(findByType(v.root, "table").length).toBe(1); // only the S = 4 account has a table
    // Uniform closed form: BASE 10 + 15 (S=0) + 17 (S=1) + 17 (S=4), all rich.
    expect(treeStats(v.root).nodeCount).toBe(10 + 15 + 17 + 17);
  });
});

describe("weeklyCaption — byte-identical after the paceNote/resetInstant extractions", () => {
  // The shipped caption assertions are `includes`-based and cannot detect a rewording, so pin both
  // forms exactly through the rendered tree.
  const sevenDayCaption = (
    pace: { expectedPct: number | null; aheadOfPace: boolean },
    reset: boolean,
  ) => {
    const v = buildUIView(
      cfg,
      [
        makeAccount(1, {
          sevenDayPct: 60,
          sevenDayPace: pace,
          sevenDayResetClock: reset ? "Jul 29 08:59" : null,
          sevenDayResetCountdown: reset ? "4d 10h" : null,
        }),
      ],
      new Set(),
      baseState,
      null,
      null,
    );
    return captions(v.root).find((c) => c.startsWith("60%"));
  };

  it("renders the expected-pct form exactly", () => {
    expect(sevenDayCaption({ expectedPct: 36.7, aheadOfPace: true }, true)).toBe(
      "60% · resets Jul 29 08:59 (4d 10h) · ahead of pace (expected 36.7%)",
    );
  });

  it("renders the bare ahead-of-pace form exactly when expectedPct is null", () => {
    expect(sevenDayCaption({ expectedPct: null, aheadOfPace: true }, false)).toBe(
      "60% · ahead of pace",
    );
  });
});
