import { existsSync as fsExistsSync } from "node:fs";
import path from "node:path";
import type { PluginLogger } from "../types";
import type { ResolvedConfig } from "./config";
import type { Cswap } from "./cswap";
import { classifyPool, type PoolAccount } from "./accounts";
import { sessionProfileDir } from "./paths";

/** Returns true if an account should NOT remain in the ready set (gone, unusable, rate-limited, or now active). */
function isUnassignable(acct: PoolAccount | undefined): boolean {
  return !acct || !acct.usable || acct.rateLimited || acct.active;
}

/** Outcome of one auto-heal attempt, for status/observability. */
export interface HealRecord {
  at: string;
  target: number;
  outcome: "healed" | "failed";
  restoreFailed: boolean;
}

/** Durable marker that a heal's restore left the primary on the wrong account. */
export interface HealRestoreFailure {
  at: string;
  intendedActive: number;
  landedActive: number | null;
}

export interface PrewarmerDeps {
  cswap: Cswap;
  cfg: ResolvedConfig;
  log: PluginLogger;
  /** cswap backup root — used to derive the session-profile dir for the warm-time guard. */
  backupRoot: string;
  /** Called after every refresh (success or failure) so the host can re-publish status. */
  onChange?: () => void;
  /** Injectable fs-exists check (warm-time only, never on the hot path). Default `fs.existsSync`. */
  existsSync?: (path: string) => boolean;
  /** Runtime out-of-rotation set (operator toggle), shared BY REFERENCE with the owner (index.ts):
   *  the route mutates this same object, so `refresh()` classification and `inScope` observe toggles
   *  immediately. Default: a fresh empty set (nothing taken out). */
  outOfRotation?: Set<number>;
  /** Timestamp source for heal records. Default `() => new Date().toISOString()`. */
  now?: () => string;
  /** Called when a restore (switch back to the prior primary) is determined to have failed. */
  onRestoreFailure?: (info: HealRestoreFailure) => void;
  /** Called when a previously-recorded restore failure clears (active is the intended primary again). */
  onRestoreRecovered?: () => void;
  /** Seed `restoreFailure` from durable state on boot. Default null. */
  initialRestoreFailure?: HealRestoreFailure | null;
}

/**
 * Out-of-band pool/readiness machinery, kept out of `index.ts` so the entry stays focused.
 *
 * Owns the shared in-memory snapshot (`pool`) and the pre-warmed `ready` set. All `cswap`
 * (list + prewarm) I/O lives here and runs at boot or on the background interval — NEVER on
 * the `onSpawn` hot path. The background loop never throws: errors are logged and the last
 * good snapshot is kept.
 */
export class Prewarmer {
  /** Latest classified pool snapshot. Replaced wholesale on a successful refresh. */
  pool: PoolAccount[] = [];
  /** Account numbers whose session profile is pre-warmed and ready to assign. */
  readonly ready: Set<number> = new Set();
  /** Last `list()` error message (set on refresh failure, cleared on success) for diagnosability. */
  lastError: string | null = null;
  /** Active ("primary") account number from the last successful refresh (undefined until first ok refresh). */
  activeAccountNumber: number | undefined = undefined;
  /** Last heal attempt outcome, for status/observability. */
  lastHeal: HealRecord | null = null;
  /** Durable restore-failure flag: primary may be on the wrong account. null when healthy. */
  restoreFailure: HealRestoreFailure | null = null;

  private readonly cswap: Cswap;
  private readonly cfg: ResolvedConfig;
  private readonly log: PluginLogger;
  private readonly backupRoot: string;
  private readonly onChange?: () => void;
  private readonly existsSync: (path: string) => boolean;
  /** Shared-by-reference runtime out-of-rotation set (see PrewarmerDeps.outOfRotation). */
  private readonly outOfRotation: Set<number>;
  private readonly now: () => string;
  private readonly onRestoreFailure?: (info: HealRestoreFailure) => void;
  private readonly onRestoreRecovered?: () => void;
  /** Per-account heal tracking: consecutive-unavailable streak + whether we've attempted this episode. */
  private readonly healState = new Map<
    number,
    { unavailableStreak: number; attemptedThisEpisode: boolean }
  >();
  /** De-dupes concurrent warms of the same account. */
  private readonly inFlight = new Map<number, Promise<void>>();
  /** A heal attempt awaiting outcome reconciliation against the next fresh pool (cswap's
   *  15s usage cache can make runHealDance's own post-dance read a false negative). */
  private pendingHealReconcile: { target: number } | null = null;
  private switching = false;

