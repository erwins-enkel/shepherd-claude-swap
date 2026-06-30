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
 *   - "reset-soon": among eligible accounts whose number is in `imminent` (7-day reset within 24h
 *     with capacity — computed by the caller, see `computeImminent`), pick by the least-used metric;
 *     when none are imminent, fall back to least-used over all eligible. Cursor still advances by 1.
 *   None eligible → "abort".
 *
 * `imminent` is supplied by the caller (clock lives there) so this stays deterministic; no
 * Date/random here.
 */
export function assign(
  state: SelectionState,
  sessionId: string,
  pool: PoolAccount[],
  ready: Set<number>,
  strategy: Strategy,
  imminent: Set<number>,
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
  // New session path — pick over eligible (two-tier: known first, unavailable as last resort)
  // -------------------------------------------------------------------------
  const readyUsable = pool.filter((a) => a.usable && !a.rateLimited && ready.has(a.number));
  const known = readyUsable.filter((a) => !a.usageUnavailable);
  const fallback = readyUsable.filter((a) => a.usageUnavailable);
  const eligible = known.length > 0 ? known : fallback;

  if (eligible.length === 0) {
    return {
      kind: "abort",
      reason: "no usable ready account available",
      nextState: state,
    };
  }

  const picked = pickByStrategy(strategy, eligible, imminent, state.cursor);

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
 * Pick the eligible account per `strategy`. Deterministic; no Date/random.
 *  - "reset-soon": prefer eligible accounts in `imminent` (7-day reset within 24h with capacity),
 *    chosen by the least-used metric; fall back to least-used over all eligible when none imminent.
 *  - "least-used": least-used over all eligible.
 *  - "round-robin": cursor % eligible.length.
 */
function pickByStrategy(
  strategy: Strategy,
  eligible: PoolAccount[],
  imminent: Set<number>,
  cursor: number,
): PoolAccount {
  if (strategy === "reset-soon") {
    const imminentEligible = eligible.filter((a) => imminent.has(a.number));
    return pickLeastUsed(imminentEligible.length > 0 ? imminentEligible : eligible);
  }
  if (strategy === "least-used") return pickLeastUsed(eligible);
  return eligible[cursor % eligible.length]!;
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
