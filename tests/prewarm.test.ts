import { describe, expect, it } from "bun:test";
import { Prewarmer, type PrewarmerDeps, type HealRestoreFailure } from "../src/prewarm";
import { Cswap, type Runner } from "../src/cswap";
import { parseConfig } from "../src/config";
import type { PluginLogger } from "../types";
import fixtureRaw from "../docs/contracts/cswap-list.sample.json";

function makeLog(): { log: PluginLogger; warnings: string[] } {
  const warnings: string[] = [];
  const log: PluginLogger = {
    log: () => {},
    warn: (...args: unknown[]) => warnings.push(args.map(String).join(" ")),
  };
  return { log, warnings };
}

/** Fake runner: `--list` returns the fixture; `run` returns a configurable prewarm result. */
function makeRunner(opts?: { listOk?: boolean; prewarmOk?: boolean }): Runner {
  const listOk = opts?.listOk ?? true;
  const prewarmOk = opts?.prewarmOk ?? true;
  return async (_bin, args) => {
    if (args[0] === "--list") {
      return listOk
        ? { stdout: JSON.stringify(fixtureRaw), stderr: "", code: 0, timedOut: false }
        : { stdout: "", stderr: "boom", code: 1, timedOut: false };
    }
    return prewarmOk
      ? { stdout: "", stderr: "", code: 0, timedOut: false }
      : { stdout: "", stderr: "warm failed", code: 1, timedOut: false };
  };
}

/** Tracking runner: records which account numbers were prewarmed via `run <N>`. */
function makeTrackingRunner(): { runner: Runner; prewarmedAccounts: number[] } {
  const prewarmedAccounts: number[] = [];
  const runner: Runner = async (_bin, args) => {
    if (args[0] === "--list") {
      return { stdout: JSON.stringify(fixtureRaw), stderr: "", code: 0, timedOut: false };
    }
    if (args[0] === "run") {
      prewarmedAccounts.push(Number(args[1]));
    }
    return { stdout: "", stderr: "", code: 0, timedOut: false };
  };
  return { runner, prewarmedAccounts };
}

function makePrewarmer(overrides: Partial<PrewarmerDeps> = {}): {
  prewarmer: Prewarmer;
  warnings: string[];
} {
  const { log, warnings } = makeLog();
  const prewarmer = new Prewarmer({
    cswap: new Cswap("cswap", makeRunner()),
    cfg: parseConfig({}),
    log,
    backupRoot: "/tmp/backup-root",
    existsSync: () => true,
    ...overrides,
  });
  return { prewarmer, warnings };
}

// ───────────────────────────────────────────────────────────────────────────
// Fix 3 — refresh() never throws out of the background loop
// ───────────────────────────────────────────────────────────────────────────