  constructor(deps: PrewarmerDeps) {
    this.cswap = deps.cswap;
    this.cfg = deps.cfg;
    this.log = deps.log;
    this.backupRoot = deps.backupRoot;
    this.onChange = deps.onChange;
    this.existsSync = deps.existsSync ?? fsExistsSync;
    this.outOfRotation = deps.outOfRotation ?? new Set();
    this.now = deps.now ?? (() => new Date().toISOString());
    this.onRestoreFailure = deps.onRestoreFailure;
    this.onRestoreRecovered = deps.onRestoreRecovered;
    this.restoreFailure = deps.initialRestoreFailure ?? null;
  }

  /**
   * `cswap --list --json` → classify → replace `pool`; prune `ready` entries that are no
   * longer usable (gone / non-ok / excluded / rate-limited). On error: log + keep the last
   * good snapshot (never throws out of the background loop).
   */
  async refresh(): Promise<void> {
    try {
      const list = await this.cswap.list();
      this.pool = classifyPool(list, this.cfg, this.outOfRotation);
      for (const n of [...this.ready]) {
        if (isUnassignable(this.pool.find((a) => a.number === n))) {
          this.ready.delete(n);
        }
      }
      this.activeAccountNumber = list.activeAccountNumber;
      this.maybeRecoverRestore(list.activeAccountNumber);
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log.warn("cswap --list refresh failed; keeping last snapshot:", this.lastError);
    }
    // Status publish must never escape the fire-and-forget tick / boot await.
    try {
      this.onChange?.();
    } catch (err) {
      this.log.warn("status publish during refresh threw:", String(err));
    }
  }

  /**
   * Bootstrap/validate a session profile via `cswap run <n> -- <prewarmArgs>`. On success the
   * account joins `ready`. Concurrent warms of the same account share one in-flight promise.
   */
  warm(accountNumber: number): Promise<void> {
    const existing = this.inFlight.get(accountNumber);
    if (existing) return existing;

    const p = (async () => {
      const res = await this.cswap.prewarm(
        accountNumber,
        this.cfg.prewarmArgs,
        this.cfg.bootWarmTimeoutMs,
      );
      if (!res.ok) {
        this.log.warn(`prewarm of account ${accountNumber} failed: ${res.error ?? "unknown"}`);
        return;
      }
      // Warm-time guard (PRD §9): only mark ready if the resolved profile dir holds materialized
      // OAuth credentials (`.credentials.json`), so `onSpawn` never injects a credential-incomplete
      // credentialDir — under shepherd#1217 the routed dir is hard-bound into the reviewer sandbox,
      // so a dir present but missing `.credentials.json` would yield an UNAUTHENTICATED reviewer.
      // No warm→check race: `cswap run` (the prewarm) writes `.credentials.json` synchronously in
      // setup_session BEFORE exec'ing the inner command, so an exit-0 prewarm means the file is
      // already on disk. Off the hot path.
      const acct = this.pool.find((a) => a.number === accountNumber);
      if (acct === undefined) {
        this.log.warn(
          `prewarm of account ${accountNumber} ok but it is absent from the pool snapshot; not marking ready`,
        );
        return;
      }
      const dir = sessionProfileDir(this.backupRoot, accountNumber, acct.email);
      const credsPath = path.join(dir, ".credentials.json");
      if (this.existsSync(credsPath)) {
        if (this.switching) return; // suppressed during an operator switch — do NOT mark ready
        this.ready.add(accountNumber);
      } else {
        this.log.warn(
          `prewarm of account ${accountNumber} ok but credentials are absent (${credsPath}); not marking ready`,
        );
      }
    })().finally(() => {
      this.inFlight.delete(accountNumber);
    });

    this.inFlight.set(accountNumber, p);
    return p;
  }

