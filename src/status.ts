import type { ResolvedConfig } from "./config";
import type { PoolAccount } from "./accounts";
import type { SelectionState } from "./selection";

export interface LastSpawn {
  sessionId: string;
  accountNumber: number;
  credentialDir: string;
  at: string;
}

/**
 * Free-form JSON blob for publishStatus + GET stats: config in effect, pool (per-account
 * number/email/usable/rateLimited/pct/ready), current assignments, cursor, lastSpawn, and
 * the last refresh error (`lastError`) so operators can see why the pool is empty.
 * All values are JSON-serializable (no Set/Map/undefined).
 */
export function buildStatus(
  cfg: ResolvedConfig,
  pool: PoolAccount[],
  ready: Set<number>,
  state: SelectionState,
  lastSpawn: LastSpawn | null,
  lastError: string | null,
): Record<string, unknown> {
  return {
    config: {
      cswapBin: cfg.cswapBin,
      includeSlots: cfg.includeSlots,
      excludeSlots: cfg.excludeSlots,
      rateLimitPct: cfg.rateLimitPct,
      strategy: cfg.strategy,
      prewarmArgs: cfg.prewarmArgs,
      refreshIntervalMs: cfg.refreshIntervalMs,
      bootWarmTimeoutMs: cfg.bootWarmTimeoutMs,
      abortOnEmpty: cfg.abortOnEmpty,
    },
    pool: pool.map((acct) => ({
      number: acct.number,
      email: acct.email,
      usable: acct.usable,
      rateLimited: acct.rateLimited,
      reason: acct.reason,
      fiveHourPct: acct.fiveHourPct,
      sevenDayPct: acct.sevenDayPct,
      fiveHourResetsAt: acct.fiveHourResetsAt,
      sevenDayResetsAt: acct.sevenDayResetsAt,
      active: acct.active,
      ready: ready.has(acct.number),
      usageUnavailable: acct.usageUnavailable,
    })),
    assignments: state.assignments,
    cursor: state.cursor,
    lastSpawn: lastSpawn,
    lastError: lastError,
  };
}
