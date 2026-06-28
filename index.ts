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
import { Cswap, type Runner, type CswapSwitchResult } from "./src/cswap";
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
    if (prewarmer.isSwitching) return; // don't race an in-flight operator switch
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
