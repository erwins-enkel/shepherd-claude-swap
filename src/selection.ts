import type { PoolAccount } from "./accounts";
import type { Strategy } from "./config";

export interface SelectionState {
  cursor: number;
  assignments: Record<string, number>; // sessionId → accountNumber
}

export type AssignResult =
  | { kind: "assigned"; accountNumber: number; nextState: SelectionState }
  | { kind: "passthrough"; accountNumber: number; nextState: SelectionState } // primary via default login
  | { kind: "warm"; accountNumber: number; nextState: SelectionState } // resume: pinned usable but not ready
  | { kind: "abort"; reason: string; nextState: SelectionState };

/**
 * Decide the account for a spawn. `ready` = account numbers whose profile is pre-warmed.
 *
 * `primary` is the account reachable via PASS-THROUGH — the one cswap has active, whose credential
 * store is the default `~/.claude`. It can never appear in `ready`: `cswap run <active>` takes a
 * same-account fast path that creates no `sessions/<N>-<slug>/` dir, so the prewarmer skips it and
 * prunes it. Routing to it therefore means emitting NO `credentialDir` at all, which is what
 * "passthrough" tells the caller to do. Pass `null` when the primary is unknown or unsafe to use
 * (e.g. mid-switch, when the caller's snapshot of the active account is stale) — then the fallback
 * is simply unavailable and the pre-existing behavior stands.
 *
 * Resume (sessionId already in assignments):
 *   - pin gone/unusable/rate-limited → "abort" (reason; state unchanged — never reassign a resume)
 *   - pin is `primary` → "passthrough" (state unchanged): the default login IS the pinned account,
 *     so the session keeps its identity. Checked before `ready` because a pinned account that
 *     BECAME the primary can never be warmed — without this it would return "warm" forever.
 *   - pin ready → "assigned" (state unchanged)
 *   - pin NOT ready → "warm" (state unchanged)
 *
 * New session (no pin): pick from accounts that are usable && !rateLimited && ready.
 *   - "round-robin": cursor % eligible.length, advance cursor.
 *   - "least-used": account with lowest max(fiveHourPct ?? 100, sevenDayPct ?? 100);
 *     tie-break by lowest account number. Cursor still advances by 1.
 *   - "reset-soon": order by soonest 7-day reset (`resetOrder`, computed by the caller — see
 *     `computeResetOrder`), tie-broken by the least-used metric then account number. Cursor still
 *     advances by 1.
 *   None eligible, but `primary` is usable && !rateLimited → "passthrough" (pins + advances cursor
 *   exactly like "assigned"), so a drained pool falls back onto the one healthy account instead of
 *   halting. Strictly last resort: any ready account outranks it.
 *   None eligible and no usable primary → "abort".
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
  primary: number | null = null,
): AssignResult {
  const pin = state.assignments[sessionId];
  if (pin !== undefined) return resolvePin(state, pin, pool, ready, primary);

  // -------------------------------------------------------------------------
  // New session path — pick over eligible (two-tier: known first, unavailable as last resort),
  // then the primary via pass-through as the final tier below.
  // -------------------------------------------------------------------------
  const readyUsable = pool.filter((a) => a.usable && !a.rateLimited && ready.has(a.number));
  const known = readyUsable.filter((a) => !a.usageUnavailable);
  const fallback = readyUsable.filter((a) => a.usageUnavailable);
  const eligible = known.length > 0 ? known : fallback;

  if (eligible.length === 0) {
    // Last resort: nothing is pre-warmed, but the primary itself is healthy. Route onto the default
    // login rather than halting every spawn while the rest of the pool recovers.
    const primaryAcct = pool.find((a) => a.number === primary);
    if (primaryAcct !== undefined && primaryAcct.usable && !primaryAcct.rateLimited) {
      return {
        kind: "passthrough",
        accountNumber: primaryAcct.number,
        nextState: {
          cursor: state.cursor + 1,
          assignments: { ...state.assignments, [sessionId]: primaryAcct.number },
        },
      };
    }
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
 * The resume path: resolve a session's existing pin. NEVER reassigns — `state` comes back
 * untouched on every branch, so a running session can only ever land on the account it was
 * created under, or not spawn at all.
 *
 * Ordered gate chain, first match wins: gone / unusable / rate-limited abort with a reason;
 * the primary passes through (see `assign` — it can never be `ready`, so this must precede the
 * `ready` check or such a pin would warm forever); ready assigns; anything else warms.
 */
function resolvePin(
  state: SelectionState,
  pin: number,
  pool: PoolAccount[],
  ready: Set<number>,
  primary: number | null,
): AssignResult {
  const abort = (reason: string): AssignResult => ({ kind: "abort", reason, nextState: state });
  const acct = pool.find((a) => a.number === pin);

  if (acct === undefined) return abort(`pinned account ${pin} not found in pool`);
  if (!acct.usable) return abort(`pinned account ${pin} not usable: ${acct.reason ?? "unknown"}`);
  if (acct.rateLimited) return abort(`pinned account ${pin} is rate-limited`);
  if (pin === primary) return { kind: "passthrough", accountNumber: pin, nextState: state };
  if (ready.has(pin)) return { kind: "assigned", accountNumber: pin, nextState: state };

  return { kind: "warm", accountNumber: pin, nextState: state };
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
