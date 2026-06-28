import { describe, expect, it } from "bun:test";
import { Prewarmer, type PrewarmerDeps } from "../src/prewarm";
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

describe("Prewarmer.warm — profile-dir existence guard", () => {
  it("prewarm ok but derived dir absent → account NOT added to ready", async () => {
    const { prewarmer, warnings } = makePrewarmer({ existsSync: () => false });
    await prewarmer.refresh(); // populate pool from fixture (account 1 usable)
    await prewarmer.warm(1);
    expect(prewarmer.ready.has(1)).toBe(false);
    expect(warnings.some((w) => w.includes("profile dir is absent"))).toBe(true);
  });

  it("prewarm ok and derived dir present → account added to ready", async () => {
    const { prewarmer } = makePrewarmer({ existsSync: () => true });
    await prewarmer.refresh();
    await prewarmer.warm(1);
    expect(prewarmer.ready.has(1)).toBe(true);
  });

  it("checks the dir derived from backupRoot + account email", async () => {
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
    expect(checked).toContain("/custom/root/sessions/1-acct1_example.com");
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
