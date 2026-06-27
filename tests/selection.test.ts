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
    fiveHourPct: null,
    sevenDayPct: null,
    active: true,
    ...opts,
  };
}

const emptyState: SelectionState = { cursor: 0, assignments: {} };

// ---------------------------------------------------------------------------
// New session — abort cases
// ---------------------------------------------------------------------------

describe("assign — new session — abort when no eligible", () => {
  it("empty pool → abort", () => {
    const result = assign(emptyState, "s1", [], new Set());
    expect(result.kind).toBe("abort");
    if (result.kind === "abort") {
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.nextState).toBe(emptyState); // state unchanged
    }
  });

  it("pool has accounts but none are ready → abort", () => {
    const pool = [makeAccount(1), makeAccount(2)];
    const result = assign(emptyState, "s1", pool, new Set());
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
    const result = assign(emptyState, "s1", pool, new Set([1, 2]));
    expect(result.kind).toBe("abort");
  });

  it("all accounts rate-limited → abort", () => {
    const pool = [makeAccount(1, { rateLimited: true }), makeAccount(2, { rateLimited: true })];
    const result = assign(emptyState, "s1", pool, new Set([1, 2]));
    expect(result.kind).toBe("abort");
  });

  it("unusable + rate-limited mix → abort", () => {
    const pool = [
      makeAccount(1, { usable: false, reason: "api_key" }),
      makeAccount(2, { rateLimited: true }),
    ];
    const result = assign(emptyState, "s1", pool, new Set([1, 2]));
    expect(result.kind).toBe("abort");
  });
});

// ---------------------------------------------------------------------------
// New session — assigned cases
// ---------------------------------------------------------------------------

describe("assign — new session — assigned", () => {
  it("single eligible account → assigned with that account", () => {
    const pool = [makeAccount(1)];
    const result = assign(emptyState, "s1", pool, new Set([1]));
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") {
      expect(result.accountNumber).toBe(1);
    }
  });

  it("assigned: nextState has sessionId pinned", () => {
    const pool = [makeAccount(1)];
    const result = assign(emptyState, "s1", pool, new Set([1]));
    expect(result.kind).toBe("assigned");
    expect(result.nextState.assignments["s1"]).toBe(1);
  });

  it("assigned: cursor advances by 1", () => {
    const pool = [makeAccount(1)];
    const result = assign(emptyState, "s1", pool, new Set([1]));
    expect(result.nextState.cursor).toBe(1);
  });

  it("skips non-ready accounts in round-robin", () => {
    // acct 1 is ready; acct 2 is not ready
    const pool = [makeAccount(1), makeAccount(2)];
    const result = assign(emptyState, "s1", pool, new Set([1]));
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") {
      expect(result.accountNumber).toBe(1);
    }
  });

  it("skips non-usable accounts in round-robin", () => {
    const pool = [makeAccount(1, { usable: false, reason: "api_key" }), makeAccount(2)];
    const result = assign(emptyState, "s1", pool, new Set([1, 2]));
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") {
      expect(result.accountNumber).toBe(2);
    }
  });

  it("skips rate-limited accounts in round-robin", () => {
    const pool = [makeAccount(1, { rateLimited: true }), makeAccount(2)];
    const result = assign(emptyState, "s1", pool, new Set([1, 2]));
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

    const r1 = assign(emptyState, "s1", pool, ready);
    expect(r1.kind).toBe("assigned");

    const r2 = assign(r1.nextState, "s2", pool, ready);
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

    const r1 = assign(emptyState, "s1", pool, ready);
    const r2 = assign(r1.nextState, "s2", pool, ready);
    const r3 = assign(r2.nextState, "s3", pool, ready);
    const r4 = assign(r3.nextState, "s4", pool, ready);

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

    const result = assign(stateWithLargeCursor, "s1", pool, ready);
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

    const r1 = assign(emptyState, "s1", pool, ready);
    const r2 = assign(r1.nextState, "s2", pool, ready);
    const r3 = assign(r2.nextState, "s3", pool, ready);

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
    const result = assign(state, "s1", pool, new Set([1, 2]));
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
    const result = assign(state, "s1", pool, new Set());
    expect(result.kind).toBe("warm");
    if (result.kind === "warm") {
      expect(result.accountNumber).toBe(1);
      expect(result.nextState).toBe(state);
    }
  });

  it("pinned account missing from pool → abort (state unchanged)", () => {
    const state: SelectionState = { cursor: 0, assignments: { s1: 99 } };
    const pool = [makeAccount(1), makeAccount(2)];
    const result = assign(state, "s1", pool, new Set([1, 2]));
    expect(result.kind).toBe("abort");
    if (result.kind === "abort") {
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.nextState).toBe(state);
    }
  });

  it("pinned account not usable → abort with reason (state unchanged)", () => {
    const state: SelectionState = { cursor: 0, assignments: { s1: 1 } };
    const pool = [makeAccount(1, { usable: false, reason: "token_expired" })];
    const result = assign(state, "s1", pool, new Set([1]));
    expect(result.kind).toBe("abort");
    if (result.kind === "abort") {
      expect(result.reason).toContain("token_expired");
      expect(result.nextState).toBe(state);
    }
  });

  it("pinned account rate-limited → abort (state unchanged)", () => {
    const state: SelectionState = { cursor: 0, assignments: { s1: 1 } };
    const pool = [makeAccount(1, { rateLimited: true })];
    const result = assign(state, "s1", pool, new Set([1]));
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
    const result = assign(state, "s1", pool, new Set([2]));
    expect(result.kind).toBe("abort");
    // Must NOT be "assigned" with account 2
    if (result.kind === "assigned") {
      expect(result.accountNumber).not.toBe(2);
    }
  });

  it("resume preserves cursor from original state", () => {
    const state: SelectionState = { cursor: 42, assignments: { s1: 1 } };
    const pool = [makeAccount(1)];
    const result = assign(state, "s1", pool, new Set([1]));
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
    const r1 = assign(emptyState, "s1", pool, ready);
    const r2 = assign(emptyState, "s1", pool, ready);
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
    assign(state, "s1", pool, new Set([1]));

    expect(state.cursor).toBe(originalCursor);
    expect(state.assignments).toEqual(originalAssignments);
  });

  it("input state is not mutated on resume", () => {
    const state: SelectionState = { cursor: 3, assignments: { s1: 1 } };
    const originalCursor = state.cursor;
    const originalAssignments = { ...state.assignments };

    const pool = [makeAccount(1)];
    assign(state, "s1", pool, new Set([1]));

    expect(state.cursor).toBe(originalCursor);
    expect(state.assignments).toEqual(originalAssignments);
  });

  it("abort: nextState is the same object as input state (no new allocation needed)", () => {
    const result = assign(emptyState, "s1", [], new Set());
    expect(result.nextState).toBe(emptyState);
  });
});
