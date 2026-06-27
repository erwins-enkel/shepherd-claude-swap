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
import { cswapBackupRoot, sessionProfileDir } from "./src/paths";
import { assign, type SelectionState } from "./src/selection";
import { buildStatus, type LastSpawn } from "./src/status";
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

  const prewarmer = new Prewarmer({
    cswap,
    cfg,
    log: ctx.log,
    onChange: () => publish(),
  });

  const publish = (): void => {
    ctx.publishStatus(buildStatus(cfg, prewarmer.pool, prewarmer.ready, state, lastSpawn));
  };

  // ── Boot: list the pool, then await boot-warm of ≥1 account (the spawn-acceptance gate).
  await prewarmer.refresh();
  await prewarmer.bootWarm();

  // ── Background: refresh the pool + warm usable-not-ready accounts on a fixed tick.
  const tick = async (): Promise<void> => {
    await prewarmer.refresh();
    prewarmer.warmStale();
  };
  const intervalHandle = setIntervalFn(() => {
    void tick();
  }, cfg.refreshIntervalMs);

  // ── Hot path: cheap in-memory selection + synchronous state persist. NO I/O.
  ctx.onSpawn((d): SpawnPatch | void => {
    const result = assign(state, d.sessionId, prewarmer.pool, prewarmer.ready);

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
      publish();
      return { credentialDir };
    }

    if (result.kind === "warm") {
      // Resume of a pinned account whose profile isn't ready yet: kick a background warm
      // (fire-and-forget — never await on the hot path) and refuse this attempt cleanly.
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
    Response.json(buildStatus(cfg, prewarmer.pool, prewarmer.ready, state, lastSpawn)),
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

  // ── Teardown.
  return () => {
    clearIntervalFn(intervalHandle);
    void prewarmer.drain();
  };
}

export default register;
