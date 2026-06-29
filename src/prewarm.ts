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

  private readonly cswap: Cswap;
  private readonly cfg: ResolvedConfig;
  private readonly log: PluginLogger;
  private readonly backupRoot: string;
  private readonly onChange?: () => void;
  private readonly existsSync: (path: string) => boolean;
  /** De-dupes concurrent warms of the same account. */
  private readonly inFlight = new Map<number, Promise<void>>();
  private switching = false;

  constructor(deps: PrewarmerDeps) {
    this.cswap = deps.cswap;
    this.cfg = deps.cfg;
    this.log = deps.log;
    this.backupRoot = deps.backupRoot;
    this.onChange = deps.onChange;
    this.existsSync = deps.existsSync ?? fsExistsSync;
  }

  /**
   * `cswap --list --json` → classify → replace `pool`; prune `ready` entries that are no
   * longer usable (gone / non-ok / excluded / rate-limited). On error: log + keep the last
   * good snapshot (never throws out of the background loop).
   */
  async refresh(): Promise<void> {
    try {
      const list = await this.cswap.list();
      this.pool = classifyPool(list, this.cfg);
      for (const n of [...this.ready]) {
        if (isUnassignable(this.pool.find((a) => a.number === n))) {
          this.ready.delete(n);
        }
      }
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