  /** Synchronously remove one account from `ready`. */
  dropReady(accountNumber: number): void {
    this.ready.delete(accountNumber);
  }

  /** Synchronously empty `ready`. */
  clearReady(): void {
    this.ready.clear();
  }

  /** Enter a switch: suppress ready re-population until endSwitch(). */
  beginSwitch(): void {
    this.switching = true;
  }

  /** Leave a switch. */
  endSwitch(): void {
    this.switching = false;
  }

  get isSwitching(): boolean {
    return this.switching;
  }

  /** Is account `n` in scope for prewarm/heal (honors include/exclude slot config, the runtime
   *  out-of-rotation set AND cswap's own `disabled` flag)?
   *
   *  The two rotation gates are read from different places on purpose. `outOfRotation` is consulted
   *  as the shared set rather than via the pool because a taken-out account whose usageStatus is
   *  non-ok keeps its `unavailable` reason (classifyPool short-circuits before that branch), and
   *  because `refresh()` swallows `cswap --list` errors — so after a set-rotation whose follow-up
   *  refresh failed, the set is already right while the pool is stale. cswap's flag has the
   *  opposite constraint: it can only ever arrive via a list, so the last good pool is the only
   *  source, and its staleness is bounded by the refresh interval and never caused by us. */
  private inScope(n: number): boolean {
    return (
      !this.cfg.excludeSlots.includes(n) &&
      !this.outOfRotation.has(n) &&
      this.pool.find((a) => a.number === n)?.cswapDisabled !== true &&
      (this.cfg.includeSlots === null || this.cfg.includeSlots.includes(n))
    );
  }

  /**
   * Advance per-account consecutive-unavailable streaks from the current pool. Reset (and clear
   * the episode flag) for any account no longer `reason:"unavailable"`; drop entries for accounts
   * that left the pool. Called once per tick from `healUnavailable` (never from `refresh`).
   */
  private updateHealStreaks(): void {
    const present = new Set<number>();
    for (const acct of this.pool) {
      present.add(acct.number);
      if (acct.reason === "unavailable") {
        const state = this.healState.get(acct.number);
        if (state) state.unavailableStreak += 1;
        else this.healState.set(acct.number, { unavailableStreak: 1, attemptedThisEpisode: false });
      } else {
        this.healState.set(acct.number, { unavailableStreak: 0, attemptedThisEpisode: false });
      }
    }
    for (const n of [...this.healState.keys()]) {
      if (!present.has(n)) this.healState.delete(n);
    }
  }

  /** Lowest-numbered non-active, in-scope, unavailable account that's over threshold and unattempted. */
  private pickHealTarget(): PoolAccount | undefined {
    return this.pool
      .filter((a) => {
        if (a.reason !== "unavailable" || a.active || !this.inScope(a.number)) return false;
        const state = this.healState.get(a.number);
        return (
          state !== undefined &&
          state.unavailableStreak >= this.cfg.autoHealAfterCycles &&
          !state.attemptedThisEpisode
        );
      })
      .sort((a, b) => a.number - b.number)[0];
  }

  /** Clear a recorded restore failure once the intended primary is active again. */
  private maybeRecoverRestore(active: number | undefined): void {
    if (this.restoreFailure !== null && active === this.restoreFailure.intendedActive) {
      this.restoreFailure = null;
      this.onRestoreRecovered?.();
    }
  }

