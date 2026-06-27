import { describe, expect, it } from "bun:test";
import { register, type PluginDeps } from "../index";
import { PluginSpawnAborted } from "../types";
import type {
  PluginContext,
  PluginState,
  SpawnDescriptor,
  SpawnHook,
  SpawnPatch,
  PluginRouteHandler,
} from "../types";
import type { Runner } from "../src/cswap";
import fixtureRaw from "../docs/contracts/cswap-list.sample.json";

// ───────────────────────────────────────────────────────────────────────────
// Fakes
// ───────────────────────────────────────────────────────────────────────────

interface RunnerCall {
  bin: string;
  args: string[];
}

/** Fake Runner that branches on argv: `--list` returns the fixture, `run` returns
 *  a configurable prewarm result. Records every call. */
function makeFakeRunner(opts?: { prewarmOk?: boolean; listResult?: unknown }): {
  runner: Runner;
  calls: RunnerCall[];
} {
  const prewarmOk = opts?.prewarmOk ?? true;
  const listResult = opts?.listResult ?? fixtureRaw;
  const calls: RunnerCall[] = [];
  const runner: Runner = async (bin, args) => {
    calls.push({ bin, args: [...args] });
    if (args[0] === "--list") {
      return { stdout: JSON.stringify(listResult), stderr: "", code: 0, timedOut: false };
    }
    if (args[0] === "run") {
      return prewarmOk
        ? { stdout: "", stderr: "", code: 0, timedOut: false }
        : { stdout: "", stderr: "warm failed", code: 1, timedOut: false };
    }
    return { stdout: "", stderr: "", code: 0, timedOut: false };
  };
  return { runner, calls };
}

interface FakeTimer {
  fn: () => void;
  ms: number;
}

function makeFakeTimers(): {
  setIntervalFn: PluginDeps["setInterval"];
  clearIntervalFn: PluginDeps["clearInterval"];
  handles: FakeTimer[];
  cleared: unknown[];
} {
  const handles: FakeTimer[] = [];
  const cleared: unknown[] = [];
  const setIntervalFn: PluginDeps["setInterval"] = (fn, ms) => {
    const h: FakeTimer = { fn, ms };
    handles.push(h);
    return h;
  };
  const clearIntervalFn: PluginDeps["clearInterval"] = (h) => {
    cleared.push(h);
  };
  return { setIntervalFn, clearIntervalFn, handles, cleared };
}

interface FakeCtx {
  ctx: PluginContext;
  store: Map<string, string>;
  getHook(): SpawnHook | undefined;
  routes: Map<string, PluginRouteHandler>;
  statuses: unknown[];
  logs: unknown[][];
  abortReasons: string[];
}

