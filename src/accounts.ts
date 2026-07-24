import type { ResolvedConfig } from "./config";
import type {
  CswapAccount,
  CswapListResult,
  CswapScopedWindow,
  CswapSpend,
  CswapUsageWindow,
  CswapWeeklyWindow,
} from "./cswap";

/** Pace of a WEEKLY window (7-day or per-model), normalized for display.
 *  cswap suppresses pace for 24h after a reset, so `expectedPct` is null whenever it is
 *  uncomputable — and `aheadOfPace` is noise-gated upstream (needs >=15pp over expected). */
export interface WindowPace {
  expectedPct: number | null;
  aheadOfPace: boolean;
}

/** A per-model weekly limit window (e.g. "Fable"), normalized for display. */
export interface ScopedWindow extends WindowPace {
  name: string;
  pct: number;
  resetsAt: string | null;
  resetClock: string | null;
  resetCountdown: string | null;
}

/** Pay-as-you-go spend, normalized for display. Absent entirely when the account has no
 *  such plan — that is "no plan", not "unknown", so it renders nothing rather than "n/a".
 *  DISPLAY-ONLY: never affects usable / rateLimited / usageUnavailable. */
export interface SpendInfo {
  used: number;
  limit: number;
  pct: number;
  currency: string;
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
  /** Held out of rotation by `cswap disable` (read-only; released only by `cswap enable`).
   *  Populated on EVERY classification path — including the non-ok `usageStatus` short-circuit —
   *  so `Prewarmer.inScope()` and the panel can trust it without re-deriving anything. */
  cswapDisabled: boolean;
  /** Short operator-set label from `cswap alias` (0.21+). Null when unset. Rendered IN ADDITION
   *  to the email, never instead of it — the email is what maps a row to its on-disk profile. */
  alias: string | null;
  organizationName: string | null;
  /** Age of the usage measurement AT CSWAP'S EMIT TIME (0.23+), not since our last poll. */
  usageAgeSeconds: number | null;
  /** Display-only pay-as-you-go budget; null when the account has no such plan. */
  spend: SpendInfo | null;
  /** Display-only pace of the 7-day window. */
  sevenDayPace: WindowPace;
  // Display-only: per-model weekly windows (e.g. Fable). Never affects usable/rateLimited/usageUnavailable.
  scopedWindows: ScopedWindow[];
}

/**
 * Classify every account row from a --list result into the pool, honoring config.
 * api_key/token_expired/no_credentials/unavailable → usable:false with reason.
 * include/exclude slots filter membership.
 *
 * `outOfRotation` is the runtime, operator-driven exclusion set (durable, seeded from plugin
 * state — the UI "Take out of rotation" toggle). It is applied AFTER the static `excludeSlots`
 * branch, so a config-excluded account keeps its more-specific `excluded-slot` reason; a member of
 * this set is marked `usable:false, reason:"out-of-rotation"`, mirroring `excluded-slot` exactly.
 *
 * `cswap disable <n>` (cswap 0.21+) is honored READ-ONLY as a second, independent gate with its own
 * `reason:"cswap-disabled"`. It is checked BEFORE `outOfRotation` deliberately: when both are set,
 * the gate the panel cannot release is the honest one to report, and once `cswap enable <n>` clears
 * it the row falls through to `out-of-rotation` with its working button. The plugin never writes
 * cswap's flag — each gate is released where it was set.
 */
/** One 5h/7d window's normalized display fields. Absent window ⇒ every field null. */
function windowDisplay(w: CswapUsageWindow | undefined): {
  pct: number | null;
  resetsAt: string | null;
  clock: string | null;
  countdown: string | null;
} {
  return {
    pct: w?.pct ?? null,
    resetsAt: w?.resetsAt ?? null,
    clock: w?.clock ?? null,
    countdown: w?.countdown ?? null,
  };
}

/** Pace fields of a weekly window. Absent/uncomputable ⇒ null expected, not-ahead. */
function windowPace(w: CswapWeeklyWindow | undefined): WindowPace {
  return { expectedPct: w?.expectedPct ?? null, aheadOfPace: w?.aheadOfPace === true };
}

/** Per-model weekly windows, normalized for display. Display-only — never affects usability. */
function toScopedWindows(scoped: CswapScopedWindow[] | undefined): ScopedWindow[] {
  return (scoped ?? []).map((w) => ({
    name: w.name,
    pct: w.pct,
    resetsAt: w.resetsAt ?? null,
    resetClock: w.clock ?? null,
    resetCountdown: w.countdown ?? null,
    ...windowPace(w),
  }));
}

