import { describe, expect, it } from "bun:test";
import { buildUIView } from "../src/ui-view";
import type { PluginUINode } from "../types";
import type { PoolAccount } from "../src/accounts";
import type { SelectionState } from "../src/selection";
import type { LastSpawn } from "../src/status";
import type { HealRecord, HealRestoreFailure } from "../src/prewarm";
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

const cfgButtonsOff = parseConfig({ makePrimaryButtons: false });

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
  }), // quota-unknown but usable — INTENTIONALLY eligible
];
const pickerReady = new Set([2]);

describe("buildUIView — Make primary picker", () => {
  it("emits an action-button only for eligible non-primary accounts (usable, not rate-limited)", () => {
    const v = buildUIView(cfg, pickerPool, pickerReady, baseState, null, null);
    const buttons = findByType(v.root, "action-button");
    const accounts = buttons.map((b) => (b.props?.["body"] as { account: number }).account).sort();
    // #2 (ready) and #5 (quota-unknown but usable) are eligible; #1 active, #3 rate-limited, #4 unusable.
    expect(accounts).toEqual([2, 5]);
  });

  it("a quota-unknown but usable account is eligible (reporting gap, not unusability)", () => {
    const v = buildUIView(cfg, pickerPool, pickerReady, baseState, null, null);
    const accounts = findByType(v.root, "action-button").map(
      (b) => (b.props?.["body"] as { account: number }).account,
    );
    expect(accounts).toContain(5);
  });

  it("never emits a button for the active (primary), rate-limited, or unusable account", () => {
    const v = buildUIView(cfg, pickerPool, pickerReady, baseState, null, null);
    const accounts = findByType(v.root, "action-button").map(
      (b) => (b.props?.["body"] as { account: number }).account,
    );
    expect(accounts).not.toContain(1);
    expect(accounts).not.toContain(3);
    expect(accounts).not.toContain(4);
  });

  it("button carries the correct shape: POST switch-primary, specific mode, confirm, neutral tone", () => {
    const v = buildUIView(cfg, pickerPool, pickerReady, baseState, null, null);
    const button = findByType(v.root, "action-button").find(
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
    const v = buildUIView(cfg, pickerPool, pickerReady, baseState, null, null);
    for (const b of findByType(v.root, "action-button")) {
      const path = (b.props?.["route"] as { path: string }).path;
      expect(path.startsWith("/")).toBe(false);
      expect(path).toBe("switch-primary");
    }
  });

  it("emits no action-button anywhere when makePrimaryButtons is false (pre-#1209 escape hatch)", () => {
    const v = buildUIView(cfgButtonsOff, pickerPool, pickerReady, baseState, null, null);
    expect(findByType(v.root, "action-button").length).toBe(0);
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
            resetsAt: "2026-07-08T08:59:00.000Z",
            resetClock: "Jul 8 08:59",
            resetCountdown: "3d 22h",
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
          { name: "Fable", pct: 39, resetsAt: null, resetClock: null, resetCountdown: null },
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
          { name: "Fable", pct: 85, resetsAt: null, resetClock: null, resetCountdown: null },
        ],
      }),
      makeAccount(4, {
        scopedWindows: [
          { name: "Fable", pct: 10, resetsAt: null, resetClock: null, resetCountdown: null },
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
