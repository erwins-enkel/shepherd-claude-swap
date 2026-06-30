// ─────────────────────────────────────────────────────────────────────────────
// claude-swap — Shepherd plugin entry. `register(ctx)` wires config → cswap → pool
// → selection → status, gates spawn acceptance on boot-warm of ≥1 account, and
// registers the `onSpawn` hook + `GET stats` / `POST reset` routes.
//
// Hot-path discipline: `onSpawn` does CHEAP in-memory selection + a SYNCHRONOUS
// `ctx.state.set` only — NO cswap / network / fs I/O. All listing + profile warming
// happens at boot or on the background interval (see `src/prewarm.ts`).
// ─────────────────────────────────────────────────────────────────────────────

import type { PluginContext, SpawnDescriptor, SpawnPatch } from "./types";
import { parseConfig, type Strategy } from "./src/config";
import type { PoolAccount } from "./src/accounts";
import { Cswap, type Runner, type CswapSwitchResult } from "./src/cswap";
import { History } from "./src/history";
import { cswapBackupRoot, sessionProfileDir } from "./src/paths";
import { assign, type SelectionState } from "./src/selection";
import { buildStatus, type LastSpawn } from "./src/status";
import { buildUIView } from "./src/ui-view";
import { Prewarmer } from "./src/prewarm";
import type { HealRestoreFailure } from "./src/prewarm";

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

type SwitchPrimaryParsed =
  | { ok: false; response: Response }
  | { ok: true; mode: "specific" | "next" | "best"; account: number | string | undefined };

/** Parse + validate the POST switch-primary body. Returns ok:false with a ready 4xx Response on error. */
function parseSwitchPrimaryBody(body: unknown): SwitchPrimaryParsed {
  const b = (body ?? {}) as Record<string, unknown>;
  const mode = b["mode"];
  if (mode !== "specific" && mode !== "next" && mode !== "best") {
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: 'invalid "mode": expected "specific" | "next" | "best"' },
        { status: 400 },
      ),
    };
  }
  if (mode === "specific") {
    const acct = b["account"];
    if (typeof acct !== "number" && !(typeof acct === "string" && acct.length > 0)) {
      return {
        ok: false,
        response: Response.json(
          { ok: false, error: 'mode "specific" requires "account" (number or non-empty string)' },
          { status: 400 },
        ),
      };
    }
    return { ok: true, mode, account: acct as number | string };
  }
  return { ok: true, mode, account: undefined };
}

/**
 * Prep `ready` then invoke the cswap switch for the given mode. The `ready` mutation is
 * synchronous and runs BEFORE the cswap call (the caller invokes this immediately after
 * `beginSwitch()`, with no `await` between), so the switch↔onSpawn race stays closed:
 * specific-by-number drops only the target (other accounts stay assignable); a string/email
 * target or next/best clears the whole set (target number unknown / unsafe to resolve).
 */
function executeSwitch(
  prewarmer: Prewarmer,
  cswap: Cswap,
  mode: "specific" | "next" | "best",
  account: number | string | undefined,
): Promise<CswapSwitchResult> {
  if (mode === "specific" && typeof account === "number") {
    prewarmer.dropReady(account);
  } else {
    prewarmer.clearReady();
  }
  if (mode === "specific") return cswap.switchTo(account as number | string);
  if (mode === "best") return cswap.switch("best");
  return cswap.switch(); // "next" → plain rotation
}

/** 24h window (ms): a 7-day reset landing inside it is "soon" for the `reset-soon` strategy. */
const RESET_SOON_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Headroom (percentage points below `rateLimitPct`) the SHORT 5-hour window must keep for an
 * account to count as imminent. `reset-soon` funnels every new session onto the imminent account;
 * the 5h window does NOT reset soon, so a near-limit funnel target would be driven straight into a
 * 5h rate-limit (then unusable for up to 5h). The 7-day (resetting) window gets NO such margin —
 * plain eligibility (`sevenDayPct < rateLimitPct`) — so an account with real 7d capacity still
 * wins, and an over-limit one self-corrects via `classifyPool`'s `rateLimited` flag next refresh.
 */
const FIVE_HOUR_HEADROOM_PP = 10;