/** Pay-as-you-go spend, normalized. Null when cswap reports no plan (unlimited plans are
 *  omitted upstream, so `limit` is never a meaningless 0 here). */
function toSpend(spend: CswapSpend | undefined): SpendInfo | null {
  if (spend === undefined) return null;
  return {
    used: spend.used,
    limit: spend.limit,
    // cswap's own `utilization`, NOT used/limit — a live account reports 100.33/100.00 at pct 100.
    pct: spend.pct,
    currency: spend.currency,
    resetsAt: spend.resetsAt ?? null,
    resetClock: spend.clock ?? null,
    resetCountdown: spend.countdown ?? null,
  };
}

/** At/over the configured limit on either window. A null pct never trips it. */
function isRateLimited(
  fivePct: number | null,
  sevenPct: number | null,
  rateLimitPct: number,
): boolean {
  return (
    (fivePct !== null && fivePct >= rateLimitPct) || (sevenPct !== null && sevenPct >= rateLimitPct)
  );
}

/** The usability verdict for one account: the ordered gate chain, first match wins. */
function classifyVerdict(
  acct: CswapAccount,
  cfg: ResolvedConfig,
  outOfRotation: Set<number>,
  fivePct: number | null,
  sevenPct: number | null,
): Pick<PoolAccount, "usable" | "rateLimited" | "reason" | "usageUnavailable"> {
  const unusable = (reason: string) => ({
    usable: false,
    rateLimited: false,
    reason,
    usageUnavailable: false,
  });

  // Non-ok usageStatus: unusable, reason = status value.
  if (acct.usageStatus !== "ok") return unusable(acct.usageStatus);

  // Excluded by excludeSlots.
  if (cfg.excludeSlots.includes(acct.number)) return unusable("excluded-slot");

  // Held out of rotation by cswap itself (`cswap disable`). Checked before the plugin's own
  // toggle so the gate requiring `cswap enable` is the one reported while both are set.
  if (acct.disabled === true) return unusable("cswap-disabled");

  // Taken out of rotation at runtime (operator toggle). Applied after excludeSlots so a
  // config-excluded account keeps its `excluded-slot` reason.
  if (outOfRotation.has(acct.number)) return unusable("out-of-rotation");

  // Not in includeSlots (when includeSlots is non-null).
  if (cfg.includeSlots !== null && !cfg.includeSlots.includes(acct.number)) {
    return unusable("not-in-include");
  }

  return {
    usable: true,
    rateLimited: isRateLimited(fivePct, sevenPct, cfg.rateLimitPct),
    reason: null,
    usageUnavailable: fivePct === null && sevenPct === null,
  };
}

export function classifyPool(
  list: CswapListResult,
  cfg: ResolvedConfig,
  outOfRotation: Set<number> = new Set(),
): PoolAccount[] {
  return list.accounts.map((acct) => {
    const five = windowDisplay(acct.usage?.fiveHour);
    const seven = windowDisplay(acct.usage?.sevenDay);
    return {
      number: acct.number,
      email: acct.email,
      fiveHourPct: five.pct,
      sevenDayPct: seven.pct,
      fiveHourResetsAt: five.resetsAt,
      sevenDayResetsAt: seven.resetsAt,
      fiveHourResetClock: five.clock,
      sevenDayResetClock: seven.clock,
      fiveHourResetCountdown: five.countdown,
      sevenDayResetCountdown: seven.countdown,
      active: acct.active,
      // Read off the raw row, so EVERY verdict — including the non-ok usageStatus short-circuit
      // above the cswap-disabled gate — carries it. `inScope()` and the panel marker depend on
      // that: a parked account whose usage fetch failed must still read as parked.
      cswapDisabled: acct.disabled === true,
      alias: acct.alias ?? null,
      organizationName: acct.organizationName ?? null,
      usageAgeSeconds: acct.usageAgeSeconds ?? null,
      spend: toSpend(acct.usage?.spend),
      sevenDayPace: windowPace(acct.usage?.sevenDay),
      scopedWindows: toScopedWindows(acct.usage?.scoped),
      ...classifyVerdict(acct, cfg, outOfRotation, five.pct, seven.pct),
    };
  });
}
