import { describe, expect, it } from "bun:test";
import { register, type PluginDeps } from "../index";
import { PluginSpawnAborted } from "../types";
import type {
  PluginContext,
  PluginUINode,
  PluginGearItem,
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

/** Handle the --switch / --switch-to branch of the fake runner. */
async function fakeRunnerSwitch(
  args: string[],
  opts?: { switchBlockOn?: Promise<void>; switchError?: boolean },
): Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }> {
  if (opts?.switchBlockOn) await opts.switchBlockOn;
  if (opts?.switchError) {
    return {
      stdout: JSON.stringify({
        schemaVersion: 1,
        error: { type: "no_available_account", message: "switch error" },
      }),
      stderr: "",
      code: 0,
      timedOut: false,
    };
  }
  const isSpecific = args[0] === "--switch-to";
  const toNumber = isSpecific ? Number(args[1]) : 2;
  const stratIdx = args.indexOf("--strategy");
  const strategy = stratIdx >= 0 ? (args[stratIdx + 1] ?? "rotation") : "rotation";
  return {
    stdout: JSON.stringify({
      schemaVersion: 1,
      switched: true,
      from: { number: 3, email: "a@x.com" },
      to: { number: toNumber, email: "b@x.com" },
      strategy,
      reason: "switched",
      message: "switched ok",
      warnings: [],
    }),
    stderr: "",
    code: 0,
    timedOut: false,
  };
}

/** Fake Runner that branches on argv: `--list` returns the fixture, `run` returns
 *  a configurable prewarm result, `--switch`/`--switch-to` returns a valid switch
 *  envelope (or an error envelope if `switchError` is true). Records every call. */