/**
 * Account numbers the `reset-soon` strategy should FAVOR: the 7-day window resets within 24h
 * (future) AND still has capacity (`sevenDayPct < rateLimitPct`) AND the 5-hour window keeps
 * `FIVE_HOUR_HEADROOM_PP` headroom below the limit. Pure — the clock is supplied as `nowMs` (epoch
 * ms) and `Date.parse` of the stored ISO `resetsAt` is deterministic, so `selection.ts` stays
 * Date-free. `null` pct, or an unparseable / past / `null` `resetsAt`, → not imminent.
 */
export function computeImminent(
  pool: PoolAccount[],
  nowMs: number,
  rateLimitPct: number,
): Set<number> {
  const imminent = new Set<number>();
  for (const a of pool) {
    if (a.sevenDayResetsAt === null) continue;
    const resetMs = Date.parse(a.sevenDayResetsAt);
    if (!Number.isFinite(resetMs)) continue;
    if (!(resetMs > nowMs && resetMs - nowMs < RESET_SOON_WINDOW_MS)) continue;
    if (a.sevenDayPct === null || a.sevenDayPct >= rateLimitPct) continue;
    if (a.fiveHourPct === null || a.fiveHourPct > rateLimitPct - FIVE_HOUR_HEADROOM_PP) continue;
    imminent.add(a.number);
  }
  return imminent;
}

/**
 * Route an aux (review / plan-gate / doc) spawn without aborting, updating lastSpawn,
 * or touching history. Called from `onSpawn` when `kind !== "session"` AND `cfg.routeAuxQuota`
 * is set (a host whose reviewer sandbox binds a plugin-patched credentialDir — shepherd#1217+).
 *
 * - `parentSessionId` present (review / plan-gate): inherit the parent session's pinned
 *   account. Falls open (`{}`) if the parent is untracked or its account is gone.
 * - `parentSessionId` absent (doc / standalone critic): route to a pool account
 *   EPHEMERALLY — `assign` result is used for the credentialDir only; `nextState` is
 *   discarded (no cursor advance, no durable pin). Falls open if none eligible.
 * Never calls `ctx.abortSpawn`.
 */
