import { describe, expect, it } from "bun:test";
import { assign } from "../src/selection";
import type { SelectionState } from "../src/selection";
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
    sevenDayPct: 10,
    fiveHourResetsAt: null,
    sevenDayResetsAt: null,
    fiveHourResetClock: null,
    sevenDayResetClock: null,
    fiveHourResetCountdown: null,
    sevenDayResetCountdown: null,
    active: true,
    usageUnavailable: false,
    ...opts,
  };
}

const emptyState: SelectionState = { cursor: 0, assignments: {} };

// ---------------------------------------------------------------------------
// New session — abort cases
// ---------------------------------------------------------------------------

describe("assign — new session — abort when no eligible", () => {
  it("empty pool → abort", () => {
    const result = assign(emptyState, "s1", [], new Set(), "round-robin", new Set<number>());
    expect(result.kind).toBe("abort");
    if (result.kind === "abort") {
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.nextState).toBe(emptyState); // state unchanged
    }
  });

  it("pool has accounts but none are ready → abort", () => {
    const pool = [makeAccount(1), makeAccount(2)];
    const result = assign(emptyState, "s1", pool, new Set(), "round-robin", new Set<number>());
    expect(result.kind).toBe("abort");
    if (result.kind === "abort") {
      expect(result.nextState).toBe(emptyState);
    }
  });

  it("all accounts not usable → abort", () => {
    const pool = [
      makeAccount(1, { usable: false, reason: "api_key" }),
      makeAccount(2, { usable: false, reason: "token_expired" }),
    ];
    const result = assign(
      emptyState,
      "s1",
      pool,
      new Set([1, 2]),
      "round-robin",
      new Set<number>(),
    );
    expect(result.kind).toBe("abort");
  });

  it("all accounts rate-limited → abort", () => {
    const pool = [makeAccount(1, { rateLimited: true }), makeAccount(2, { rateLimited: true })];
    const result = assign(
      emptyState,
      "s1",
      pool,
      new Set([1, 2]),
      "round-robin",
      new Set<number>(),
    );
    expect(result.kind).toBe("abort");
  });

  it("unusable + rate-limited mix → abort", () => {
    const pool = [
      makeAccount(1, { usable: false, reason: "api_key" }),
      makeAccount(2, { rateLimited: true }),
    ];
    const result = assign(
      emptyState,
      "s1",
      pool,
      new Set([1, 2]),
      "round-robin",
      new Set<number>(),
    );
    expect(result.kind).toBe("abort");
  });
});

// ---------------------------------------------------------------------------
// New session — assigned cases
// ---------------------------------------------------------------------------