function makeFakeRunner(opts?: {
  prewarmOk?: boolean;
  listResult?: unknown;
  /** If true, --switch/--switch-to returns a structured error envelope (throws in wrapper). */
  switchError?: boolean;
  /** If provided, --switch/--switch-to awaits this before returning (for tick-gating tests). */
  switchBlockOn?: Promise<void>;
}): {
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
    if (args[0] === "--switch" || args[0] === "--switch-to") {
      return fakeRunnerSwitch(args, opts);
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
  uiViews: unknown[];
  gearItems: unknown[];
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
  const uiViews: unknown[] = [];
  const gearItems: unknown[] = [];
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
    publishUI(view: unknown) {
      uiViews.push(view);
    },
    publishGearItem(item: unknown) {
      gearItems.push(item);
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

  return {
    ctx,
    store,
    getHook: () => spawnHook,
    routes,
    statuses,
    uiViews,
    gearItems,
    logs,
    abortReasons,
  };
}

function makeDescriptor(
  sessionId: string,
  opts?: { kind?: SpawnDescriptor["kind"]; parentSessionId?: string },
): SpawnDescriptor {
  return {
    sessionId,
    repoRoot: "/repo",
    model: null,
    agentProvider: "claude",
    argv: ["claude"],
    env: {},
    isolated: false,
    ...opts,
  };
}

const now = () => "2026-06-27T12:00:00.000Z";

function runHook(
  hook: SpawnHook | undefined,
  sessionId: string,
  opts?: { kind?: SpawnDescriptor["kind"]; parentSessionId?: string },
): SpawnPatch | void {
  if (!hook) throw new Error("onSpawn hook not registered");
  return hook(makeDescriptor(sessionId, opts)) as SpawnPatch | void;
}

/** Walk the tree and return all nodes with matching type. */
function findByType(node: PluginUINode, type: string): PluginUINode[] {
  const results: PluginUINode[] = [];
  if (node.type === type) results.push(node);
  for (const child of node.children ?? []) {
    results.push(...findByType(child, type));
  }
  return results;
}

function latestView(uiViews: unknown[]): { root: PluginUINode } {
  return uiViews[uiViews.length - 1] as { root: PluginUINode };
}

/** Number of points in the first series of the time-series node. */
function seriesLen(uiViews: unknown[]): number {
  const view = latestView(uiViews);
  const [ts] = findByType(view.root, "time-series");
  const series = ts?.props?.["series"] as { points: unknown[] }[] | undefined;
  return series?.[0]?.points?.length ?? 0;
}

/** Number of events in the timeline node. */
function timelineLen(uiViews: unknown[]): number {
  const view = latestView(uiViews);
  const [tl] = findByType(view.root, "timeline");
  const events = tl?.props?.["events"] as unknown[] | undefined;
  return events?.length ?? 0;
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

/** Two non-active accounts so round-robin has ≥2 candidates after the active-account fix. */
const twoNonActiveList = {
  schemaVersion: 1,
  activeAccountNumber: 99,
  accounts: [
    {
      number: 1,
      email: "acct1@example.com",
      active: false,
      usageStatus: "ok",
      usage: { fiveHour: { pct: 0 }, sevenDay: { pct: 0 } },
    },
    {
      number: 2,
      email: "acct2@example.com",
      active: false,
      usageStatus: "ok",
      usage: { fiveHour: { pct: 0 }, sevenDay: { pct: 0 } },
    },
  ],
};

describe("register — new-session assignment", () => {
  it("two fresh sessions get distinct accounts (round-robin) and pins are persisted", async () => {
    const { runner } = makeFakeRunner({ prewarmOk: true, listResult: twoNonActiveList });
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
// Strategy: least-used
// ───────────────────────────────────────────────────────────────────────────

/** Account 1 has high fiveHour pct, account 2 has low — makes least-used diverge
 *  from round-robin (cursor=0 would pick account 1). */
const highLowUsageList = {
  schemaVersion: 1,
  activeAccountNumber: 99,
  accounts: [
    {
      number: 1,
      email: "acct1@example.com",
      active: false,
      usageStatus: "ok",
      usage: { fiveHour: { pct: 80 }, sevenDay: { pct: 0 } },
    },
    {
      number: 2,
      email: "acct2@example.com",
      active: false,
      usageStatus: "ok",
      usage: { fiveHour: { pct: 5 }, sevenDay: { pct: 0 } },
    },
  ],
};

describe("register — strategy: least-used", () => {
  it("least-used picks account 2 (lower pct) not account 1 (cursor=0 round-robin pick)", async () => {
    const { runner } = makeFakeRunner({ prewarmOk: true, listResult: highLowUsageList });
    const timers = makeFakeTimers();
    const fc = makeFakeCtx({ config: { strategy: "least-used" } });
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    runHook(fc.getHook(), "s1");
    const assignments = JSON.parse(fc.store.get("assignments")!) as Record<string, number>;
    expect(assignments["s1"]).toBe(2);
  });

  it("round-robin (default) picks account 1 first from same fixture — proves strategy switches behavior", async () => {
    const { runner } = makeFakeRunner({ prewarmOk: true, listResult: highLowUsageList });
    const timers = makeFakeTimers();
    const fc = makeFakeCtx({ config: {} });
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    runHook(fc.getHook(), "s1");
    const assignments = JSON.parse(fc.store.get("assignments")!) as Record<string, number>;
    expect(assignments["s1"]).toBe(1);
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

// ───────────────────────────────────────────────────────────────────────────
// Gear-menu item (claude-swap#17; capability from shepherd#1202)
// ───────────────────────────────────────────────────────────────────────────

describe("register — gear-menu item", () => {
  it("publishes one panel gear item pointing at the usage view", async () => {
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
    expect(fc.gearItems).toHaveLength(1);
    const item = fc.gearItems[0] as PluginGearItem;
    expect(item.label).toBe("Claude swap usage");
    expect(item.action.kind).toBe("panel");
  });

  it("loads (returns a teardown fn) when the host lacks publishGearItem", async () => {
    const { runner } = makeFakeRunner({ prewarmOk: true });
    const timers = makeFakeTimers();
    const fc = makeFakeCtx();
    // Simulate an older Shepherd build whose ctx has no gear-menu capability.
    delete (fc.ctx as { publishGearItem?: unknown }).publishGearItem;
    const teardown = await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    expect(typeof teardown).toBe("function");
    expect(fc.gearItems).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// History integration (quota + spawn recording)
// ───────────────────────────────────────────────────────────────────────────

describe("register — history: quota and spawn recording", () => {
  it("boot records one quota sample (time-series series have 1 point each)", async () => {
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
    expect(seriesLen(fc.uiViews)).toBe(1);
  });

  it("tick records another quota sample (time-series series have 2 points each)", async () => {
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
    // drive one tick: call the interval fn then await async refresh to settle
    timers.handles[0]!.fn();
    await new Promise((r) => setTimeout(r, 10));
    expect(seriesLen(fc.uiViews)).toBe(2);
  });

  it("spawn does NOT record quota but DOES record a spawn event", async () => {
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
    const lenBefore = seriesLen(fc.uiViews);
    const tlBefore = timelineLen(fc.uiViews);
    runHook(fc.getHook(), "s1");
    expect(seriesLen(fc.uiViews)).toBe(lenBefore);
    expect(timelineLen(fc.uiViews)).toBe(tlBefore + 1);
  });

  it("spawn timestamp equals injected clock and label contains assigned account", async () => {
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
    runHook(fc.getHook(), "s1");
    const view = latestView(fc.uiViews);
    const [tl] = findByType(view.root, "timeline");
    const events = tl?.props?.["events"] as { at: string; label: string }[];
    const last = events[events.length - 1]!;
    expect(last.at).toBe("2026-06-27T12:00:00.000Z");
    expect(last.label).toMatch(/#\d+/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Two-tier selection: usage-unavailable deprioritization (e2e)
// ───────────────────────────────────────────────────────────────────────────

const knownAndUnavailableList = {
  schemaVersion: 1,
  accounts: [
    {
      number: 1,
      email: "acct1@example.com",
      active: false,
      usageStatus: "ok",
      usage: { fiveHour: { pct: 10 }, sevenDay: { pct: 10 } },
    },
    {
      number: 2,
      email: "acct2@example.com",
      active: false,
      usageStatus: "ok",
      usage: null, // usageUnavailable
    },
  ],
};

const onlyUnavailableList = {
  schemaVersion: 1,
  accounts: [
    {
      number: 1,
      email: "acct1@example.com",
      active: false,
      usageStatus: "ok",
      usage: null, // usageUnavailable
    },
  ],
};

describe("register — two-tier selection (usage-unavailable e2e)", () => {
  it("known ready + unavailable ready → picks known account", async () => {
    const { runner } = makeFakeRunner({ prewarmOk: true, listResult: knownAndUnavailableList });
    const timers = makeFakeTimers();
    const fc = makeFakeCtx();
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    runHook(fc.getHook(), "s1");
    const assignments = JSON.parse(fc.store.get("assignments")!) as Record<string, number>;
    expect(assignments["s1"]).toBe(1); // known account, not unavailable #2
  });

  it("only unavailable ready → assigned (last-resort, not abort)", async () => {
    const { runner } = makeFakeRunner({ prewarmOk: true, listResult: onlyUnavailableList });
    const timers = makeFakeTimers();
    const fc = makeFakeCtx({ config: { abortOnEmpty: true } });
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    // fallback tier means assign() returns "assigned", so no abort even with abortOnEmpty
    expect(() => runHook(fc.getHook(), "s1")).not.toThrow();
    const assignments = JSON.parse(fc.store.get("assignments")!) as Record<string, number>;
    expect(assignments["s1"]).toBe(1);
  });

  it("abortOnEmpty:false resume: pinned quota-unknown account stays pinned (not fail-open)", async () => {
    // Boot with known-usage account so it gets prewarmed into ready.
    const knownList = {
      schemaVersion: 1,
      accounts: [
        {
          number: 1,
          email: "acct1@example.com",
          active: false,
          usageStatus: "ok",
          usage: { fiveHour: { pct: 10 }, sevenDay: { pct: 10 } },
        },
      ],
    };
    // On subsequent list calls, account 1 reports usage:null (usageUnavailable).
    const unavailableList = {
      schemaVersion: 1,
      accounts: [
        {
          number: 1,
          email: "acct1@example.com",
          active: false,
          usageStatus: "ok",
          usage: null,
        },
      ],
    };
    let listCallCount = 0;
    const runner: Runner = async (_bin, args) => {
      if (args[0] === "--list") {
        listCallCount++;
        const result = listCallCount === 1 ? knownList : unavailableList;
        return { stdout: JSON.stringify(result), stderr: "", code: 0, timedOut: false };
      }
      // prewarm (run) always succeeds
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    };
    const timers = makeFakeTimers();
    const fc = makeFakeCtx({ config: { abortOnEmpty: false } });
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });

    // Spawn new session → pins s1 to account 1, captures credentialDir.
    const first = runHook(fc.getHook(), "s1") as SpawnPatch;
    expect(first.credentialDir).toBeTruthy();

    // Tick: re-list returns usage:null → account 1 becomes usageUnavailable but stays usable
    // and is NOT pruned from ready (prewarm.ts only prunes unusable/rateLimited/gone).
    timers.handles[0]!.fn();
    await new Promise((r) => setTimeout(r, 10));

    // Resume s1: pinned to account 1 which is now quota-unknown but still in ready.
    // Must return the same credentialDir — never fail open to the default ~/.claude.
    const resumed = runHook(fc.getHook(), "s1") as SpawnPatch;
    expect(resumed.credentialDir).toBeTruthy();
    expect(resumed.credentialDir).toBe(first.credentialDir);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST switch-primary
// ───────────────────────────────────────────────────────────────────────────

/** Build a POST switch-primary request with a JSON body. */
function makeSwitchReq(body: unknown): Request {
  return new Request("http://x/switch-primary", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("register — POST switch-primary", () => {
  it("mode:specific account:N → invokes --switch-to N --json, returns 200, refresh follows", async () => {
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
    const handler = fc.routes.get("POST switch-primary")!;
    const listBefore = calls.filter((c) => c.args[0] === "--list").length;

    const res = await handler(makeSwitchReq({ mode: "specific", account: 5 }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { switched: boolean };
    expect(body.switched).toBe(true);
    // --switch-to was invoked with exactly the right argv
    const switchCall = calls.find((c) => c.args[0] === "--switch-to");
    expect(switchCall?.args).toEqual(["--switch-to", "5", "--json"]);
    // a follow-up --list (refresh) was issued
    expect(calls.filter((c) => c.args[0] === "--list").length).toBeGreaterThan(listBefore);
  });

  it("mode:specific account:<email> (string) → invokes --switch-to <email> --json and returns 200", async () => {
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
    const handler = fc.routes.get("POST switch-primary")!;

    const res = await handler(makeSwitchReq({ mode: "specific", account: "user@example.com" }));

    expect(res.status).toBe(200);
    // string target must go through clearReady() (not dropReady) and pass the email as-is
    const switchCall = calls.find((c) => c.args[0] === "--switch-to");
    expect(switchCall?.args).toEqual(["--switch-to", "user@example.com", "--json"]);
  });

  it("mode:next → invokes --switch --json (plain rotation)", async () => {
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
    const handler = fc.routes.get("POST switch-primary")!;

    await handler(makeSwitchReq({ mode: "next" }));

    const switchCall = calls.find(
      (c) => c.args[0] === "--switch" && !c.args.includes("--strategy"),
    );
    expect(switchCall?.args).toEqual(["--switch", "--json"]);
  });

  it("mode:best → invokes --switch --strategy best --json", async () => {
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
    const handler = fc.routes.get("POST switch-primary")!;

    await handler(makeSwitchReq({ mode: "best" }));

    const switchCall = calls.find((c) => c.args[0] === "--switch" && c.args.includes("--strategy"));
    expect(switchCall?.args).toEqual(["--switch", "--strategy", "best", "--json"]);
  });

  it("malformed body → 400 {ok:false}", async () => {
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
    const handler = fc.routes.get("POST switch-primary")!;

    const res = await handler(
      new Request("http://x/switch-primary", { method: "POST", body: "not json" }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("missing body → 400 {ok:false}", async () => {
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
    const handler = fc.routes.get("POST switch-primary")!;

    const res = await handler(new Request("http://x/switch-primary", { method: "POST" }));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("invalid mode value → 400 {ok:false}", async () => {
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
    const handler = fc.routes.get("POST switch-primary")!;

    const res = await handler(makeSwitchReq({ mode: "invalid" }));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("missing mode → 400 {ok:false}", async () => {
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
    const handler = fc.routes.get("POST switch-primary")!;

    const res = await handler(makeSwitchReq({}));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("mode:specific without account → 400 {ok:false}", async () => {
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
    const handler = fc.routes.get("POST switch-primary")!;

    const res = await handler(makeSwitchReq({ mode: "specific" }));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("mode:specific with empty string account → 400 {ok:false}", async () => {
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
    const handler = fc.routes.get("POST switch-primary")!;

    const res = await handler(makeSwitchReq({ mode: "specific", account: "" }));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("cswap failure → 500 {ok:false,error}; selection state unchanged", async () => {
    const { runner, calls } = makeFakeRunner({ prewarmOk: true, switchError: true });
    const timers = makeFakeTimers();
    const fc = makeFakeCtx();
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    const switchHandler = fc.routes.get("POST switch-primary")!;
    const statsHandler = fc.routes.get("GET stats")!;

    // create an assignment to verify it is not mutated by a failed switch
    runHook(fc.getHook(), "s1");
    const statsBefore = (await (await statsHandler(new Request("http://x/stats"))).json()) as {
      cursor: number;
      assignments: Record<string, number>;
    };

    const res = await switchHandler(makeSwitchReq({ mode: "next" }));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");

    // selection state (cursor + assignments) must be unchanged
    const statsAfter = (await (await statsHandler(new Request("http://x/stats"))).json()) as {
      cursor: number;
      assignments: Record<string, number>;
    };
    expect(statsAfter.cursor).toBe(statsBefore.cursor);
    expect(statsAfter.assignments).toEqual(statsBefore.assignments);

    // runner was invoked (proves the switch was attempted, not short-circuited)
    expect(calls.some((c) => c.args[0] === "--switch")).toBe(true);
  });

  it("after switch success, switch guard is released (subsequent tick refreshes)", async () => {
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
    const handler = fc.routes.get("POST switch-primary")!;

    await handler(makeSwitchReq({ mode: "next" }));

    const listBefore = calls.filter((c) => c.args[0] === "--list").length;
    timers.handles[0]!.fn();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.filter((c) => c.args[0] === "--list").length).toBeGreaterThan(listBefore);
  });

  it("after switch failure, switch guard is released (subsequent tick refreshes)", async () => {
    const { runner, calls } = makeFakeRunner({ prewarmOk: true, switchError: true });
    const timers = makeFakeTimers();
    const fc = makeFakeCtx();
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    const handler = fc.routes.get("POST switch-primary")!;

    await handler(makeSwitchReq({ mode: "next" }));

    const listBefore = calls.filter((c) => c.args[0] === "--list").length;
    timers.handles[0]!.fn();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.filter((c) => c.args[0] === "--list").length).toBeGreaterThan(listBefore);
  });

  it("tick gating: tick does not refresh while switch is in-flight; runs normally after", async () => {
    let resolveSwitch!: () => void;
    const switchBlockOn = new Promise<void>((resolve) => {
      resolveSwitch = resolve;
    });

    const { runner, calls } = makeFakeRunner({ prewarmOk: true, switchBlockOn });
    const timers = makeFakeTimers();
    const fc = makeFakeCtx();
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    const handler = fc.routes.get("POST switch-primary")!;

    // Start switch without awaiting — runner is blocked on switchBlockOn (past beginSwitch)
    const switchPromise = handler(makeSwitchReq({ mode: "next" }));

    // Yield so the route executes through beginSwitch() + clearReady() up to the blocked runner
    await new Promise((r) => setTimeout(r, 0));

    const listBefore = calls.filter((c) => c.args[0] === "--list").length;

    // Fire tick while switch is in-flight — isSwitching is true, so tick must early-return
    timers.handles[0]!.fn();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.filter((c) => c.args[0] === "--list").length).toBe(listBefore);

    // Resolve the switch; route completes (calls refresh → one more --list internally)
    resolveSwitch();
    const res = await switchPromise;
    expect(res.status).toBe(200);

    // Guard is released — tick now runs normally
    const listAfterSwitch = calls.filter((c) => c.args[0] === "--list").length;
    timers.handles[0]!.fn();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.filter((c) => c.args[0] === "--list").length).toBeGreaterThan(listAfterSwitch);
  });

  it("rejects a concurrent switch with 409 while one is in-flight; first still completes", async () => {
    let resolveSwitch!: () => void;
    const switchBlockOn = new Promise<void>((resolve) => {
      resolveSwitch = resolve;
    });

    const { runner, calls } = makeFakeRunner({ prewarmOk: true, switchBlockOn });
    const timers = makeFakeTimers();
    const fc = makeFakeCtx();
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    const handler = fc.routes.get("POST switch-primary")!;

    // First switch — runner blocks past beginSwitch(), so the guard is held.
    const first = handler(makeSwitchReq({ mode: "next" }));
    await new Promise((r) => setTimeout(r, 0));

    const switchCallsWhileBlocked = calls.filter((c) => c.args[0] === "--switch").length;

    // Second switch while the first is in-flight → 409, and it must NOT invoke cswap or touch state.
    const second = await handler(makeSwitchReq({ mode: "best" }));
    expect(second.status).toBe(409);
    expect(((await second.json()) as { ok: boolean }).ok).toBe(false);
    // No additional cswap switch subprocess was started by the rejected request.
    expect(calls.filter((c) => c.args[0] === "--switch").length).toBe(switchCallsWhileBlocked);

    // First completes normally; guard releases.
    resolveSwitch();
    expect((await first).status).toBe(200);

    // A new switch now succeeds (guard was released).
    const third = await handler(makeSwitchReq({ mode: "next" }));
    expect(third.status).toBe(200);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Aux-spawn routing (review / plan-gate / doc) — shepherd#1205 fix
// ───────────────────────────────────────────────────────────────────────────

describe("register — aux-spawn routing (shepherd#1205 / #1217)", () => {
  // With routeAuxQuota=true (default — assumes a shepherd#1217+ host that binds a plugin-patched
  // credentialDir into the reviewer sandbox), aux spawns (review / plan-gate / doc) are routed onto
  // a pool account's credentialDir: review/plan-gate inherit the parent session's pinned account;
  // doc/standalone-critic route to a pool account EPHEMERALLY (no durable pin, no cursor advance,
  // no lastSpawn/history). They are NEVER aborted.
  it("review w/ pinned parentSessionId → parent's credentialDir; no abort; no new assignment; lastSpawn unchanged", async () => {
    const { runner } = makeFakeRunner({ prewarmOk: true, listResult: twoNonActiveList });
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

    // Spawn a real session first to get a pin.
    const parentPatch = runHook(hook, "parent-session") as SpawnPatch;
    const parentDir = parentPatch.credentialDir;
    expect(parentDir).toBeTruthy();

    const assignmentsBefore = JSON.parse(fc.store.get("assignments")!) as Record<string, number>;
    const statusCountBefore = fc.statuses.length;

    // Spawn a review aux spawn for the same parent.
    const reviewPatch = runHook(hook, "review-session-id", {
      kind: "review",
      parentSessionId: "parent-session",
    }) as SpawnPatch;

    // Routed to the parent's pinned account dir.
    expect(reviewPatch.credentialDir).toBe(parentDir);

    // No abort ever called.
    expect(fc.abortReasons).toHaveLength(0);

    // No new assignment entry for the review id; assignments map untouched.
    const assignmentsAfter = JSON.parse(fc.store.get("assignments")!) as Record<string, number>;
    expect(assignmentsAfter["review-session-id"]).toBeUndefined();
    expect(assignmentsAfter).toEqual(assignmentsBefore);

    // publish() not called by aux spawn → statuses length unchanged.
    expect(fc.statuses.length).toBe(statusCountBefore);
  });

  it("review w/ parentSessionId NOT in assignments → {}; no abort", async () => {
    const { runner } = makeFakeRunner({ prewarmOk: true, listResult: twoNonActiveList });
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

    const patch = runHook(hook, "review-orphan", {
      kind: "review",
      parentSessionId: "nonexistent-parent",
    });

    // Untracked parent → fall open (empty patch), never abort.
    expect(patch).toEqual({});
    expect(fc.abortReasons).toHaveLength(0);
  });

  it("regression: review w/ empty ready + abortOnEmpty:true → does NOT throw PluginSpawnAborted", async () => {
    // prewarmOk:false → nothing becomes ready; seed a parent pin in the store.
    const { runner } = makeFakeRunner({ prewarmOk: false, listResult: twoNonActiveList });
    const timers = makeFakeTimers();
    const store = new Map<string, string>();
    store.set("assignments", JSON.stringify({ "parent-s": 1 }));
    store.set("cursor", JSON.stringify(0));
    const fc = makeFakeCtx({ config: { abortOnEmpty: true }, store });
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    const hook = fc.getHook();

    // Normal session spawn with abortOnEmpty:true → throws.
    expect(() => runHook(hook, "new-session")).toThrow(PluginSpawnAborted);

    // But review aux spawn does NOT throw, even with empty ready + abortOnEmpty:true.
    expect(() =>
      runHook(hook, "review-id", { kind: "review", parentSessionId: "parent-s" }),
    ).not.toThrow();

    expect(fc.abortReasons).toHaveLength(1); // only from the normal session
  });

  it("doc (no parentSessionId) w/ a ready pool account → pool credentialDir; no durable assignment; no abort; lastSpawn/history untouched", async () => {
    const { runner } = makeFakeRunner({ prewarmOk: true, listResult: twoNonActiveList });
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

    const statusCountBefore = fc.statuses.length;
    const tlBefore = timelineLen(fc.uiViews);

    const patch = runHook(hook, "doc-session-id", { kind: "doc" }) as SpawnPatch;

    // Routed ephemerally to a pool account.
    expect(patch.credentialDir).toBeTruthy();

    // No durable assignment persisted for the doc session id.
    const rawAssignments = fc.store.get("assignments");
    const assignments =
      rawAssignments !== undefined ? (JSON.parse(rawAssignments) as Record<string, number>) : {};
    expect(assignments["doc-session-id"]).toBeUndefined();

    // No abort.
    expect(fc.abortReasons).toHaveLength(0);

    // lastSpawn/history untouched — no new timeline event and no publish().
    expect(timelineLen(fc.uiViews)).toBe(tlBefore);
    expect(fc.statuses.length).toBe(statusCountBefore);
  });

  it("doc (no parentSessionId) w/ empty ready + abortOnEmpty:true → {}; no abort", async () => {
    const { runner } = makeFakeRunner({ prewarmOk: false, listResult: twoNonActiveList });
    const timers = makeFakeTimers();
    const fc = makeFakeCtx({ config: { abortOnEmpty: true } });
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    const hook = fc.getHook();

    const patch = runHook(hook, "doc-id", { kind: "doc" });

    // No ready pool account → fall open (empty patch), never abort.
    expect(patch).toEqual({});
    expect(fc.abortReasons).toHaveLength(0);
  });

  // ── routeAuxQuota=false (pre-#1217 host): pass through — NO patch, never abort ──
  it("routeAuxQuota:false → review w/ pinned parent passes through (no patch); no abort", async () => {
    const { runner } = makeFakeRunner({ prewarmOk: true, listResult: twoNonActiveList });
    const timers = makeFakeTimers();
    const fc = makeFakeCtx({ config: { routeAuxQuota: false } });
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    const hook = fc.getHook();

    // Establish a real parent pin first.
    expect((runHook(hook, "parent-session") as SpawnPatch).credentialDir).toBeTruthy();

    const reviewPatch = runHook(hook, "review-session-id", {
      kind: "review",
      parentSessionId: "parent-session",
    });

    // No patch — the sandboxed reviewer stays on the bound active account.
    expect(reviewPatch).toBeUndefined();
    expect(fc.abortReasons).toHaveLength(0);
  });

  it("routeAuxQuota:false → doc passes through (no patch); no abort", async () => {
    const { runner } = makeFakeRunner({ prewarmOk: true, listResult: twoNonActiveList });
    const timers = makeFakeTimers();
    const fc = makeFakeCtx({ config: { routeAuxQuota: false } });
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    const hook = fc.getHook();

    const patch = runHook(hook, "doc-session-id", { kind: "doc" });

    expect(patch).toBeUndefined();
    expect(fc.abortReasons).toHaveLength(0);
  });

  it("kind absent (old host) → identical to a normal session spawn (back-compat)", async () => {
    const { runner } = makeFakeRunner({ prewarmOk: true, listResult: twoNonActiveList });
    const timers = makeFakeTimers();
    const fc = makeFakeCtx({ config: { abortOnEmpty: true } });
    await register(fc.ctx, {
      runner,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now,
      existsSync: () => true,
    });
    const hook = fc.getHook();

    // No kind field → treated as a normal session spawn.
    const patch = runHook(hook, "old-host-session") as SpawnPatch;
    expect(patch.credentialDir).toBeTruthy();

    // Assignment durably persisted (same as a regular session).
    const assignments = JSON.parse(fc.store.get("assignments")!) as Record<string, number>;
    expect(assignments["old-host-session"]).toBeDefined();
  });

  it("aux spawns never appear in the history spawn ring or lastSpawn", async () => {
    const { runner } = makeFakeRunner({ prewarmOk: true, listResult: twoNonActiveList });
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

    // Spawn a real session to establish a parent pin and a timeline event.
    runHook(hook, "real-session");
    const tlAfterReal = timelineLen(fc.uiViews);
    expect(tlAfterReal).toBeGreaterThan(0);

    // Aux review spawn.
    runHook(hook, "review-id", { kind: "review", parentSessionId: "real-session" });

    // Timeline must NOT have grown.
    expect(timelineLen(fc.uiViews)).toBe(tlAfterReal);

    // GET stats: lastSpawn must still reflect the real session, not the review.
    const statsHandler = fc.routes.get("GET stats")!;
    const body = (await (await statsHandler(new Request("http://x/stats"))).json()) as {
      lastSpawn: { sessionId: string } | null;
    };
    expect(body.lastSpawn?.sessionId).toBe("real-session");
  });
});