function auxSpawnPatch(
  d: SpawnDescriptor,
  state: SelectionState,
  pool: PoolAccount[],
  ready: Set<number>,
  backupRoot: string,
  strategy: Strategy,
  imminent: Set<number>,
): SpawnPatch | void {
  // review / plan-gate: keep the aux spawn on the parent session's account.
  if (d.parentSessionId !== undefined) {
    const pin = state.assignments[d.parentSessionId];
    if (pin !== undefined) {
      const acct = pool.find((a) => a.number === pin);
      if (acct !== undefined) {
        return { credentialDir: sessionProfileDir(backupRoot, pin, acct.email) };
      }
    }
    return {}; // parent untracked / gone from pool → fall open, never abort
  }
  // session-less aux (doc-agent / standalone critic): route to a pool account
  // EPHEMERALLY (no durable pin, no cursor persist); fall open if none eligible.
  const result = assign(state, d.sessionId, pool, ready, strategy, imminent);
  if (result.kind === "assigned") {
    const acct = pool.find((a) => a.number === result.accountNumber);
    const email = acct?.email ?? "";
    return { credentialDir: sessionProfileDir(backupRoot, result.accountNumber, email) };
  }
  return {}; // warm / abort → never block an aux spawn
}

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

  // Never let a throwing ctx.state write escape into the heal engine's background loop.
  const persistRestoreFailure = (info: HealRestoreFailure | null): void => {
    try {
      ctx.state.set("healRestoreFailure", info);
    } catch (err) {
      ctx.log.warn("failed to persist healRestoreFailure:", String(err));
    }
  };

  let initialRestoreFailure: HealRestoreFailure | null = null;
  try {
    initialRestoreFailure = ctx.state.get<HealRestoreFailure>("healRestoreFailure") ?? null;
  } catch {
    // Malformed state — default to null; don't break register.
  }

  const prewarmer = new Prewarmer({
    cswap,
    cfg,
    log: ctx.log,
    backupRoot,
    onChange: () => publish(),
    existsSync: deps?.existsSync,
    now,
    onRestoreFailure: (info) => persistRestoreFailure(info),
    onRestoreRecovered: () => persistRestoreFailure(null),
    initialRestoreFailure,
  });

  const publish = (): void => {
    ctx.publishStatus(
      buildStatus(
        cfg,
        prewarmer.pool,
        prewarmer.ready,
        state,
        lastSpawn,
        prewarmer.lastError,
        prewarmer.lastHeal,
        prewarmer.restoreFailure,
      ),
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
          prewarmer.lastHeal,
          prewarmer.restoreFailure,
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
    if (prewarmer.isSwitching) return; // don't race an in-flight operator switch
    await prewarmer.refresh();
    await prewarmer.healUnavailable();
    prewarmer.warmStale();
    history.recordQuota(prewarmer.pool);
    publish();
  };
  const intervalHandle = setIntervalFn(() => {
    void tick();
  }, cfg.refreshIntervalMs);

  // ── Hot path: cheap in-memory selection + synchronous state persist. NO I/O.
  ctx.onSpawn((d): SpawnPatch | void => {
    // Aux spawns (review / plan-gate / doc / standalone critic — shepherd#1205) fire onSpawn so a
    // plugin can route their quota onto a pool account. shepherd#1217 binds a plugin-patched
    // credentialDir INTO the reviewer sandbox (validate-and-fail-open), so a routed pool dir yields
    // an authenticated reviewer — re-enabling the routing that #25 had to disable. We gate this on
    // `routeAuxQuota` because #1217 exposes no probe-able capability surface: on a host predating
    // #1217 the patched dir is never mounted → an UNAUTHENTICATED reviewer (re-login + theme
    // prompt), so an operator on such a host MUST set `routeAuxQuota: false` (pass-through, the #25
    // behavior). Either way an aux spawn is NEVER aborted — a refused review is terminal (no
    // held-retry). See README (aux-spawn section) for the default-true override + version caveat.
    // `reset-soon` reads the clock once here (keeping `assign` Date-free) and uses the same
    // imminent set for the main spawn and any session-less aux route below.
    const imminent = computeImminent(prewarmer.pool, Date.parse(now()), cfg.rateLimitPct);

    const kind = d.kind ?? "session";
    if (kind !== "session") {
      if (!cfg.routeAuxQuota) return; // pass-through: leave aux on the sandbox-bound active account
      return auxSpawnPatch(
        d,
        state,
        prewarmer.pool,
        prewarmer.ready,
        backupRoot,
        cfg.strategy,
        imminent,
      );
    }

    const result = assign(
      state,
      d.sessionId,
      prewarmer.pool,
      prewarmer.ready,
      cfg.strategy,
      imminent,
    );

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
      buildStatus(
        cfg,
        prewarmer.pool,
        prewarmer.ready,
        state,
        lastSpawn,
        prewarmer.lastError,
        prewarmer.lastHeal,
        prewarmer.restoreFailure,
      ),
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
  ctx.route("POST", "switch-primary", async (req): Promise<Response> => {
    // Body-parse guard — malformed/missing body fails closed (distinct from the switch try/catch).
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
    }
    const parsed = parseSwitchPrimaryBody(body);
    if (!parsed.ok) return parsed.response;
    const { mode, account } = parsed;

    // Reject concurrent switches. beginSwitch/endSwitch is a non-reentrant boolean, so a second
    // in-flight switch would let the first's `finally` clear `switching` while the second's cswap
    // subprocess is still running — re-enabling the tick/warmStale mid-switch and reopening the
    // race. The single event loop + no `await` between this check and beginSwitch() below makes the
    // claim atomic, so only one switch can hold the guard at a time.
    if (prewarmer.isSwitching) {
      return Response.json(
        { ok: false, error: "a primary switch is already in progress" },
        { status: 409 },
      );
    }

    // Operator-triggered global switch — NEVER on the onSpawn hot path. The Prewarmer guard +
    // ready clear/drop (in executeSwitch) close the switch↔onSpawn race; the tick is gated above.
    prewarmer.beginSwitch();
    try {
      const result = await executeSwitch(prewarmer, cswap, mode, account);
      await prewarmer.refresh(); // re-classify (new active pruned by its active flag); publishes via onChange
      return Response.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log.warn(`switch-primary failed: ${msg}`);
      return Response.json({ ok: false, error: msg }, { status: 500 });
    } finally {
      prewarmer.endSwitch();
      prewarmer.warmStale(); // rebuild ready on success AND failure; must run after endSwitch()
    }
  });

  // Initial status snapshot.
  publish();

  // ── Gear-menu item (claude-swap#17; capability from shepherd#1202): one-click into the usage
  // view rendered via `publishUI` in Settings → Plugins. Additive — guard so the plugin still
  // loads on older Shepherd builds.
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
