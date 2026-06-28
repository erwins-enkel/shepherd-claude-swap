import type { ResolvedConfig } from "./config";
import type { CswapListResult } from "./cswap";

export interface PoolAccount {
  number: number;
  email: string;
  usable: boolean;
  rateLimited: boolean;
  reason: string | null;
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  active: boolean;
  usageUnavailable: boolean;
}

/**
 * Classify every account row from a --list result into the pool, honoring config.
 * api_key/token_expired/no_credentials/unavailable → usable:false with reason.
 * include/exclude slots filter membership.
 */
export function classifyPool(list: CswapListResult, cfg: ResolvedConfig): PoolAccount[] {
  return list.accounts.map((acct) => {
    const fiveHourPct = acct.usage?.fiveHour?.pct ?? null;
    const sevenDayPct = acct.usage?.sevenDay?.pct ?? null;

    // Non-ok usageStatus: unusable, reason = status value
    if (acct.usageStatus !== "ok") {
      return {
        number: acct.number,
        email: acct.email,
        usable: false,
        rateLimited: false,
        reason: acct.usageStatus,
        fiveHourPct,
        sevenDayPct,
        active: acct.active,
        usageUnavailable: false,
      };
    }

    // Excluded by excludeSlots
    if (cfg.excludeSlots.includes(acct.number)) {
      return {
        number: acct.number,
        email: acct.email,
        usable: false,
        rateLimited: false,
        reason: "excluded-slot",
        fiveHourPct,
        sevenDayPct,
        active: acct.active,
        usageUnavailable: false,
      };
    }

    // Not in includeSlots (when includeSlots is non-null)
    if (cfg.includeSlots !== null && !cfg.includeSlots.includes(acct.number)) {
      return {
        number: acct.number,
        email: acct.email,
        usable: false,
        rateLimited: false,
        reason: "not-in-include",
        fiveHourPct,
        sevenDayPct,
        active: acct.active,
        usageUnavailable: false,
      };
    }

    // Usable — check rate-limit: >= threshold (null pcts don't trigger)
    const rateLimited =
      (fiveHourPct !== null && fiveHourPct >= cfg.rateLimitPct) ||
      (sevenDayPct !== null && sevenDayPct >= cfg.rateLimitPct);

    return {
      number: acct.number,
      email: acct.email,
      usable: true,
      rateLimited,
      reason: null,
      fiveHourPct,
      sevenDayPct,
      active: acct.active,
      usageUnavailable: fiveHourPct === null && sevenDayPct === null,
    };
  });
}