describe("Prewarmer.refresh — never rejects", () => {
  it("a throwing onChange does not make refresh() reject", async () => {
    const { prewarmer } = makePrewarmer({
      onChange: () => {
        throw new Error("publishStatus exploded");
      },
    });
    // Must resolve, not reject — the boot await + fire-and-forget tick depend on this.
    await expect(prewarmer.refresh()).resolves.toBeUndefined();
  });

  it("a throwing onChange after a failed list still resolves", async () => {
    const { prewarmer } = makePrewarmer({
      cswap: new Cswap("cswap", makeRunner({ listOk: false })),
      onChange: () => {
        throw new Error("publishStatus exploded");
      },
    });
    await expect(prewarmer.refresh()).resolves.toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Fix 2 — lastError set on failure, cleared on success
// ───────────────────────────────────────────────────────────────────────────

describe("Prewarmer.lastError", () => {
  it("is set when list() fails and cleared on a subsequent success (same instance)", async () => {
    // Toggleable runner: drive the failure→success transition on ONE Prewarmer instance so
    // the success-branch `this.lastError = null` clears a previously non-null value.
    let fail = true;
    const toggleRunner: Runner = async (_bin, args) => {
      if (args[0] === "--list") {
        return fail
          ? { stdout: "", stderr: "boom", code: 1, timedOut: false }
          : { stdout: JSON.stringify(fixtureRaw), stderr: "", code: 0, timedOut: false };
      }
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    };
    const { prewarmer } = makePrewarmer({ cswap: new Cswap("cswap", toggleRunner) });

    await prewarmer.refresh();
    expect(prewarmer.lastError).not.toBeNull();

    fail = false;
    await prewarmer.refresh();
    expect(prewarmer.lastError).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Fix 4 — warm-time profile-dir existence guard (PRD §9)
// ───────────────────────────────────────────────────────────────────────────

describe("Prewarmer.warm — profile credentials guard", () => {
  it("prewarm ok but .credentials.json absent → account NOT added to ready", async () => {
    const { prewarmer, warnings } = makePrewarmer({ existsSync: () => false });
    await prewarmer.refresh(); // populate pool from fixture (account 1 usable)
    await prewarmer.warm(1);
    expect(prewarmer.ready.has(1)).toBe(false);
    expect(warnings.some((w) => w.includes("credentials are absent"))).toBe(true);
  });

  it("prewarm ok and .credentials.json present → account added to ready", async () => {
    const { prewarmer } = makePrewarmer({ existsSync: () => true });
    await prewarmer.refresh();
    await prewarmer.warm(1);
    expect(prewarmer.ready.has(1)).toBe(true);
  });

  it("dir present but .credentials.json missing → NOT added to ready", async () => {
    // existsSync true for the dir, false for the credentials file → credential-incomplete profile.
    const { prewarmer } = makePrewarmer({
      existsSync: (p) => !p.endsWith(".credentials.json"),
    });
    await prewarmer.refresh();
    await prewarmer.warm(1);
    expect(prewarmer.ready.has(1)).toBe(false);
  });

  it("checks <profile-dir>/.credentials.json derived from backupRoot + account email", async () => {
    const checked: string[] = [];
    const { prewarmer } = makePrewarmer({
      backupRoot: "/custom/root",
      existsSync: (p) => {
        checked.push(p);
        return true;
      },
    });
    await prewarmer.refresh();
    await prewarmer.warm(1);
    // fixture account 1 email = acct1@example.com → slug acct1_example.com
    expect(checked).toContain("/custom/root/sessions/1-acct1_example.com/.credentials.json");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Fix: skip warming the active cswap account (no isolated profile)
// ───────────────────────────────────────────────────────────────────────────

describe("Prewarmer — active account exclusion", () => {
  // fixture: account 1 = active:true, account 2 = active:false; both usable, not rate-limited

  it("warmStale() never calls prewarm for the active account", async () => {
    const { runner, prewarmedAccounts } = makeTrackingRunner();
    const { prewarmer } = makePrewarmer({ cswap: new Cswap("cswap", runner) });
    await prewarmer.refresh();
    prewarmer.warmStale();
    await prewarmer.drain();
    expect(prewarmedAccounts).not.toContain(1);
  });

  it("warmStale() never warms the active account across repeated cycles", async () => {
    const { runner, prewarmedAccounts } = makeTrackingRunner();
    const { prewarmer } = makePrewarmer({ cswap: new Cswap("cswap", runner) });
    await prewarmer.refresh();
    for (let i = 0; i < 3; i++) {
      prewarmer.warmStale();
      await prewarmer.drain();
    }
    expect(prewarmedAccounts).not.toContain(1);
  });

  it("bootWarm() never calls prewarm for the active account", async () => {
    const { runner, prewarmedAccounts } = makeTrackingRunner();
    const { prewarmer } = makePrewarmer({ cswap: new Cswap("cswap", runner) });
    await prewarmer.refresh();
    await prewarmer.bootWarm();
    expect(prewarmedAccounts).not.toContain(1);
  });

  it("warmStale() still warms a non-active usable account", async () => {
    const { runner, prewarmedAccounts } = makeTrackingRunner();
    const { prewarmer } = makePrewarmer({ cswap: new Cswap("cswap", runner) });
    await prewarmer.refresh();
    prewarmer.warmStale();
    await prewarmer.drain();
    // account 2: active=false, usable, not rate-limited → must be warmed
    expect(prewarmedAccounts).toContain(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Task 2 — active-prune, drop helpers, switch-in-progress guard
// ───────────────────────────────────────────────────────────────────────────

describe("Prewarmer.refresh — active-account prune", () => {
  it("removes active account from ready on refresh", async () => {
    const { prewarmer } = makePrewarmer();
    await prewarmer.refresh();
    // Manually seed account 1 (active) into ready
    prewarmer.ready.add(1);
    // Refresh again — active account must be pruned
    await prewarmer.refresh();
    expect(prewarmer.ready.has(1)).toBe(false);
  });

  it("keeps a non-active usable account in ready on refresh", async () => {
    const { prewarmer } = makePrewarmer();
    await prewarmer.refresh();
    // Manually seed account 2 (non-active, usable) into ready
    prewarmer.ready.add(2);
    await prewarmer.refresh();
    expect(prewarmer.ready.has(2)).toBe(true);
  });
});

describe("Prewarmer.dropReady", () => {
  it("removes exactly the named account from ready", () => {
    const { prewarmer } = makePrewarmer();
    prewarmer.ready.add(1);
    prewarmer.ready.add(2);
    prewarmer.dropReady(1);
    expect(prewarmer.ready.has(1)).toBe(false);
    expect(prewarmer.ready.has(2)).toBe(true);
  });

  it("is a no-op when account is not in ready", () => {
    const { prewarmer } = makePrewarmer();
    prewarmer.ready.add(2);
    prewarmer.dropReady(1);
    expect(prewarmer.ready.has(2)).toBe(true);
  });
});

describe("Prewarmer.clearReady", () => {
  it("empties ready", () => {
    const { prewarmer } = makePrewarmer();
    prewarmer.ready.add(1);
    prewarmer.ready.add(2);
    prewarmer.clearReady();
    expect(prewarmer.ready.size).toBe(0);
  });
});

describe("Prewarmer — switch-in-progress guard", () => {
  it("isSwitching is false initially", () => {
    const { prewarmer } = makePrewarmer();
    expect(prewarmer.isSwitching).toBe(false);
  });

  it("isSwitching is true after beginSwitch, false after endSwitch", () => {
    const { prewarmer } = makePrewarmer();
    prewarmer.beginSwitch();
    expect(prewarmer.isSwitching).toBe(true);
    prewarmer.endSwitch();
    expect(prewarmer.isSwitching).toBe(false);
  });

  it("warm() does not add account to ready while switching", async () => {
    const { prewarmer } = makePrewarmer();
    await prewarmer.refresh();
    prewarmer.beginSwitch();
    await prewarmer.warm(2);
    expect(prewarmer.ready.has(2)).toBe(false);
  });

  it("warm() adds account to ready after endSwitch", async () => {
    const { prewarmer } = makePrewarmer();
    await prewarmer.refresh();
    prewarmer.beginSwitch();
    await prewarmer.warm(2);
    expect(prewarmer.ready.has(2)).toBe(false);
    prewarmer.endSwitch();
    await prewarmer.warm(2);
    expect(prewarmer.ready.has(2)).toBe(true);
  });

  it("warmStale() does not kick any warms while switching", async () => {
    const { runner, prewarmedAccounts } = makeTrackingRunner();
    const { prewarmer } = makePrewarmer({ cswap: new Cswap("cswap", runner) });
    await prewarmer.refresh();
    prewarmer.beginSwitch();
    prewarmer.warmStale();
    await prewarmer.drain();
    expect(prewarmedAccounts).toHaveLength(0);
  });

  it("warmStale() resumes warms after endSwitch", async () => {
    const { runner, prewarmedAccounts } = makeTrackingRunner();
    const { prewarmer } = makePrewarmer({ cswap: new Cswap("cswap", runner) });
    await prewarmer.refresh();
    prewarmer.beginSwitch();
    prewarmer.warmStale();
    await prewarmer.drain();
    expect(prewarmedAccounts).toHaveLength(0);
    prewarmer.endSwitch();
    prewarmer.warmStale();
    await prewarmer.drain();
    expect(prewarmedAccounts).toContain(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Task 2 — auto-heal engine (healUnavailable)
// ───────────────────────────────────────────────────────────────────────────

interface AcctSpec {
  number: number;
  active?: boolean;
  /** cswap usageStatus; default "ok". */
  usageStatus?: string;
  /** null ⇒ window omitted (so classifyPool sees a null pct). */
  fiveHourPct?: number | null;
  sevenDayPct?: number | null;
  /** cswap 0.21 `disabled` flag; emitted only when true, as the real CLI does. */
  disabled?: boolean;
}

interface HealState {
  active: number | undefined;
  accts: AcctSpec[];
}

function listJson(state: HealState): string {
  return JSON.stringify({
    schemaVersion: 1,
    activeAccountNumber: state.active,
    accounts: state.accts.map((a) => {
      const status = a.usageStatus ?? "ok";
      const usage =
        status === "ok"
          ? {
              ...(a.fiveHourPct === null ? {} : { fiveHour: { pct: a.fiveHourPct ?? 0 } }),
              ...(a.sevenDayPct === null ? {} : { sevenDay: { pct: a.sevenDayPct ?? 0 } }),
            }
          : null;
      return {
        number: a.number,
        email: `acct${a.number}@example.com`,
        active: a.active ?? false,
        usageStatus: status,
        ...(a.disabled === true ? { disabled: true } : {}),
        usage,
      };
    }),
  });
}

function switchJson(target: number): string {
  return JSON.stringify({
    schemaVersion: 1,
    switched: true,
    from: { number: null, email: "" },
    to: { number: target, email: `acct${target}@example.com` },
    strategy: "switch-to",
    reason: "manual",
    message: "switched",
    warnings: [],
  });
}

/** Default switch behavior: only changes which account is active (no heal — heal is on launch). */
function defaultSwitch(target: number, state: HealState): void {
  state.active = target;
  for (const a of state.accts) a.active = a.number === target;
}

/** One combined call-log entry, so tests can assert switch/run ordering. */
type CallEvent = { kind: "switch" | "run"; target: number };

/**
 * Stateful fake runner driving --list (current state), --switch-to (records calls, mutates
 * active via a handler), and run (records the launched account and — by default — heals it if
 * it is the active default login, modeling a real Claude session refreshing the OAuth token).
 * `failSwitch` targets return non-zero so `cswap.switchTo` throws; `failLaunch` targets return
 * non-zero so the prewarm runner reports a failed launch. `healsOnLaunch` toggles whether a
 * launch heals (so "still unavailable after dance" tests can model a no-op launch). A one-shot
 * `serveStaleList` latch makes the next --list return the pre-heal snapshot (cswap's 15s cache).
 */
function makeHealRunner(initial: HealState) {
  const state: HealState = { active: initial.active, accts: initial.accts.map((a) => ({ ...a })) };
  const switchCalls: number[] = [];
  const launchedAccounts: number[] = [];
  const callLog: CallEvent[] = [];
  const failSwitch = new Set<number>();
  const failLaunch = new Set<number>();
  let listFails = false;
  let healsOnLaunch = true;
  let staleSnapshot: string | null = null;
  let onSwitchTo: (target: number, state: HealState) => void = defaultSwitch;

  const ok = (stdout: string) => ({ stdout, stderr: "", code: 0, timedOut: false });
  const fail = (stderr: string) => ({ stdout: "", stderr, code: 1, timedOut: false });

  const handleList = () => {
    if (listFails) return fail("list boom");
    if (staleSnapshot !== null) {
      const stale = staleSnapshot;
      staleSnapshot = null; // one-shot: a single --list serves the cached pre-heal snapshot
      return ok(stale);
    }
    return ok(listJson(state));
  };

  const handleSwitch = (target: number) => {
    switchCalls.push(target);
    callLog.push({ kind: "switch", target });
    if (failSwitch.has(target)) return fail("switch boom");
    onSwitchTo(target, state);
    return ok(switchJson(target));
  };

  // `cswap run <n> -- <args>`: argv = ["run", "<n>", "--", ...args]
  const handleRun = (target: number) => {
    launchedAccounts.push(target);
    callLog.push({ kind: "run", target });
    if (failLaunch.has(target)) return fail("launch failed");
    // A real Claude session refreshes the OAuth token cswap refused to refresh, but only for
    // the now-active default login (`cswap run <active>` fast-paths claude under ~/.claude).
    if (healsOnLaunch && state.active === target) {
      const a = state.accts.find((x) => x.number === target);
      if (a) a.usageStatus = "ok";
    }
    return ok("");
  };

  const runner: Runner = async (_bin, args) => {
    if (args[0] === "--list") return handleList();
    if (args[0] === "--switch-to") return handleSwitch(Number(args[1]));
    if (args[0] === "run") return handleRun(Number(args[1]));
    return ok("");
  };

  return {
    runner,
    switchCalls,
    launchedAccounts,
    callLog,
    state,
    setListFails: (v: boolean) => {
      listFails = v;
    },
    setHealsOnLaunch: (v: boolean) => {
      healsOnLaunch = v;
    },
    /** Make the next --list serve a pre-heal (stale) snapshot of the current state. */
    serveStaleListOnce: () => {
      staleSnapshot = listJson(state);
    },
    failSwitch: (n: number) => failSwitch.add(n),
    failLaunch: (n: number) => failLaunch.add(n),
    setOnSwitchTo: (f: (target: number, state: HealState) => void) => {
      onSwitchTo = f;
    },
  };
}

function makeHealer(
  state: HealState,
  cfgOverride: Record<string, unknown> = {},
  depsOverride: Partial<PrewarmerDeps> = {},
) {
  const { log, warnings } = makeLog();
  const fake = makeHealRunner(state);
  const prewarmer = new Prewarmer({
    cswap: new Cswap("cswap", fake.runner),
    cfg: parseConfig(cfgOverride),
    log,
    backupRoot: "/tmp/backup-root",
    existsSync: () => true,
    now: () => "2026-06-29T00:00:00.000Z",
    ...depsOverride,
  });
  return { prewarmer, fake, warnings };
}

describe("Prewarmer.healUnavailable — threshold", () => {
  it("heals only after autoHealAfterCycles consecutive unavailable refreshes", async () => {
    const { prewarmer, fake } = makeHealer({
      active: 1,
      accts: [
        { number: 1, active: true },
        { number: 2, usageStatus: "unavailable" },
      ],
    });
    await prewarmer.refresh();

    // Cycle 1: streak=1 < 2 → no dance.
    await prewarmer.healUnavailable();
    expect(fake.switchCalls).toHaveLength(0);
    expect(prewarmer.lastHeal).toBeNull();

    // Cycle 2: streak=2 ≥ 2 → dance, then list reports account 2 ok.
    await prewarmer.healUnavailable();
    expect(fake.switchCalls).toEqual([2, 1]);
    expect(prewarmer.lastHeal?.target).toBe(2);
    expect(prewarmer.lastHeal?.outcome).toBe("healed");
    expect(prewarmer.lastHeal?.restoreFailed).toBe(false);
    expect(prewarmer.restoreFailure).toBeNull();
    expect(prewarmer.activeAccountNumber).toBe(1);
  });
});

describe("Prewarmer.healUnavailable — one attempt per episode", () => {
  it("does not re-attempt a still-unavailable target, but heals a fresh episode", async () => {
    const { prewarmer, fake } = makeHealer({
      active: 1,
      accts: [
        { number: 1, active: true },
        { number: 2, usageStatus: "unavailable" },
      ],
    });
    // The launch does NOT heal account 2 (stays unavailable).
    fake.setHealsOnLaunch(false);
    await prewarmer.refresh();

    await prewarmer.healUnavailable(); // streak 1
    await prewarmer.healUnavailable(); // streak 2 → dance, but stays unavailable
    expect(fake.switchCalls).toEqual([2, 1]);
    expect(prewarmer.lastHeal?.outcome).toBe("failed");

    // Subsequent ticks: same episode, already attempted → no further switches.
    await prewarmer.healUnavailable();
    await prewarmer.healUnavailable();
    expect(fake.switchCalls).toEqual([2, 1]);

    // Account 2 recovers, then goes unavailable again → fresh episode heals.
    fake.setHealsOnLaunch(true);
    fake.state.accts[1]!.usageStatus = "ok";
    await prewarmer.refresh(); // pool sees account 2 ok
    await prewarmer.healUnavailable(); // resets streak/episode for account 2
    fake.state.accts[1]!.usageStatus = "unavailable";
    await prewarmer.refresh(); // pool sees account 2 unavailable again
    await prewarmer.healUnavailable(); // streak 1
    await prewarmer.healUnavailable(); // streak 2 → dance again
    expect(fake.switchCalls).toEqual([2, 1, 2, 1]);
    expect(prewarmer.lastHeal?.outcome).toBe("healed");
  });
});

describe("Prewarmer.healUnavailable — one target per tick", () => {
  it("heals exactly the lowest-numbered qualifier per call", async () => {
    const { prewarmer, fake } = makeHealer({
      active: 1,
      accts: [
        { number: 1, active: true },
        { number: 2, usageStatus: "unavailable" },
        { number: 3, usageStatus: "unavailable" },
      ],
    });
    await prewarmer.refresh();

    await prewarmer.healUnavailable(); // streaks → 1
    await prewarmer.healUnavailable(); // streaks → 2 → heal lowest (2)
    expect(fake.switchCalls).toEqual([2, 1]);
    expect(prewarmer.lastHeal?.target).toBe(2);

    await prewarmer.healUnavailable(); // account 3 streak → 3 → heal it
    expect(fake.switchCalls).toEqual([2, 1, 3, 1]);
    expect(prewarmer.lastHeal?.target).toBe(3);
  });
});

describe("Prewarmer.healUnavailable — scope", () => {
  it("never heals excluded / reason!=unavailable / usageUnavailable accounts", async () => {
    const { prewarmer, fake } = makeHealer(
      {
        active: 1,
        accts: [
          { number: 1, active: true },
          { number: 2, usageStatus: "unavailable" }, // excluded
          { number: 3, fiveHourPct: null, sevenDayPct: null }, // usageUnavailable (ok, null pcts)
          { number: 4, usageStatus: "token_expired" }, // reason != unavailable
        ],
      },
      { excludeSlots: [2] },
    );
    await prewarmer.refresh();

    for (let i = 0; i < 4; i++) await prewarmer.healUnavailable();
    expect(fake.switchCalls).toHaveLength(0);
    expect(prewarmer.lastHeal).toBeNull();
  });

  it("never heals a not-in-include unavailable account", async () => {
    const { prewarmer, fake } = makeHealer(
      {
        active: 1,
        accts: [
          { number: 1, active: true },
          { number: 5, usageStatus: "unavailable" }, // not in includeSlots
        ],
      },
      { includeSlots: [1] },
    );
    await prewarmer.refresh();
    for (let i = 0; i < 3; i++) await prewarmer.healUnavailable();
    expect(fake.switchCalls).toHaveLength(0);
  });

  it("never heals the active account even when unavailable", async () => {
    const { prewarmer, fake } = makeHealer({
      active: 1,
      accts: [{ number: 1, active: true, usageStatus: "unavailable" }],
    });
    await prewarmer.refresh();
    for (let i = 0; i < 3; i++) await prewarmer.healUnavailable();
    expect(fake.switchCalls).toHaveLength(0);
  });

  it("never heals an out-of-rotation account even when unavailable", async () => {
    const outOfRotation = new Set<number>([2]);
    const { prewarmer, fake } = makeHealer(
      {
        active: 1,
        accts: [
          { number: 1, active: true },
          { number: 2, usageStatus: "unavailable" }, // taken out of rotation
        ],
      },
      {},
      { outOfRotation },
    );
    await prewarmer.refresh();
    for (let i = 0; i < 4; i++) await prewarmer.healUnavailable();
    expect(fake.switchCalls).toHaveLength(0);
    expect(prewarmer.lastHeal).toBeNull();
  });
});

describe("Prewarmer.refresh — out-of-rotation set", () => {
  it("classifies a member as usable:false, reason:'out-of-rotation'", async () => {
    const { prewarmer } = makePrewarmer({ outOfRotation: new Set([2]) });
    await prewarmer.refresh();
    const acct2 = prewarmer.pool.find((a) => a.number === 2);
    expect(acct2?.usable).toBe(false);
    expect(acct2?.reason).toBe("out-of-rotation");
  });

  it("observes a set mutation on the next refresh (shared by reference)", async () => {
    const outOfRotation = new Set<number>();
    const { prewarmer } = makePrewarmer({ outOfRotation });
    await prewarmer.refresh();
    expect(prewarmer.pool.find((a) => a.number === 2)?.usable).toBe(true);

    // Owner (index.ts route) mutates the same object; next refresh must reflect it.
    outOfRotation.add(2);
    await prewarmer.refresh();
    expect(prewarmer.pool.find((a) => a.number === 2)?.usable).toBe(false);
    expect(prewarmer.pool.find((a) => a.number === 2)?.reason).toBe("out-of-rotation");

    // And returning it (delete) restores usability.
    outOfRotation.delete(2);
    await prewarmer.refresh();
    expect(prewarmer.pool.find((a) => a.number === 2)?.usable).toBe(true);
  });
});

describe("Prewarmer.healUnavailable — stale snapshot", () => {
  it("does nothing while lastError is set", async () => {
    const { prewarmer, fake } = makeHealer({
      active: 1,
      accts: [
        { number: 1, active: true },
        { number: 2, usageStatus: "unavailable" },
      ],
    });
    await prewarmer.refresh(); // ok, pool populated
    fake.setListFails(true);
    await prewarmer.refresh(); // lastError set, snapshot kept
    expect(prewarmer.lastError).not.toBeNull();

    for (let i = 0; i < 3; i++) await prewarmer.healUnavailable();
    expect(fake.switchCalls).toHaveLength(0);
    expect(prewarmer.lastHeal).toBeNull();
  });
});

describe("Prewarmer.healUnavailable — autoHeal:false", () => {
  it("disables everything", async () => {
    const { prewarmer, fake } = makeHealer(
      {
        active: 1,
        accts: [
          { number: 1, active: true },
          { number: 2, usageStatus: "unavailable" },
        ],
      },
      { autoHeal: false },
    );
    await prewarmer.refresh();
    for (let i = 0; i < 5; i++) await prewarmer.healUnavailable();
    expect(fake.switchCalls).toHaveLength(0);
    expect(prewarmer.lastHeal).toBeNull();
  });
});

describe("Prewarmer.healUnavailable — restore failure", () => {
  it("records restoreFailure when post-dance active is wrong (no throw)", async () => {
    const failures: HealRestoreFailure[] = [];
    const { prewarmer, fake } = makeHealer(
      {
        active: 1,
        accts: [
          { number: 1, active: true },
          { number: 2, usageStatus: "unavailable" },
        ],
      },
      {},
      { onRestoreFailure: (info) => failures.push(info) },
    );
    // Switch to 2 makes it active (the launch then heals it); switching back to 1 has NO effect.
    fake.setOnSwitchTo((target, state) => {
      if (target === 2) {
        state.active = 2;
        for (const a of state.accts) a.active = a.number === 2;
      }
      // target === 1: silently no-op → restore lands on the wrong account.
    });
    await prewarmer.refresh();
    await prewarmer.healUnavailable();
    await prewarmer.healUnavailable();

    expect(fake.switchCalls).toEqual([2, 1]);
    expect(prewarmer.restoreFailure).toEqual({
      at: "2026-06-29T00:00:00.000Z",
      intendedActive: 1,
      landedActive: 2,
    });
    expect(failures).toHaveLength(1);
    expect(prewarmer.lastHeal?.restoreFailed).toBe(true);
  });

  it("clears restoreFailure and fires onRestoreRecovered when intended primary is active again", async () => {
    let recovered = 0;
    const { prewarmer } = makeHealer(
      { active: 1, accts: [{ number: 1, active: true }] },
      {},
      {
        initialRestoreFailure: { at: "x", intendedActive: 1, landedActive: 2 },
        onRestoreRecovered: () => {
          recovered += 1;
        },
      },
    );
    expect(prewarmer.restoreFailure).not.toBeNull();
    await prewarmer.refresh(); // active === 1 === intendedActive → clears
    expect(prewarmer.restoreFailure).toBeNull();
    expect(recovered).toBe(1);
  });
});

describe("Prewarmer — initialRestoreFailure seed", () => {
  it("seeds restoreFailure on construction", () => {
    const seed: HealRestoreFailure = { at: "boot", intendedActive: 3, landedActive: 4 };
    const { prewarmer } = makeHealer(
      { active: 1, accts: [{ number: 1, active: true }] },
      {},
      { initialRestoreFailure: seed },
    );
    expect(prewarmer.restoreFailure).toEqual(seed);
  });
});

describe("Prewarmer.healUnavailable — active account unknown", () => {
  it("skips the dance when activeAccountNumber is undefined", async () => {
    const { prewarmer, fake, warnings } = makeHealer({
      active: undefined,
      accts: [{ number: 2, usageStatus: "unavailable" }],
    });
    await prewarmer.refresh();
    expect(prewarmer.activeAccountNumber).toBeUndefined();
    await prewarmer.healUnavailable();
    await prewarmer.healUnavailable();
    expect(fake.switchCalls).toHaveLength(0);
    expect(warnings.some((w) => w.includes("active account unknown"))).toBe(true);
  });
});

describe("Prewarmer.healUnavailable — post-dance refresh failure (fail closed)", () => {
  it("treats failed post-dance refresh as restore failure with landedActive null", async () => {
    const failures: HealRestoreFailure[] = [];
    const { prewarmer, fake } = makeHealer(
      {
        active: 1,
        accts: [
          { number: 1, active: true },
          { number: 2, usageStatus: "unavailable" },
        ],
      },
      {},
      { onRestoreFailure: (info) => failures.push(info) },
    );
    // Switch to 2 makes it active (the launch then heals it); restore to 1 is a non-throwing
    // no-op (state stays on 2). After the restore switch, list starts failing so the post-dance
    // refresh blows up.
    fake.setOnSwitchTo((target, state) => {
      if (target === 2) {
        state.active = 2;
        for (const a of state.accts) a.active = a.number === 2;
      }
      // target === 1: deliberate no-op (simulates stuck restore); trigger post-dance list failure.
      if (target === 1) {
        fake.setListFails(true);
      }
    });

    await prewarmer.refresh(); // ok — pool populated, streak 0
    await prewarmer.healUnavailable(); // streak 1 → no dance
    await prewarmer.healUnavailable(); // streak 2 → dance fires; post-dance list fails

    expect(prewarmer.restoreFailure).toEqual({
      at: "2026-06-29T00:00:00.000Z",
      intendedActive: 1,
      landedActive: null,
    });
    expect(failures).toHaveLength(1);
    expect(prewarmer.lastHeal?.restoreFailed).toBe(true);
    expect(prewarmer.lastHeal?.outcome).toBe("failed");
  });
});

describe("Prewarmer.healUnavailable — target switch fails", () => {
  it("records failed heal and skips restore when switching to target throws", async () => {
    const { prewarmer, fake } = makeHealer({
      active: 1,
      accts: [
        { number: 1, active: true },
        { number: 2, usageStatus: "unavailable" },
      ],
    });
    fake.failSwitch(2);
    await prewarmer.refresh();
    await prewarmer.healUnavailable();
    await prewarmer.healUnavailable();
    expect(fake.switchCalls).toEqual([2]); // no restore switch attempted
    expect(prewarmer.lastHeal).toEqual({
      at: "2026-06-29T00:00:00.000Z",
      target: 2,
      outcome: "failed",
      restoreFailed: false,
    });
    expect(prewarmer.restoreFailure).toBeNull();
  });
});

describe("Prewarmer.healUnavailable — launches a Claude session against the target", () => {
  it("launches the stuck account, ordered between switch-to-target and switch-to-original", async () => {
    const { prewarmer, fake } = makeHealer({
      active: 1,
      accts: [
        { number: 1, active: true },
        { number: 2, usageStatus: "unavailable" },
      ],
    });
    await prewarmer.refresh();
    await prewarmer.healUnavailable(); // streak 1
    await prewarmer.healUnavailable(); // streak 2 → dance

    expect(fake.launchedAccounts).toContain(2);
    // Ordering: switch→2, run→2, switch→1.
    expect(fake.callLog).toEqual([
      { kind: "switch", target: 2 },
      { kind: "run", target: 2 },
      { kind: "switch", target: 1 },
    ]);
    expect(prewarmer.lastHeal?.outcome).toBe("healed");
  });
});

describe("Prewarmer.healUnavailable — launch failure still restores + records", () => {
  it("a failed launch still restores the prior primary and records lastHeal (warns, no throw)", async () => {
    const { prewarmer, fake, warnings } = makeHealer({
      active: 1,
      accts: [
        { number: 1, active: true },
        { number: 2, usageStatus: "unavailable" },
      ],
    });
    fake.failLaunch(2); // the run against the target returns non-zero
    await prewarmer.refresh();
    await prewarmer.healUnavailable(); // streak 1
    await expect(prewarmer.healUnavailable()).resolves.toBeUndefined(); // streak 2 → dance

    expect(fake.launchedAccounts).toContain(2);
    expect(fake.switchCalls).toEqual([2, 1]); // restore still happened
    expect(prewarmer.lastHeal?.target).toBe(2);
    expect(prewarmer.lastHeal?.outcome).toBe("failed"); // launch failed → not healed
    expect(prewarmer.restoreFailure).toBeNull();
    expect(warnings.some((w) => w.includes("claude session launch for 2 failed"))).toBe(true);
  });
});

describe("Prewarmer.healUnavailable — deferred-outcome reconcile (cache race)", () => {
  it("reconciles a false-negative failed → healed on a later fresh, settled refresh", async () => {
    const { prewarmer, fake } = makeHealer({
      active: 1,
      accts: [
        { number: 1, active: true },
        { number: 2, usageStatus: "unavailable" },
      ],
    });
    await prewarmer.refresh();
    await prewarmer.healUnavailable(); // streak 1
    // Launch heals the backing state, but the immediate post-dance --list serves the cached
    // (pre-heal) unavailable snapshot → first heal records "failed" with a pending reconcile.
    fake.serveStaleListOnce();
    await prewarmer.healUnavailable(); // streak 2 → dance; post-dance read is the stale snapshot
    expect(prewarmer.lastHeal?.target).toBe(2);
    expect(prewarmer.lastHeal?.outcome).toBe("failed");

    // A subsequent tick: fresh --list now returns account 2 ok → reconcile flips to "healed".
    await prewarmer.refresh();
    await prewarmer.healUnavailable();
    expect(prewarmer.lastHeal?.outcome).toBe("healed");
  });

  it("skips reconcile on a failed-refresh tick; the next successful-refresh tick reconciles", async () => {
    const { prewarmer, fake } = makeHealer({
      active: 1,
      accts: [
        { number: 1, active: true },
        { number: 2, usageStatus: "unavailable" },
      ],
    });
    await prewarmer.refresh();
    await prewarmer.healUnavailable(); // streak 1
    fake.serveStaleListOnce();
    await prewarmer.healUnavailable(); // streak 2 → dance; false-negative "failed", reconcile armed
    expect(prewarmer.lastHeal?.outcome).toBe("failed");

    // Failed-refresh tick: lastError set → reconcile must be skipped.
    fake.setListFails(true);
    await prewarmer.refresh();
    await prewarmer.healUnavailable();
    expect(prewarmer.lastHeal?.outcome).toBe("failed"); // unchanged

    // Successful-refresh tick: account 2 ok → reconcile flips to "healed".
    fake.setListFails(false);
    await prewarmer.refresh();
    await prewarmer.healUnavailable();
    expect(prewarmer.lastHeal?.outcome).toBe("healed");
  });

  it("clears the pending marker without judging when the target is absent from the fresh pool", async () => {
    const { prewarmer, fake } = makeHealer({
      active: 1,
      accts: [
        { number: 1, active: true },
        { number: 2, usageStatus: "unavailable" },
      ],
    });
    await prewarmer.refresh();
    await prewarmer.healUnavailable(); // streak 1
    // No stale list — post-dance read shows account 2 ok → reconcile flips to "healed" immediately.
    await prewarmer.healUnavailable(); // streak 2 → dance; account 2 ok → outcome "healed", reconcile armed
    expect(prewarmer.lastHeal?.outcome).toBe("healed");

    // Account 2 leaves the pool before the reconcile tick; reconcile is still pending.
    fake.state.accts = fake.state.accts.filter((a) => a.number !== 2);
    await prewarmer.refresh();
    await prewarmer.healUnavailable();
    // Absent target → early return without judging; "healed" must NOT be flipped to "failed".
    expect(prewarmer.lastHeal?.outcome).toBe("healed");
  });
});

// ---------------------------------------------------------------------------
// Auto-heal must skip an account cswap has parked. Healing switches the PRIMARY
// onto its target, so treating a `cswap disable`d account as a heal candidate
// would drag it back into active use behind the operator's back.
// ---------------------------------------------------------------------------

describe("Prewarmer.healUnavailable — cswap-disabled accounts are out of scope", () => {
  it("never selects a cswap-disabled account as a heal target", async () => {
    const { prewarmer, fake } = makeHealer({
      active: 1,
      accts: [
        { number: 1, active: true },
        { number: 2, usageStatus: "unavailable", disabled: true },
      ],
    });
    await prewarmer.refresh();

    // Two cycles is the configured threshold — an eligible account would dance here.
    await prewarmer.healUnavailable();
    await prewarmer.healUnavailable();

    expect(fake.switchCalls).toHaveLength(0);
    expect(prewarmer.lastHeal).toBeNull();
  });

  it("heals the same account once cswap enable clears the flag", async () => {
    const { prewarmer, fake } = makeHealer({
      active: 1,
      accts: [
        { number: 1, active: true },
        { number: 2, usageStatus: "unavailable" },
      ],
    });
    await prewarmer.refresh();
    await prewarmer.healUnavailable();
    await prewarmer.healUnavailable();

    expect(fake.switchCalls).toEqual([2, 1]);
    expect(prewarmer.lastHeal?.target).toBe(2);
  });
});