  /**
   * Auto-heal pass (called once per tick, AFTER refresh(), BEFORE warmStale()). Revives ONE
   * non-active in-scope account that cswap has reported usageStatus:"unavailable" for
   * `autoHealAfterCycles` consecutive refreshes: switch to the stuck account → launch one real
   * Claude session against it (cswap deliberately refuses to refresh a token while a session is
   * live, so only a real `-p` session refreshes the OAuth token) → switch back. One target per
   * tick; one attempt per unavailable episode. The heal outcome is deferred — cswap's 15s usage
   * cache can make the post-dance read a false negative, so it is reconciled on a later fresh,
   * settled tick. The stuck account is the active primary for up to `healLaunchTimeoutMs`, an
   * extended exposure/lock window: pass-through spawns can land on it, and `POST switch-primary`
   * is rejected while the switch is in progress. Never throws.
   */
  async healUnavailable(): Promise<void> {
    // Reconcile a prior attempt's outcome first — but only against a fresh, settled pool.
    // (Independent of autoHeal so a pending marker still resolves if auto-heal was disabled.)
    if (this.lastError === null && !this.switching) {
      this.reconcilePendingHeal();
    }
    if (!this.cfg.autoHeal || this.switching || this.lastError !== null) return;

    this.updateHealStreaks();

    const target = this.pickHealTarget();
    if (target === undefined) return;

    const original = this.activeAccountNumber;
    if (original === undefined) {
      this.log.warn("auto-heal: skipping; active account unknown");
      return;
    }

    // One attempt per episode, even if the dance below errors.
    const state = this.healState.get(target.number);
    if (state) state.attemptedThisEpisode = true;

    this.beginSwitch();
    try {
      await this.runHealDance(target.number, original);
    } finally {
      this.endSwitch();
    }
  }

  /**
   * The heal dance for ONE target: switch to it → launch one real Claude session against it →
   * switch back, then record the heal/restore outcome (the outcome is reconciled later).
   */
  private async runHealDance(target: number, original: number): Promise<void> {
    try {
      await this.cswap.switchTo(target);
    } catch (err) {
      this.log.warn(`auto-heal: switch to ${target} failed:`, String(err));
      // Target switch failed → primary unchanged, no restore needed.
      this.lastHeal = { at: this.now(), target, outcome: "failed", restoreFailed: false };
      return;
    }

    // A bare switch does not make cswap re-validate the account; only running a real Claude
    // session against it does (Claude Code refreshes the OAuth token cswap refused to refresh
    // while a session was live). <target> is now the active default login, so `cswap run
    // <target>` fast-paths claude under ~/.claude. Best-effort: a failed/timed-out launch
    // still proceeds to restore.
    await this.launchHealSession(target);

    await this.restorePrimary(original);
    await this.refresh(); // re-classifies pool, re-reads active, may auto-clear an old restoreFailure

    const restoreOk = this.recordRestoreOutcome(original);
    const acct = this.pool.find((a) => a.number === target);
    const healed = acct !== undefined && acct.reason !== "unavailable";
    this.lastHeal = {
      at: this.now(),
      target,
      outcome: healed ? "healed" : "failed",
      restoreFailed: !restoreOk,
    };
    // The post-dance refresh may have read cswap's 15s-cached (pre-heal) usage, so `healed`
    // can be a false negative. Defer: reconcile on the next tick's fresh, settled refresh.
    this.pendingHealReconcile = { target };
  }

  /**
   * Launch ONE real Claude session against the now-active target so cswap re-validates it:
   * `cswap run <target> -- <healLaunchArgs>` fast-paths claude under ~/.claude, and a real
   * session refreshes the OAuth token cswap would not. Best-effort and bounded by
   * `healLaunchTimeoutMs` (the runner kills a hung child); a failure is logged, not thrown —
   * the caller still restores the prior primary.
   */
  private async launchHealSession(target: number): Promise<void> {
    const res = await this.cswap.prewarm(
      target,
      this.cfg.healLaunchArgs,
      this.cfg.healLaunchTimeoutMs,
    );
    if (!res.ok) {
      this.log.warn(
        `auto-heal: claude session launch for ${target} failed: ${res.error ?? "unknown"}`,
      );
    }
  }

