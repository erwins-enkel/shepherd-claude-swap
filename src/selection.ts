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
 *   - "reset-soon": order by soonest 7-day reset (`resetOrder`, computed by the caller — see
 *     `computeResetOrder`), tie-broken by the least-used metric then account number. Cursor still
 *     advances by 1.
 *   None eligible → "abort".
 *
 * `resetOrder` is supplied by the caller (clock lives there) so this stays deterministic; no
 * Date/random here.
 */
export function assign(
  state: SelectionState,
  sessionId: string,
  pool: PoolAccount[],
  ready: Set<number>,
  strategy: Strategy,
  resetOrder: Map<number, number>,
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

  const picked = pickByStrategy(strategy, eligible, resetOrder, state.cursor);

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
 *  - "reset-soon": soonest 7-day reset first (`resetOrder`; absent ⇒ Infinity, so unranked accounts
 *    sort last), tie-broken by the least-used metric then account number.
 *  - "least-used": least-used over all eligible.
 *  - "round-robin": cursor % eligible.length.
 */
function pickByStrategy(
  strategy: Strategy,
  eligible: PoolAccount[],
  resetOrder: Map<number, number>,
  cursor: number,
): PoolAccount {
  if (strategy === "reset-soon") return pickResetSoon(eligible, resetOrder);
  if (strategy === "least-used") return pickLeastUsed(eligible);
  return eligible[cursor % eligible.length]!;
}

/**
 * Usage metric for an account: the binding window. A single null pct forces the whole metric to
 * 100, so an account with unknown usage never wins on it.
 */
function usageMetric(a: PoolAccount): number {
  return Math.max(a.fiveHourPct ?? 100, a.sevenDayPct ?? 100);
}

/**
 * Pick by soonest 7-day reset — drain perishable quota before it refills.
 *
 * Ordered by `(resetOrder ?? Infinity, usageMetric, number)`. Two properties fall out of that
 * rather than needing branches:
 *  - when NO account is ranked (all Infinity) the ordering degenerates exactly to `pickLeastUsed`,
 *    which is the documented fallback;
 *  - an account failing either headroom band is absent from `resetOrder`, so it sorts behind every
 *    ranked account and is reached only as a last resort — then by least-used.
 */
function pickResetSoon(eligible: PoolAccount[], resetOrder: Map<number, number>): PoolAccount {
  return eligible.reduce((best, curr) => {
    const bestReset = resetOrder.get(best.number) ?? Infinity;
    const currReset = resetOrder.get(curr.number) ?? Infinity;
    if (currReset !== bestReset) return currReset < bestReset ? curr : best;

    const bestMetric = usageMetric(best);
    const currMetric = usageMetric(curr);
    if (currMetric !== bestMetric) return currMetric < bestMetric ? curr : best;

    return curr.number < best.number ? curr : best;
  });
}

/**
 * Pick the eligible account with the lowest usage metric.
 * Tie-break: lowest account number. Deterministic; no Date/random.
 */
function pickLeastUsed(eligible: PoolAccount[]): PoolAccount {
  return eligible.reduce((best, curr) => {
    const bestMetric = usageMetric(best);
    const currMetric = usageMetric(curr);
    if (currMetric !== bestMetric) return currMetric < bestMetric ? curr : best;
    return curr.number < best.number ? curr : best;
  });
}