function makeFakeCtx(opts?: {
  config?: Record<string, unknown>;
  store?: Map<string, string>;
}): FakeCtx {
  const store = opts?.store ?? new Map<string, string>();
  const state: PluginState = {
    get<T = unknown>(key: string): T | null {
      const raw = store.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    set(key: string, value: unknown): void {
      store.set(key, JSON.stringify(value));
    },
    delete(key: string): void {
      store.delete(key);
    },
    keys(): string[] {
      return [...store.keys()];
    },
  };

  let spawnHook: SpawnHook | undefined;
  const routes = new Map<string, PluginRouteHandler>();
  const statuses: unknown[] = [];
  const logs: unknown[][] = [];
  const abortReasons: string[] = [];

  const ctx: PluginContext = {
    manifest: {
      id: "claude-swap",
      name: "claude-swap",
      version: "0.1.0",
      apiVersion: 1,
      capabilities: ["spawn", "state", "routes", "status"],
    },
    onSpawn(fn: SpawnHook) {
      spawnHook = fn;
    },
    events: { subscribe: () => () => {} },
    publishStatus(status: unknown) {
      statuses.push(status);
    },
    state,
    route(method: string, path: string, handler: PluginRouteHandler) {
      routes.set(`${method} ${path}`, handler);
    },
    log: {
      log: (...args: unknown[]) => logs.push(args),
      warn: (...args: unknown[]) => logs.push(args),
    },
    config: opts?.config ?? {},
    abortSpawn(reason: string): never {
      abortReasons.push(reason);
      throw new PluginSpawnAborted(reason, "claude-swap");
    },
  };

  return { ctx, store, getHook: () => spawnHook, routes, statuses, logs, abortReasons };
}

function makeDescriptor(sessionId: string): SpawnDescriptor {
  return {
    sessionId,
    repoRoot: "/repo",
    model: null,
    agentProvider: "claude",
    argv: ["claude"],
    env: {},
    isolated: false,
  };
}

const now = () => "2026-06-27T12:00:00.000Z";

function runHook(hook: SpawnHook | undefined, sessionId: string): SpawnPatch | void {
  if (!hook) throw new Error("onSpawn hook not registered");
  return hook(makeDescriptor(sessionId)) as SpawnPatch | void;
}

// ───────────────────────────────────────────────────────────────────────────
// Boot-warm gate
// ───────────────────────────────────────────────────────────────────────────

describe("register — boot-warm gate", () => {
  it("after register at least one account is ready (GET stats shows ready)", async () => {
    const { runner } = makeFakeRunner({ prewarmOk: true });
    const timers = makeFakeTimers();
    const fc = makeFakeCtx();
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    const handler = fc.routes.get("GET stats")!;
    const body = (await (await handler(new Request("http://x/stats"))).json()) as {
      pool: { ready: boolean }[];
    };
    expect(body.pool.some((p) => p.ready)).toBe(true);
  });

  it("resolves degraded (no ready) within timeout when all prewarms fail", async () => {
    const { runner } = makeFakeRunner({ prewarmOk: false });
    const timers = makeFakeTimers();
    const fc = makeFakeCtx();
    const teardown = await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    // register resolved → plugin loaded even though degraded
    expect(typeof teardown).toBe("function");
    const handler = fc.routes.get("GET stats")!;
    const body = (await (await handler(new Request("http://x/stats"))).json()) as {
      pool: { ready: boolean }[];
    };
    expect(body.pool.every((p) => !p.ready)).toBe(true);
  });

  it("starts the background interval with refreshIntervalMs", async () => {
    const { runner } = makeFakeRunner();
    const timers = makeFakeTimers();
    const fc = makeFakeCtx({ config: { refreshIntervalMs: 12345 } });
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    expect(timers.handles).toHaveLength(1);
    expect(timers.handles[0]!.ms).toBe(12345);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// New-session assignment
// ───────────────────────────────────────────────────────────────────────────

describe("register — new-session assignment", () => {
  it("two fresh sessions get distinct accounts (round-robin) and pins are persisted", async () => {
    const { runner } = makeFakeRunner({ prewarmOk: true });
    const timers = makeFakeTimers();
    const fc = makeFakeCtx();
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    const hook = fc.getHook();
    const p1 = runHook(hook, "s1") as SpawnPatch;
    const p2 = runHook(hook, "s2") as SpawnPatch;
    expect(p1.credentialDir).toBeTruthy();
    expect(p2.credentialDir).toBeTruthy();
    expect(p1.credentialDir).not.toBe(p2.credentialDir);

    // pins persisted to durable state BEFORE return (synchronous already visible)
    const persisted = JSON.parse(fc.store.get("assignments")!) as Record<string, number>;
    expect(persisted["s1"]).toBeDefined();
    expect(persisted["s2"]).toBeDefined();
    expect(persisted["s1"]).not.toBe(persisted["s2"]);
    expect(JSON.parse(fc.store.get("cursor")!)).toBe(2);
  });

  it("onSpawn does ZERO subprocess I/O on the assigned hot path", async () => {
    const { runner, calls } = makeFakeRunner({ prewarmOk: true });
    const timers = makeFakeTimers();
    const fc = makeFakeCtx();
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    const before = calls.length;
    runHook(fc.getHook(), "s1");
    expect(calls.length).toBe(before);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Sticky resume (criterion 2)
// ───────────────────────────────────────────────────────────────────────────

describe("register — sticky resume (criterion 2)", () => {
  it("same session twice returns the same credentialDir", async () => {
    const { runner } = makeFakeRunner({ prewarmOk: true });
    const timers = makeFakeTimers();
    const fc = makeFakeCtx();
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    const hook = fc.getHook();
    const first = runHook(hook, "s1") as SpawnPatch;
    const second = runHook(hook, "s1") as SpawnPatch;
    expect(second.credentialDir).toBe(first.credentialDir);
  });

  it("resume reuses the persisted pin across a fresh register (same state store)", async () => {
    const store = new Map<string, string>();
    let firstDir: string | undefined;
    // first boot: assign s1
    {
      const { runner } = makeFakeRunner({ prewarmOk: true });
      const timers = makeFakeTimers();
      const fc = makeFakeCtx({ store });
      await register(fc.ctx, {
        runner,
        setInterval: timers.setIntervalFn,
        clearInterval: timers.clearIntervalFn,
        now,
        existsSync: () => true,
      });
      firstDir = (runHook(fc.getHook(), "s1") as SpawnPatch).credentialDir;
    }
    // second boot from same persisted state → resume must reuse account
    {
      const { runner } = makeFakeRunner({ prewarmOk: true });
      const timers = makeFakeTimers();
      const fc = makeFakeCtx({ store });
      await register(fc.ctx, {
        runner,
        setInterval: timers.setIntervalFn,
        clearInterval: timers.clearIntervalFn,
        now,
        existsSync: () => true,
      });
      const resumed = (runHook(fc.getHook(), "s1") as SpawnPatch).credentialDir;
      expect(resumed).toBe(firstDir);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Hard-block (criterion 3)
// ───────────────────────────────────────────────────────────────────────────

describe("register — hard-block (criterion 3)", () => {
  it("empty ready pool + abortOnEmpty → onSpawn throws (abortSpawn)", async () => {
    const { runner } = makeFakeRunner({ prewarmOk: false }); // nothing becomes ready
    const timers = makeFakeTimers();
    const fc = makeFakeCtx({ config: { abortOnEmpty: true } });
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    expect(() => runHook(fc.getHook(), "fresh")).toThrow(PluginSpawnAborted);
  });

  it("empty ready pool + abortOnEmpty=false → fail-open returns {}", async () => {
    const { runner } = makeFakeRunner({ prewarmOk: false });
    const timers = makeFakeTimers();
    const fc = makeFakeCtx({ config: { abortOnEmpty: false } });
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    const patch = runHook(fc.getHook(), "fresh");
    expect(patch).toEqual({});
  });
});

// ───────────────────────────────────────────────────────────────────────────
// warm-resume abort path
// ───────────────────────────────────────────────────────────────────────────

describe("register — warm resume", () => {
  it("pinned usable but not ready → throws warming abort AND schedules a background warm", async () => {
    // all prewarms fail at boot → ready stays empty, accounts remain usable
    const { runner, calls } = makeFakeRunner({ prewarmOk: false });
    const timers = makeFakeTimers();
    const store = new Map<string, string>();
    store.set("assignments", JSON.stringify({ s1: 1 }));
    store.set("cursor", JSON.stringify(0));
    const fc = makeFakeCtx({ store });
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    const runCallsForAcct1 = () =>
      calls.filter((c) => c.args[0] === "run" && c.args[1] === "1").length;
    const before = runCallsForAcct1();
    expect(() => runHook(fc.getHook(), "s1")).toThrow(PluginSpawnAborted);
    // a background warm for account 1 was scheduled (fire-and-forget prewarm call)
    await Promise.resolve();
    await Promise.resolve();
    expect(runCallsForAcct1()).toBe(before + 1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// lastError diagnosability (criterion 6)
// ───────────────────────────────────────────────────────────────────────────

describe("register — lastError surfaced when cswap absent/failing", () => {
  it("GET stats shows non-null lastError, empty pool, and onSpawn still hard-blocks", async () => {
    // cswap --list always fails (simulates cswap absent / non-zero exit).
    const failingRunner: Runner = async (_bin, args) => {
      if (args[0] === "--list") {
        return { stdout: "", stderr: "cswap: command not found", code: 127, timedOut: false };
      }
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    };
    const timers = makeFakeTimers();
    const fc = makeFakeCtx({ config: { abortOnEmpty: true } });
    await register(fc.ctx, {
      runner: failingRunner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });

    const handler = fc.routes.get("GET stats")!;
    const body = (await (await handler(new Request("http://x/stats"))).json()) as {
      lastError: string | null;
      pool: unknown[];
    };
    expect(body.lastError).not.toBeNull();
    expect(typeof body.lastError).toBe("string");
    expect(body.pool).toEqual([]);

    // onSpawn still hard-blocks (does not mis-spawn) despite the failing pool.
    expect(() => runHook(fc.getHook(), "fresh")).toThrow(PluginSpawnAborted);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Routes
// ───────────────────────────────────────────────────────────────────────────

describe("register — routes", () => {
  it("GET stats returns JSON with pool and assignments", async () => {
    const { runner } = makeFakeRunner({ prewarmOk: true });
    const timers = makeFakeTimers();
    const fc = makeFakeCtx();
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    const handler = fc.routes.get("GET stats")!;
    const res = await handler(new Request("http://x/stats"));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("pool");
    expect(body).toHaveProperty("assignments");
    expect(body).toHaveProperty("cursor");
  });

  it("POST reset clears assignments+cursor in state and returns {ok,cleared}", async () => {
    const { runner } = makeFakeRunner({ prewarmOk: true });
    const timers = makeFakeTimers();
    const fc = makeFakeCtx();
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    // create an assignment first
    runHook(fc.getHook(), "s1");
    expect(JSON.parse(fc.store.get("assignments")!)).not.toEqual({});

    const handler = fc.routes.get("POST reset")!;
    const res = await handler(new Request("http://x/reset", { method: "POST" }));
    const body = (await res.json()) as { ok: boolean; cleared: boolean };
    expect(body).toEqual({ ok: true, cleared: true });
    expect(JSON.parse(fc.store.get("assignments")!)).toEqual({});
    expect(JSON.parse(fc.store.get("cursor")!)).toBe(0);

    // subsequent stats reflect cleared assignments
    const stats = fc.routes.get("GET stats")!;
    const sbody = (await (await stats(new Request("http://x/stats"))).json()) as {
      assignments: Record<string, number>;
    };
    expect(sbody.assignments).toEqual({});
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Teardown
// ───────────────────────────────────────────────────────────────────────────

describe("register — teardown", () => {
  it("teardown clears the background interval", async () => {
    const { runner } = makeFakeRunner({ prewarmOk: true });
    const timers = makeFakeTimers();
    const fc = makeFakeCtx();
    const teardown = await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    expect(timers.cleared).toHaveLength(0);
    (teardown as () => void)();
    expect(timers.cleared).toHaveLength(1);
    expect(timers.cleared[0]).toBe(timers.handles[0]);
  });
});