  /**
   * Finalize a deferred heal outcome against the current (fresh) pool. cswap caches usage for
   * ~15s, so runHealDance's own post-dance read can be a false negative; this re-judges on a
   * later tick whose refresh succeeded. Absent target → clear without judging (unobservable,
   * not failed). Only correct lastHeal if it still refers to the pending target (a newer heal
   * may have replaced it).
   */
  private reconcilePendingHeal(): void {
    const pending = this.pendingHealReconcile;
    if (pending === null) return;
    this.pendingHealReconcile = null;
    const acct = this.pool.find((a) => a.number === pending.target);
    if (acct === undefined) return;
    if (this.lastHeal === null || this.lastHeal.target !== pending.target) return;
    const healed = acct.reason !== "unavailable";
    this.lastHeal = { ...this.lastHeal, outcome: healed ? "healed" : "failed" };
  }

  /** Switch back to the prior primary; retry once if it throws. */
  private async restorePrimary(original: number): Promise<void> {
    try {
      await this.cswap.switchTo(original);
    } catch (err) {
      this.log.warn(`auto-heal: restore to ${original} threw, retrying once:`, String(err));
      try {
        await this.cswap.switchTo(original);
      } catch (err2) {
        this.log.warn(`auto-heal: restore retry to ${original} also threw:`, String(err2));
      }
    }
  }

  /**
   * Judge restore success by the ACTUAL post-dance active (not by switchTo not throwing). On a
   * mismatch, or if the post-dance refresh failed (making the active account unobservable), record
   * + broadcast a restore failure. Returns whether the restore succeeded.
   */
  private recordRestoreOutcome(original: number): boolean {
    // Post-dance refresh failed: landed account is unobservable → fail closed.
    if (this.lastError !== null) {
      this.restoreFailure = {
        at: this.now(),
        intendedActive: original,
        landedActive: null,
      };
      this.log.warn(
        `auto-heal: post-dance refresh failed; active account unknown — intended ${original}, landed unknown`,
      );
      this.onRestoreFailure?.(this.restoreFailure);
      return false;
    }
    const landed = this.activeAccountNumber;
    if (landed === original) return true;
    this.restoreFailure = {
      at: this.now(),
      intendedActive: original,
      landedActive: landed ?? null,
    };
    this.log.warn(
      `auto-heal: primary may be wrong — intended ${original}, landed ${landed ?? "unknown"}`,
    );
    this.onRestoreFailure?.(this.restoreFailure);
    return false;
  }

  /** Warm every usable, non-rate-limited account that is not yet ready (fire-and-forget). */
  warmStale(): void {
    if (this.switching) return;
    for (const acct of this.pool) {
      // Skip the active cswap account: `cswap run <active>` uses the default ~/.claude and
      // creates no isolated session profile, so warming it is futile and would spam every cycle.
      if (acct.usable && !acct.rateLimited && !acct.active && !this.ready.has(acct.number)) {
        void this.warm(acct.number);
      }
    }
  }

  /**
   * Boot gate: warm usable accounts and resolve as soon as ≥1 is ready, or once every warm
   * has settled. Each warm is individually bounded by `bootWarmTimeoutMs` (enforced by the
   * runner inside `cswap.prewarm`) and warms run concurrently, so the wait is bounded.
   * Resolves degraded (zero ready) if every warm fails — register still completes.
   */
  async bootWarm(): Promise<void> {
    if (this.ready.size > 0) return;
    // Skip the active cswap account: `cswap run <active>` uses the default ~/.claude and
    // creates no isolated session profile, so warming it at boot is futile (and the
    // interval re-warm in warmStale would otherwise retry it every cycle).
    const candidates = this.pool.filter(
      (a) => a.usable && !a.rateLimited && !a.active && !this.ready.has(a.number),
    );
    if (candidates.length === 0) return;

    const warms = candidates.map((a) => this.warm(a.number));
    await new Promise<void>((resolve) => {
      let remaining = warms.length;
      for (const w of warms) {
        void w.then(() => {
          remaining -= 1;
          if (this.ready.size > 0 || remaining === 0) resolve();
        });
      }
    });
  }

  /** Best-effort: await all in-flight warms (used during teardown). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()]);
  }
}
