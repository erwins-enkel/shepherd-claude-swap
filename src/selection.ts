import type { PoolAccount } from "./accounts";
import type { Strategy } from "./config";

export interface SelectionState {
  cursor: number;
  assignments: Record<string, number>; // sessionId → accountNumber
}

export type AssignResult =
  | { kind: "assigned"; accountNumber: number; nextState: SelectionState }
  | { kind: "warm"; accountNumber: number; nextState: SelectionState } // resume: pinned usable but not ready
  | { kind: "abort"; reason: string; nextState: SelectionState };

/**
 * Decide the account for a spawn. `ready` = account numbers whose profile is pre-warmed.
 *
 * Resume (sessionId already in assignments):
 *   - pin usable & not rate-limited & ready → "assigned" (state unchanged)
 *   - pin usable & not rate-limited & NOT ready → "warm" (state unchanged)
 *   - pin gone/unusable/rate-limited → "abort" (reason; state unchanged — never reassign a resume)
 *
 * New session (no pin): pick from accounts that are usable && !rateLimited && ready.
 *   - "round-robin": cursor % eligible.length, advance cursor.
 *   - "least-used": account with lowest max(fiveHourPct ?? 100, sevenDayPct ?? 100);
 *     tie-break by lowest account number. Cursor still advances by 1.
 *   None eligible → "abort".
 *
 * Deterministic; no Date/random.
 */
export function assign(
  state: SelectionState,
  sessionId: string,
  pool: PoolAccount[],
  ready: Set<number>,
  strategy: Strategy,
): AssignResult {
  const pin = state.assignments[sessionId];

  // -------------------------------------------------------------------------
  // Resume path
  // -------------------------------------------------------------------------
  if (pin !== undefined) {
    const acct = pool.find((a) => a.number === pin);

    if (acct === undefined) {
      return {
        kind: "abort",
        reason: `pinned account ${pin} not found in pool`,
        nextState: state,
      };
    }

    if (!acct.usable) {
      return {
        kind: "abort",
        reason: `pinned account ${pin} not usable: ${acct.reason ?? "unknown"}`,
        nextState: state,
      };
    }

    if (acct.rateLimited) {
      return {
        kind: "abort",
        reason: `pinned account ${pin} is rate-limited`,
        nextState: state,
      };
    }

    if (ready.has(pin)) {
      return { kind: "assigned", accountNumber: pin, nextState: state };
    }

    return { kind: "warm", accountNumber: pin, nextState: state };
  }

  // -------------------------------------------------------------------------
  // New session path — pick over eligible
  // -------------------------------------------------------------------------
  const eligible = pool.filter((a) => a.usable && !a.rateLimited && ready.has(a.number));

  if (eligible.length === 0) {
    return {
      kind: "abort",
      reason: "no usable ready account available",
      nextState: state,
    };
  }

  const picked =
    strategy === "least-used" ? pickLeastUsed(eligible) : eligible[state.cursor % eligible.length]!;

  return {
    kind: "assigned",
    accountNumber: picked.number,
    nextState: {
      cursor: state.cursor + 1,
      assignments: { ...state.assignments, [sessionId]: picked.number },
    },
  };
}

/**
 * Pick the eligible account with the lowest usage metric.
 * metric(a) = max(fiveHourPct ?? 100, sevenDayPct ?? 100)
 * A single null pct forces the whole metric to 100.
 * Tie-break: lowest account number. Deterministic; no Date/random.
 */
function pickLeastUsed(eligible: PoolAccount[]): PoolAccount {
  return eligible.reduce((best, curr) => {
    const bestMetric = Math.max(best.fiveHourPct ?? 100, best.sevenDayPct ?? 100);
    const currMetric = Math.max(curr.fiveHourPct ?? 100, curr.sevenDayPct ?? 100);
    if (currMetric < bestMetric) return curr;
    if (currMetric === bestMetric && curr.number < best.number) return curr;
    return best;
  });
}
