import { describe, expect, it } from "bun:test";
import { History, downsample, QUOTA_RING_CAP, SPAWN_RING_CAP } from "../src/history";
import type { PoolAccount } from "../src/accounts";

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
    cswapDisabled: false,
    scopedWindows: [],
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// Quota ring
// ---------------------------------------------------------------------------

describe("History — quota ring trims at cap", () => {
  it("ring length stays at QUOTA_RING_CAP after exceeding it", () => {
    const h = new History();
    const acct = makeAccount(1);
    for (let i = 0; i <= QUOTA_RING_CAP; i++) {
      h.recordQuota([{ ...acct, fiveHourPct: i, sevenDayPct: i }]);
    }
    expect(h.quotaFor(1)).toHaveLength(QUOTA_RING_CAP);
  });

  it("newest samples are retained (oldest evicted, FIFO)", () => {
    const h = new History();
    const acct = makeAccount(1);
    const total = QUOTA_RING_CAP + 5;
    for (let i = 0; i < total; i++) {
      h.recordQuota([{ ...acct, fiveHourPct: i, sevenDayPct: i }]);
    }
    const ring = h.quotaFor(1);
    // oldest entry should be the (total - QUOTA_RING_CAP)-th sample (index 5)
    expect(ring[0]!.five).toBe(5);
    // newest entry should be the last one pushed
    expect(ring[ring.length - 1]!.five).toBe(total - 1);
  });
});

describe("History — per-account isolation", () => {
  it("recordQuota for acct 1 does not affect acct 2's ring", () => {
    const h = new History();
    h.recordQuota([makeAccount(1, { fiveHourPct: 50 })]);
    expect(h.quotaFor(2)).toHaveLength(0);
  });

  it("quotaFor returns correct account data when pool has multiple accounts", () => {
    const h = new History();
    h.recordQuota([makeAccount(1, { fiveHourPct: 11 }), makeAccount(2, { fiveHourPct: 22 })]);
    expect(h.quotaFor(1)[0]!.five).toBe(11);
    expect(h.quotaFor(2)[0]!.five).toBe(22);
  });
});

describe("History — null pass-through", () => {
  it("null fiveHourPct/sevenDayPct stored as null (not coerced to 0)", () => {
    const h = new History();
    h.recordQuota([makeAccount(1, { fiveHourPct: null, sevenDayPct: null })]);
    const sample = h.quotaFor(1)[0]!;
    expect(sample.five).toBeNull();
    expect(sample.seven).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Spawn ring
// ---------------------------------------------------------------------------

describe("History — spawn ring FIFO eviction", () => {
  it("ring length stays at SPAWN_RING_CAP after exceeding it", () => {
    const h = new History();
    for (let i = 0; i < SPAWN_RING_CAP + 5; i++) {
      h.recordSpawn({ sessionId: `s${i}`, accountNumber: 1, at: "2026-01-01T00:00:00.000Z" });
    }
    expect(h.recentSpawns()).toHaveLength(SPAWN_RING_CAP);
  });

  it("newest spawns are retained (oldest evicted)", () => {
    const h = new History();
    const total = SPAWN_RING_CAP + 3;
    for (let i = 0; i < total; i++) {
      h.recordSpawn({ sessionId: `s${i}`, accountNumber: 1, at: "2026-01-01T00:00:00.000Z" });
    }
    const ring = h.recentSpawns();
    // oldest retained should be index 3 (first 3 evicted)
    expect(ring[0]!.sessionId).toBe("s3");
    // newest should be last pushed
    expect(ring[ring.length - 1]!.sessionId).toBe(`s${total - 1}`);
  });
});

describe("History — caller-supplied timestamps used verbatim", () => {
  it("at field is stored exactly as supplied, no internal Date used", () => {
    const h = new History();
    const ts = "2026-06-28T00:00:00.000Z";
    h.recordSpawn({ sessionId: "abc", accountNumber: 2, at: ts });
    expect(h.recentSpawns()[0]!.at).toBe(ts);
  });

  it("multiple spawns retain their individual timestamps", () => {
    const h = new History();
    h.recordSpawn({ sessionId: "x1", accountNumber: 1, at: "2026-01-01T00:00:00.000Z" });
    h.recordSpawn({ sessionId: "x2", accountNumber: 2, at: "2026-06-15T12:00:00.000Z" });
    const ring = h.recentSpawns();
    expect(ring[0]!.at).toBe("2026-01-01T00:00:00.000Z");
    expect(ring[1]!.at).toBe("2026-06-15T12:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// downsample
// ---------------------------------------------------------------------------

describe("downsample", () => {
  it("(a) length ≤ window returns same points (or copy)", () => {
    const pts = [1, 2, 3];
    const result = downsample(pts, 5);
    expect(result).toEqual([1, 2, 3]);
  });

  it("(a) length === window returns same points", () => {
    const pts = [10, 20, 30];
    const result = downsample(pts, 3);
    expect(result).toEqual([10, 20, 30]);
  });

  it("(b) length > window returns ≤ window points", () => {
    const pts = Array.from({ length: 100 }, (_, i) => i);
    const result = downsample(pts, 10);
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it("(c) newest (last) point is always retained", () => {
    const pts = Array.from({ length: 100 }, (_, i) => i);
    const result = downsample(pts, 10);
    expect(result[result.length - 1]).toBe(99);
  });

  it("(d) chronological order preserved (result is non-decreasing for ascending input)", () => {
    const pts = Array.from({ length: 100 }, (_, i) => i);
    const result = downsample(pts, 10);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!).toBeGreaterThanOrEqual(result[i - 1]!);
    }
  });

  it("(e) first input point appears as first output point (full range anchoring)", () => {
    const pts = Array.from({ length: 100 }, (_, i) => i);
    const result = downsample(pts, 10);
    expect(result[0]).toBe(0);
  });

  it("window=1 returns only the last point", () => {
    const pts = [5, 10, 15, 20];
    const result = downsample(pts, 1);
    expect(result).toEqual([20]);
  });

  it("empty array returns empty array", () => {
    expect(downsample([], 10)).toEqual([]);
  });
});
