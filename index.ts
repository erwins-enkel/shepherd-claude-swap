// ─────────────────────────────────────────────────────────────────────────────
// claude-swap — Shepherd plugin entry. `register(ctx)` wires config → cswap → pool
// → selection → status, gates spawn acceptance on boot-warm of ≥1 account, and
// registers the `onSpawn` hook + `GET stats` / `POST reset` routes.
//
// Hot-path discipline: `onSpawn` does CHEAP in-memory selection + a SYNCHRONOUS
// `ctx.state.set` only — NO cswap / network / fs I/O. All listing + profile warming
// happens at boot or on the background interval (see `src/prewarm.ts`).
// ─────────────────────────────────────────────────────────────────────────────

import type { PluginContext, SpawnPatch } from "./types";
import { parseConfig } from "./src/config";
import { Cswap, type Runner } from "./src/cswap";
import { History } from "./src/history";
import { cswapBackupRoot, sessionProfileDir } from "./src/paths";
import { assign, type SelectionState } from "./src/selection";
import { buildStatus, type LastSpawn } from "./src/status";
import { buildUIView } from "./src/ui-view";
import { Prewarmer } from "./src/prewarm";

/** Optional injected dependencies — the testability seam. Shepherd calls `register(ctx)`
 *  (deps undefined → real defaults); tests inject a fake runner/timers/clock. */
export interface PluginDeps {
  /** Injected into `Cswap`. Default = real `execFile` runner. */
  runner?: Runner;
  /** Default = unref'd `globalThis.setInterval` (background loop never blocks teardown). */
  setInterval?: (fn: () => void, ms: number) => unknown;
  /** Default = `globalThis.clearInterval`. */
  clearInterval?: (handle: unknown) => void;
  /** `lastSpawn` timestamp source. Default = `() => new Date().toISOString()`. */
  now?: () => string;
  /** Injected into `Prewarmer` for the warm-time profile-dir guard. Default = real `fs.existsSync`. */
  existsSync?: (path: string) => boolean;
}

const defaultSetInterval: NonNullable<PluginDeps["setInterval"]> = (fn, ms) => {
  const handle = setInterval(fn, ms);
  // Never let the background loop keep the process alive / block teardown.
  (handle as { unref?: () => void }).unref?.();
  return handle;
};

/**
 * Plugin entry. Returns a teardown that clears the background interval and best-effort
 * awaits in-flight warms. `register` runs BEFORE Shepherd serves HTTP, so awaiting the
 * boot-warm gate here is what makes spawn acceptance safe (no create-rollback window).
 */
export async function register(ctx: PluginContext, deps?: PluginDeps): Promise<() => void> {
  const cfg = parseConfig(ctx.config);
  const cswap = new Cswap(cfg.cswapBin, deps?.runner);
  const backupRoot = cswapBackupRoot();
  const now = deps?.now ?? (() => new Date().toISOString());
  const setIntervalFn = deps?.setInterval ?? defaultSetInterval;
  const clearIntervalFn = deps?.clearInterval ?? ((h: unknown) => clearInterval(h as number));

  // Seed in-memory selection state from durable plugin state (defaults on first boot).
  const state: SelectionState = {
    cursor: ctx.state.get<number>("cursor") ?? 0,
    assignments: ctx.state.get<Record<string, number>>("assignments") ?? {},
  };
  let lastSpawn: LastSpawn | null = null;
  const history = new History();

  const prewarmer = new Prewarmer({
    cswap,
    cfg,
    log: ctx.log,
    backupRoot,
    onChange: () => publish(),
    existsSync: deps?.existsSync,
  });

  const publish = (): void => {
    ctx.publishStatus(
      buildStatus(cfg, prewarmer.pool, prewarmer.ready, state, lastSpawn, prewarmer.lastError),
    );
    if (typeof ctx.publishUI === "function") {
      ctx.publishUI(
        buildUIView(
          cfg,
          prewarmer.pool,
          prewarmer.ready,
          state,
          lastSpawn,
          prewarmer.lastError,
          history,
        ),
      );
    }
  };

  // ── Boot: list the pool, then await boot-warm of ≥1 account (the spawn-acceptance gate).
  await prewarmer.refresh();
  history.recordQuota(prewarmer.pool);
  await prewarmer.bootWarm();

  // ── Background: refresh the pool + warm usable-not-ready accounts on a fixed tick.
  const tick = async (): Promise<void> => {
    await prewarmer.refresh();
    prewarmer.warmStale();
    history.recordQuota(prewarmer.pool);
    publish();
  };
  const intervalHandle = setIntervalFn(() => {
    void tick();
  }, cfg.refreshIntervalMs);

  // ── Hot path: cheap in-memory selection + synchronous state persist. NO I/O.
  ctx.onSpawn((d): SpawnPatch | void => {
    const result = assign(state, d.sessionId, prewarmer.pool, prewarmer.ready, cfg.strategy);

    if (result.kind === "assigned") {
      // Persist the pin + cursor durably BEFORE returning the patch (sync `state.set`).
      state.cursor = result.nextState.cursor;
      state.assignments = result.nextState.assignments;
      ctx.state.set("cursor", state.cursor);
      ctx.state.set("assignments", state.assignments);

      const acct = prewarmer.pool.find((a) => a.number === result.accountNumber);
      // `assign` only returns "assigned" for an account present in the pool.
      const email = acct?.email ?? "";
      const credentialDir = sessionProfileDir(backupRoot, result.accountNumber, email);
      lastSpawn = {
        sessionId: d.sessionId,
        accountNumber: result.accountNumber,
        credentialDir,
        at: now(),
      };
      history.recordSpawn({
        sessionId: d.sessionId,
        accountNumber: result.accountNumber,
        at: lastSpawn.at,
      });
      publish();
      return { credentialDir };
    }

    if (result.kind === "warm") {
      // Resume of a pinned account whose profile isn't ready yet: kick a background warm
      // (fire-and-forget — never await on the hot path) and refuse this attempt cleanly.
      // Intentional asymmetry: a resume aborts regardless of `abortOnEmpty` — it must never
      // fail open onto the default login (would silently rotate a running session's identity).
      void prewarmer.warm(result.accountNumber);
      ctx.abortSpawn(`account ${result.accountNumber} warming; retry resume`);
    }

    // abort
    if (cfg.abortOnEmpty) {
      ctx.abortSpawn(result.reason);
    }
    ctx.log.warn(`spawn allowed fail-open (no usable account): ${result.reason}`);
    return {};
  });

  // ── Routes (under /api/plugins/claude-swap/…).
  ctx.route("GET", "stats", () =>
    Response.json(
      buildStatus(cfg, prewarmer.pool, prewarmer.ready, state, lastSpawn, prewarmer.lastError),
    ),
  );
  ctx.route("POST", "reset", () => {
    state.cursor = 0;
    state.assignments = {};
    ctx.state.set("cursor", 0);
    ctx.state.set("assignments", {});
    publish();
    return Response.json({ ok: true, cleared: true });
  });

  // Initial status snapshot.
  publish();

  // ── Gear-menu item (issue #1202): one-click into the usage view rendered via `publishUI`
  // in Settings → Plugins. Additive — guard so the plugin still loads on older Shepherd builds.
  if (typeof ctx.publishGearItem === "function") {
    ctx.publishGearItem({ label: "Claude swap usage", icon: "▦", action: { kind: "panel" } });
  }

  // ── Teardown.
  return () => {
    clearIntervalFn(intervalHandle);
    void prewarmer.drain();
  };
}

export default register;
