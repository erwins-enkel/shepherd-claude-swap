import type { PluginLogger } from "../types";
import type { ResolvedConfig } from "./config";
import type { Cswap } from "./cswap";
import { classifyPool, type PoolAccount } from "./accounts";

export interface PrewarmerDeps {
  cswap: Cswap;
  cfg: ResolvedConfig;
  log: PluginLogger;
  /** Called after every refresh (success or failure) so the host can re-publish status. */
  onChange?: () => void;
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

  private readonly cswap: Cswap;
  private readonly cfg: ResolvedConfig;
  private readonly log: PluginLogger;
  private readonly onChange?: () => void;
  /** De-dupes concurrent warms of the same account. */
  private readonly inFlight = new Map<number, Promise<void>>();

  constructor(deps: PrewarmerDeps) {
    this.cswap = deps.cswap;
    this.cfg = deps.cfg;
    this.log = deps.log;
    this.onChange = deps.onChange;
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
        const acct = this.pool.find((a) => a.number === n);
        if (!acct || !acct.usable || acct.rateLimited) {
          this.ready.delete(n);
        }
      }
    } catch (err) {
      this.log.warn("cswap --list refresh failed; keeping last snapshot:", String(err));
    }
    this.onChange?.();
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
      if (res.ok) {
        this.ready.add(accountNumber);
      } else {
        this.log.warn(`prewarm of account ${accountNumber} failed: ${res.error ?? "unknown"}`);
      }
    })().finally(() => {
      this.inFlight.delete(accountNumber);
    });

    this.inFlight.set(accountNumber, p);
    return p;
  }

  /** Warm every usable, non-rate-limited account that is not yet ready (fire-and-forget). */
  warmStale(): void {
    for (const acct of this.pool) {
      if (acct.usable && !acct.rateLimited && !this.ready.has(acct.number)) {
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
    const candidates = this.pool.filter(
      (a) => a.usable && !a.rateLimited && !this.ready.has(a.number),
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
