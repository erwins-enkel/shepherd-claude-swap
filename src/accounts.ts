import type { ResolvedConfig } from "./config";
import type { CswapListResult } from "./cswap";

/** A per-model weekly limit window (e.g. "Fable"), normalized for display. */
export interface ScopedWindow {
  name: string;
  pct: number;
  resetsAt: string | null;
  resetClock: string | null;
  resetCountdown: string | null;
}

export interface PoolAccount {
  number: number;
  email: string;
  usable: boolean;
  rateLimited: boolean;
  reason: string | null;
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  fiveHourResetsAt: string | null;
  sevenDayResetsAt: string | null;
  fiveHourResetClock: string | null;
  sevenDayResetClock: string | null;
  fiveHourResetCountdown: string | null;
  sevenDayResetCountdown: string | null;
  active: boolean;
  usageUnavailable: boolean;
  // Display-only: per-model weekly windows (e.g. Fable). Never affects usable/rateLimited/usageUnavailable.
  scopedWindows: ScopedWindow[];
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
    const resetFields = {
      fiveHourResetsAt: acct.usage?.fiveHour?.resetsAt ?? null,
      sevenDayResetsAt: acct.usage?.sevenDay?.resetsAt ?? null,
      fiveHourResetClock: acct.usage?.fiveHour?.clock ?? null,
      sevenDayResetClock: acct.usage?.sevenDay?.clock ?? null,
      fiveHourResetCountdown: acct.usage?.fiveHour?.countdown ?? null,
      sevenDayResetCountdown: acct.usage?.sevenDay?.countdown ?? null,
    };
    const scopedWindows: ScopedWindow[] = (acct.usage?.scoped ?? []).map((w) => ({
      name: w.name,
      pct: w.pct,
      resetsAt: w.resetsAt ?? null,
      resetClock: w.clock ?? null,
      resetCountdown: w.countdown ?? null,
    }));

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
        ...resetFields,
        active: acct.active,
        usageUnavailable: false,
        scopedWindows,
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
        ...resetFields,
        active: acct.active,
        usageUnavailable: false,
        scopedWindows,
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
        ...resetFields,
        active: acct.active,
        usageUnavailable: false,
        scopedWindows,
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
      ...resetFields,
      active: acct.active,
      usageUnavailable: fiveHourPct === null && sevenDayPct === null,
      scopedWindows,
    };
  });
}