describe("assign — new session — assigned", () => {
  it("single eligible account → assigned with that account", () => {
    const pool = [makeAccount(1)];
    const result = assign(emptyState, "s1", pool, new Set([1]), "round-robin", new Set<number>());
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") {
      expect(result.accountNumber).toBe(1);
    }
  });

  it("assigned: nextState has sessionId pinned", () => {
    const pool = [makeAccount(1)];
    const result = assign(emptyState, "s1", pool, new Set([1]), "round-robin", new Set<number>());
    expect(result.kind).toBe("assigned");
    expect(result.nextState.assignments["s1"]).toBe(1);
  });

  it("assigned: cursor advances by 1", () => {
    const pool = [makeAccount(1)];
    const result = assign(emptyState, "s1", pool, new Set([1]), "round-robin", new Set<number>());
    expect(result.nextState.cursor).toBe(1);
  });

  it("skips non-ready accounts in round-robin", () => {
    // acct 1 is ready; acct 2 is not ready
    const pool = [makeAccount(1), makeAccount(2)];
    const result = assign(emptyState, "s1", pool, new Set([1]), "round-robin", new Set<number>());
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") {
      expect(result.accountNumber).toBe(1);
    }
  });

  it("skips non-usable accounts in round-robin", () => {
    const pool = [makeAccount(1, { usable: false, reason: "api_key" }), makeAccount(2)];
    const result = assign(
      emptyState,
      "s1",
      pool,
      new Set([1, 2]),
      "round-robin",
      new Set<number>(),
    );
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") {
      expect(result.accountNumber).toBe(2);
    }
  });

  it("skips rate-limited accounts in round-robin", () => {
    const pool = [makeAccount(1, { rateLimited: true }), makeAccount(2)];
    const result = assign(
      emptyState,
      "s1",
      pool,
      new Set([1, 2]),
      "round-robin",
      new Set<number>(),
    );
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") {
      expect(result.accountNumber).toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------
// New session — round-robin spread
// ---------------------------------------------------------------------------

describe("assign — new session — round-robin spread", () => {
  it("two eligible accounts: alternate on successive new sessions", () => {
    const pool = [makeAccount(1), makeAccount(2)];
    const ready = new Set([1, 2]);

    const r1 = assign(emptyState, "s1", pool, ready, "round-robin", new Set<number>());
    expect(r1.kind).toBe("assigned");

    const r2 = assign(r1.nextState, "s2", pool, ready, "round-robin", new Set<number>());
    expect(r2.kind).toBe("assigned");

    // They should be different accounts
    expect(r1.kind === "assigned" && r2.kind === "assigned").toBe(true);
    if (r1.kind === "assigned" && r2.kind === "assigned") {
      expect(r1.accountNumber).not.toBe(r2.accountNumber);
    }
  });

  it("three eligible accounts: cursor cycles 0→1→2→0", () => {
    const pool = [makeAccount(1), makeAccount(2), makeAccount(3)];
    const ready = new Set([1, 2, 3]);

    const r1 = assign(emptyState, "s1", pool, ready, "round-robin", new Set<number>());
    const r2 = assign(r1.nextState, "s2", pool, ready, "round-robin", new Set<number>());
    const r3 = assign(r2.nextState, "s3", pool, ready, "round-robin", new Set<number>());
    const r4 = assign(r3.nextState, "s4", pool, ready, "round-robin", new Set<number>());

    expect(r1.kind).toBe("assigned");
    expect(r2.kind).toBe("assigned");
    expect(r3.kind).toBe("assigned");
    expect(r4.kind).toBe("assigned");

    if (
      r1.kind === "assigned" &&
      r2.kind === "assigned" &&
      r3.kind === "assigned" &&
      r4.kind === "assigned"
    ) {
      const accounts = [r1.accountNumber, r2.accountNumber, r3.accountNumber, r4.accountNumber];
      // Must cover all 3 accounts in first 3 picks
      expect(new Set(accounts.slice(0, 3)).size).toBe(3);
      // 4th pick wraps and equals 1st
      expect(accounts[3]).toBe(accounts[0]);
    }
  });

  it("cursor wraps via modulo when cursor is large", () => {
    const pool = [makeAccount(1), makeAccount(2)];
    const ready = new Set([1, 2]);
    const stateWithLargeCursor: SelectionState = { cursor: 100, assignments: {} };

    const result = assign(
      stateWithLargeCursor,
      "s1",
      pool,
      ready,
      "round-robin",
      new Set<number>(),
    );
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") {
      // cursor 100 % 2 = 0 → first eligible = acct1
      expect(result.accountNumber).toBe(1);
      expect(result.nextState.cursor).toBe(101);
    }
  });

  it("successive sessions with mixed eligibility still spread correctly", () => {
    // pool: 1=unusable, 2=ready, 3=ready, 4=not-ready
    const pool = [
      makeAccount(1, { usable: false, reason: "api_key" }),
      makeAccount(2),
      makeAccount(3),
      makeAccount(4),
    ];
    const ready = new Set([2, 3]);

    const r1 = assign(emptyState, "s1", pool, ready, "round-robin", new Set<number>());
    const r2 = assign(r1.nextState, "s2", pool, ready, "round-robin", new Set<number>());
    const r3 = assign(r2.nextState, "s3", pool, ready, "round-robin", new Set<number>());

    expect(r1.kind).toBe("assigned");
    expect(r2.kind).toBe("assigned");
    expect(r3.kind).toBe("assigned");

    if (r1.kind === "assigned" && r2.kind === "assigned" && r3.kind === "assigned") {
      // eligible set = [2, 3]; cycle should be 2→3→2
      expect([r1.accountNumber, r2.accountNumber]).toEqual(expect.arrayContaining([2, 3]));
      expect(r3.accountNumber).toBe(r1.accountNumber);
    }
  });
});

// ---------------------------------------------------------------------------
// Resume session
// ---------------------------------------------------------------------------

describe("assign — resume session", () => {
  it("pinned account ready → assigned (state unchanged reference)", () => {
    const state: SelectionState = {
      cursor: 5,
      assignments: { s1: 2 },
    };
    const pool = [makeAccount(1), makeAccount(2)];
    const result = assign(state, "s1", pool, new Set([1, 2]), "round-robin", new Set<number>());
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") {
      expect(result.accountNumber).toBe(2);
      // nextState must be the same object (no mutation needed, state unchanged)
      expect(result.nextState).toBe(state);
    }
  });

  it("pinned account usable but NOT ready → warm (state unchanged)", () => {
    const state: SelectionState = { cursor: 0, assignments: { s1: 1 } };
    const pool = [makeAccount(1)];
    // ready is empty → pin not ready
    const result = assign(state, "s1", pool, new Set(), "round-robin", new Set<number>());
    expect(result.kind).toBe("warm");
    if (result.kind === "warm") {
      expect(result.accountNumber).toBe(1);
      expect(result.nextState).toBe(state);
    }
  });

  it("pinned account missing from pool → abort (state unchanged)", () => {
    const state: SelectionState = { cursor: 0, assignments: { s1: 99 } };
    const pool = [makeAccount(1), makeAccount(2)];
    const result = assign(state, "s1", pool, new Set([1, 2]), "round-robin", new Set<number>());
    expect(result.kind).toBe("abort");
    if (result.kind === "abort") {
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.nextState).toBe(state);
    }
  });

  it("pinned account not usable → abort with reason (state unchanged)", () => {
    const state: SelectionState = { cursor: 0, assignments: { s1: 1 } };
    const pool = [makeAccount(1, { usable: false, reason: "token_expired" })];
    const result = assign(state, "s1", pool, new Set([1]), "round-robin", new Set<number>());
    expect(result.kind).toBe("abort");
    if (result.kind === "abort") {
      expect(result.reason).toContain("token_expired");
      expect(result.nextState).toBe(state);
    }
  });

  it("pinned account rate-limited → abort (state unchanged)", () => {
    const state: SelectionState = { cursor: 0, assignments: { s1: 1 } };
    const pool = [makeAccount(1, { rateLimited: true })];
    const result = assign(state, "s1", pool, new Set([1]), "round-robin", new Set<number>());
    expect(result.kind).toBe("abort");
    if (result.kind === "abort") {
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.nextState).toBe(state);
    }
  });

  it("resume NEVER reassigns to a different account even if others are available", () => {
    // pinned=1 but it's not usable; acct 2 is eligible — must NOT pick acct 2
    const state: SelectionState = { cursor: 0, assignments: { s1: 1 } };
    const pool = [makeAccount(1, { usable: false, reason: "api_key" }), makeAccount(2)];
    const result = assign(state, "s1", pool, new Set([2]), "round-robin", new Set<number>());
    expect(result.kind).toBe("abort");
    // Must NOT be "assigned" with account 2
    if (result.kind === "assigned") {
      expect(result.accountNumber).not.toBe(2);
    }
  });

  it("resume preserves cursor from original state", () => {
    const state: SelectionState = { cursor: 42, assignments: { s1: 1 } };
    const pool = [makeAccount(1)];
    const result = assign(state, "s1", pool, new Set([1]), "round-robin", new Set<number>());
    expect(result.nextState.cursor).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Determinism and immutability
// ---------------------------------------------------------------------------

describe("assign — determinism and no-mutation", () => {
  it("same inputs produce same result", () => {
    const pool = [makeAccount(1), makeAccount(2), makeAccount(3)];
    const ready = new Set([1, 2, 3]);
    const r1 = assign(emptyState, "s1", pool, ready, "round-robin", new Set<number>());
    const r2 = assign(emptyState, "s1", pool, ready, "round-robin", new Set<number>());
    expect(r1.kind).toBe(r2.kind);
    if (r1.kind === "assigned" && r2.kind === "assigned") {
      expect(r1.accountNumber).toBe(r2.accountNumber);
      expect(r1.nextState.cursor).toBe(r2.nextState.cursor);
    }
  });

  it("input state is not mutated on new session", () => {
    const state: SelectionState = { cursor: 0, assignments: {} };
    const originalCursor = state.cursor;
    const originalAssignments = { ...state.assignments };

    const pool = [makeAccount(1)];
    assign(state, "s1", pool, new Set([1]), "round-robin", new Set<number>());

    expect(state.cursor).toBe(originalCursor);
    expect(state.assignments).toEqual(originalAssignments);
  });

  it("input state is not mutated on resume", () => {
    const state: SelectionState = { cursor: 3, assignments: { s1: 1 } };
    const originalCursor = state.cursor;
    const originalAssignments = { ...state.assignments };

    const pool = [makeAccount(1)];
    assign(state, "s1", pool, new Set([1]), "round-robin", new Set<number>());

    expect(state.cursor).toBe(originalCursor);
    expect(state.assignments).toEqual(originalAssignments);
  });

  it("abort: nextState is the same object as input state (no new allocation needed)", () => {
    const result = assign(emptyState, "s1", [], new Set(), "round-robin", new Set<number>());
    expect(result.nextState).toBe(emptyState);
  });
});

// ---------------------------------------------------------------------------
// assign — least-used
// ---------------------------------------------------------------------------

describe("assign — least-used", () => {
  it("picks the eligible account with the lowest max(5h,7d) — different from round-robin pick", () => {
    // cursor=0 → round-robin picks eligible[0]=acct1; least-used picks acct3 (lowest metric)
    const pool = [
      makeAccount(1, { fiveHourPct: 80, sevenDayPct: 70 }), // metric=80
      makeAccount(2, { fiveHourPct: 60, sevenDayPct: 60 }), // metric=60
      makeAccount(3, { fiveHourPct: 10, sevenDayPct: 20 }), // metric=20 (least-used)
    ];
    const ready = new Set([1, 2, 3]);

    const rrResult = assign(emptyState, "s1", pool, ready, "round-robin", new Set<number>());
    const luResult = assign(emptyState, "s1", pool, ready, "least-used", new Set<number>());

    expect(rrResult.kind).toBe("assigned");
    expect(luResult.kind).toBe("assigned");

    if (rrResult.kind === "assigned") expect(rrResult.accountNumber).toBe(1);
    if (luResult.kind === "assigned") expect(luResult.accountNumber).toBe(3);
  });

  it("deterministic tie-break: equal metric → lowest number; same inputs → same output", () => {
    const pool = [
      makeAccount(2, { fiveHourPct: 50, sevenDayPct: 50 }), // metric=50, higher number
      makeAccount(1, { fiveHourPct: 50, sevenDayPct: 50 }), // metric=50, lower number
    ];
    const ready = new Set([1, 2]);

    const r1 = assign(emptyState, "s1", pool, ready, "least-used", new Set<number>());
    const r2 = assign(emptyState, "s1", pool, ready, "least-used", new Set<number>());

    expect(r1.kind).toBe("assigned");
    expect(r2.kind).toBe("assigned");

    if (r1.kind === "assigned") expect(r1.accountNumber).toBe(1);
    if (r2.kind === "assigned") expect(r2.accountNumber).toBe(1);
    if (r1.kind === "assigned" && r2.kind === "assigned") {
      expect(r1.accountNumber).toBe(r2.accountNumber);
    }
  });

  it("usageUnavailable account not chosen over ready known account (tier logic)", () => {
    const pool = [
      makeAccount(1, { usageUnavailable: true }),
      makeAccount(2, { fiveHourPct: 10, sevenDayPct: 10 }), // known
    ];
    const ready = new Set([1, 2]);

    const result = assign(emptyState, "s1", pool, ready, "least-used", new Set<number>());
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") expect(result.accountNumber).toBe(2);
  });

  it("single ready usageUnavailable account is assigned (fallback tier)", () => {
    const pool = [makeAccount(1, { usageUnavailable: true })];
    const ready = new Set([1]);

    const result = assign(emptyState, "s1", pool, ready, "least-used", new Set<number>());
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") expect(result.accountNumber).toBe(1);
  });

  it("max(5h,7d) semantics: low-5h but high-7d loses to mid-mid account", () => {
    const pool = [
      makeAccount(1, { fiveHourPct: 10, sevenDayPct: 90 }), // metric=90
      makeAccount(2, { fiveHourPct: 50, sevenDayPct: 50 }), // metric=50
    ];
    const ready = new Set([1, 2]);

    const result = assign(emptyState, "s1", pool, ready, "least-used", new Set<number>());
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") expect(result.accountNumber).toBe(2);
  });

  it("advances cursor by 1 and pins session in nextState.assignments", () => {
    const pool = [
      makeAccount(1, { fiveHourPct: 80, sevenDayPct: 80 }), // metric=80
      makeAccount(2, { fiveHourPct: 10, sevenDayPct: 10 }), // metric=10 (least-used)
    ];
    const ready = new Set([1, 2]);

    const result = assign(emptyState, "s1", pool, ready, "least-used", new Set<number>());
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") {
      expect(result.accountNumber).toBe(2);
      expect(result.nextState.cursor).toBe(1);
      expect(result.nextState.assignments["s1"]).toBe(2);
    }
  });

  it("respects eligibility: rate-limited/non-ready/non-usable never picked even if pcts lowest", () => {
    const pool = [
      makeAccount(1, { rateLimited: true, fiveHourPct: 0, sevenDayPct: 0 }), // rate-limited
      makeAccount(2, { usable: false, reason: "api_key", fiveHourPct: 0, sevenDayPct: 0 }), // not usable
      makeAccount(3, { fiveHourPct: 80, sevenDayPct: 80 }), // usable, highest metric but only eligible
    ];
    const ready = new Set([1, 2, 3]);

    const result = assign(emptyState, "s1", pool, ready, "least-used", new Set<number>());
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") expect(result.accountNumber).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// assign — reset-soon
// (imminence is computed by the caller and passed in; assign only consumes the set)
// ---------------------------------------------------------------------------

describe("assign — reset-soon", () => {
  it("favors an imminent eligible account over a fresher non-imminent one", () => {
    const pool = [
      makeAccount(1, { fiveHourPct: 5, sevenDayPct: 5 }), // freshest, but NOT imminent
      makeAccount(2, { fiveHourPct: 14, sevenDayPct: 68 }), // imminent
    ];
    const ready = new Set([1, 2]);
    const result = assign(emptyState, "s1", pool, ready, "reset-soon", new Set([2]));
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") expect(result.accountNumber).toBe(2);
  });

  it("imminent acct wins every new session (whole funnel lands on it)", () => {
    const pool = [
      makeAccount(1, { fiveHourPct: 5, sevenDayPct: 5 }),
      makeAccount(2, { fiveHourPct: 14, sevenDayPct: 68 }),
    ];
    const ready = new Set([1, 2]);
    const imminent = new Set([2]);
    const r1 = assign(emptyState, "s1", pool, ready, "reset-soon", imminent);
    const r2 = assign(
      r1.kind === "assigned" ? r1.nextState : emptyState,
      "s2",
      pool,
      ready,
      "reset-soon",
      imminent,
    );
    if (r1.kind === "assigned") expect(r1.accountNumber).toBe(2);
    if (r2.kind === "assigned") expect(r2.accountNumber).toBe(2);
  });

  it("multiple imminent → lowest max(5h,7d), tie-break lowest number", () => {
    const pool = [
      makeAccount(1, { fiveHourPct: 70, sevenDayPct: 30 }), // metric=70
      makeAccount(2, { fiveHourPct: 20, sevenDayPct: 40 }), // metric=40 (picked)
      makeAccount(3, { fiveHourPct: 10, sevenDayPct: 80 }), // metric=80
    ];
    const ready = new Set([1, 2, 3]);
    const result = assign(emptyState, "s1", pool, ready, "reset-soon", new Set([1, 2, 3]));
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") expect(result.accountNumber).toBe(2);
  });

  it("multiple imminent with equal metric → lowest account number", () => {
    const pool = [
      makeAccount(2, { fiveHourPct: 50, sevenDayPct: 50 }),
      makeAccount(1, { fiveHourPct: 50, sevenDayPct: 50 }),
    ];
    const ready = new Set([1, 2]);
    const result = assign(emptyState, "s1", pool, ready, "reset-soon", new Set([1, 2]));
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") expect(result.accountNumber).toBe(1);
  });

  it("no imminent (empty set) → behaves exactly like least-used over eligible", () => {
    const pool = [
      makeAccount(1, { fiveHourPct: 80, sevenDayPct: 70 }), // metric=80
      makeAccount(2, { fiveHourPct: 10, sevenDayPct: 20 }), // metric=20 (least-used)
    ];
    const ready = new Set([1, 2]);
    const rs = assign(emptyState, "s1", pool, ready, "reset-soon", new Set<number>());
    const lu = assign(emptyState, "s1", pool, ready, "least-used", new Set<number>());
    expect(rs.kind).toBe("assigned");
    if (rs.kind === "assigned" && lu.kind === "assigned") {
      expect(rs.accountNumber).toBe(2);
      expect(rs.accountNumber).toBe(lu.accountNumber);
    }
  });

  it("imminent member that is not eligible (rate-limited) is excluded → falls back to least-used", () => {
    const pool = [
      makeAccount(1, { rateLimited: true, fiveHourPct: 14, sevenDayPct: 68 }), // imminent but rate-limited
      makeAccount(2, { fiveHourPct: 30, sevenDayPct: 30 }), // only eligible
    ];
    const ready = new Set([1, 2]);
    const result = assign(emptyState, "s1", pool, ready, "reset-soon", new Set([1]));
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") expect(result.accountNumber).toBe(2);
  });

  it("advances cursor by 1 and pins the session", () => {
    const pool = [makeAccount(1, { fiveHourPct: 14, sevenDayPct: 68 })];
    const result = assign(emptyState, "s1", pool, new Set([1]), "reset-soon", new Set([1]));
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") {
      expect(result.nextState.cursor).toBe(1);
      expect(result.nextState.assignments["s1"]).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Two-tier selection (usage-unavailable deprioritization)
// ---------------------------------------------------------------------------

describe("assign — two-tier selection", () => {
  it("known and unavailable both ready → known picked (round-robin)", () => {
    const pool = [makeAccount(1, { usageUnavailable: true }), makeAccount(2)];
    const ready = new Set([1, 2]);
    const result = assign(emptyState, "s1", pool, ready, "round-robin", new Set<number>());
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") expect(result.accountNumber).toBe(2);
  });

  it("known and unavailable both ready → known picked (least-used)", () => {
    const pool = [makeAccount(1, { usageUnavailable: true }), makeAccount(2)];
    const ready = new Set([1, 2]);
    const result = assign(emptyState, "s1", pool, ready, "least-used", new Set<number>());
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") expect(result.accountNumber).toBe(2);
  });

  it("all-unavailable ready → an unavailable account picked (last resort, not abort)", () => {
    const pool = [
      makeAccount(1, { usageUnavailable: true }),
      makeAccount(2, { usageUnavailable: true }),
    ];
    const ready = new Set([1, 2]);
    const result = assign(emptyState, "s1", pool, ready, "round-robin", new Set<number>());
    expect(result.kind).toBe("assigned");
  });

  it("pinned usageUnavailable account that is ready → assigned (not abort)", () => {
    const state: SelectionState = { cursor: 0, assignments: { s1: 1 } };
    const pool = [makeAccount(1, { usageUnavailable: true })];
    const result = assign(state, "s1", pool, new Set([1]), "round-robin", new Set<number>());
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") {
      expect(result.accountNumber).toBe(1);
      expect(result.nextState).toBe(state);
    }
  });

  it("pinned usageUnavailable account not ready → warm (not abort)", () => {
    const state: SelectionState = { cursor: 0, assignments: { s1: 1 } };
    const pool = [makeAccount(1, { usageUnavailable: true })];
    const result = assign(state, "s1", pool, new Set<number>(), "round-robin", new Set<number>());
    expect(result.kind).toBe("warm");
    if (result.kind === "warm") {
      expect(result.accountNumber).toBe(1);
      expect(result.nextState).toBe(state);
    }
  });
});
