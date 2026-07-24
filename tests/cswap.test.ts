import { describe, expect, it } from "bun:test";
import { Cswap, type CswapListResult, type Runner } from "../src/cswap";
import fixtureRaw from "../docs/contracts/cswap-list.sample.json";
import switchFixtureRaw from "../docs/contracts/cswap-switch.sample.json";
import sample023Raw from "../docs/contracts/cswap-list-0.23.sample.json";

/** Capture the last call to the runner. */
function makeRunner(response: {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}): { runner: Runner; calls: { bin: string; args: string[]; timeoutMs: number }[] } {
  const calls: { bin: string; args: string[]; timeoutMs: number }[] = [];
  const runner: Runner = async (bin, args, { timeoutMs }) => {
    calls.push({ bin, args, timeoutMs });
    return response;
  };
  return { runner, calls };
}

const fixtureStdout = JSON.stringify(fixtureRaw);
const switchFixtureStdout = JSON.stringify(switchFixtureRaw);

describe("Cswap.list()", () => {
  it("passes correct argv to runner: ['--list','--json']", async () => {
    const { runner, calls } = makeRunner({
      stdout: fixtureStdout,
      stderr: "",
      code: 0,
      timedOut: false,
    });
    const cswap = new Cswap("cswap", runner);
    await cswap.list();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["--list", "--json"]);
  });

  it("uses the injected bin name", async () => {
    const { runner, calls } = makeRunner({
      stdout: fixtureStdout,
      stderr: "",
      code: 0,
      timedOut: false,
    });
    const cswap = new Cswap("/custom/cswap", runner);
    await cswap.list();
    expect(calls[0]!.bin).toBe("/custom/cswap");
  });

  it("parses the committed fixture correctly", async () => {
    const { runner } = makeRunner({
      stdout: fixtureStdout,
      stderr: "",
      code: 0,
      timedOut: false,
    });
    const cswap = new Cswap("cswap", runner);
    const result = await cswap.list();
    expect(result.schemaVersion).toBe(1);
    expect(result.activeAccountNumber).toBe(1);
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts[0]!.number).toBe(1);
    expect(result.accounts[0]!.email).toBe("acct1@example.com");
    expect(result.accounts[0]!.active).toBe(true);
    expect(result.accounts[0]!.usageStatus).toBe("ok");
    expect(result.accounts[0]!.usage?.fiveHour?.pct).toBe(93);
    expect(result.accounts[0]!.usage?.sevenDay?.pct).toBe(19);
    expect(result.accounts[1]!.number).toBe(2);
    expect(result.accounts[1]!.email).toBe("acct2@example.com");
    expect(result.accounts[1]!.active).toBe(false);
    expect(result.accounts[1]!.usage?.fiveHour?.pct).toBe(0);
    expect(result.accounts[1]!.usage?.sevenDay?.pct).toBe(98);
  });

  it("carries usage.scoped through when present in the fixture (acct1 Fable window)", async () => {
    const { runner } = makeRunner({
      stdout: fixtureStdout,
      stderr: "",
      code: 0,
      timedOut: false,
    });
    const cswap = new Cswap("cswap", runner);
    const result = await cswap.list();
    expect(result.accounts[0]!.usage?.scoped).toHaveLength(1);
    expect(result.accounts[0]!.usage?.scoped?.[0]!.name).toBe("Fable");
    expect(result.accounts[0]!.usage?.scoped?.[0]!.pct).toBe(42);
    expect(result.accounts[1]!.usage?.scoped).toBeUndefined();
  });

  it("throws on schemaVersion !== 1", async () => {
    const payload = JSON.stringify({ schemaVersion: 2, accounts: [] });
    const { runner } = makeRunner({ stdout: payload, stderr: "", code: 0, timedOut: false });
    const cswap = new Cswap("cswap", runner);
    await expect(cswap.list()).rejects.toThrow();
  });

  it("throws on error envelope {schemaVersion, error}", async () => {
    const payload = JSON.stringify({
      schemaVersion: 1,
      error: "account locked",
    });
    const { runner } = makeRunner({ stdout: payload, stderr: "", code: 0, timedOut: false });
    const cswap = new Cswap("cswap", runner);
    await expect(cswap.list()).rejects.toThrow("account locked");
  });

  it("throws on non-zero exit code", async () => {
    const { runner } = makeRunner({
      stdout: "",
      stderr: "cswap: fatal error",
      code: 1,
      timedOut: false,
    });
    const cswap = new Cswap("cswap", runner);
    await expect(cswap.list()).rejects.toThrow();
  });

  it("throws on timeout", async () => {
    const { runner } = makeRunner({
      stdout: "",
      stderr: "",
      code: 1,
      timedOut: true,
    });
    const cswap = new Cswap("cswap", runner);
    await expect(cswap.list()).rejects.toThrow();
  });

  it("throws on schemaVersion 1 with missing accounts[]", async () => {
    const payload = JSON.stringify({ schemaVersion: 1 });
    const { runner } = makeRunner({ stdout: payload, stderr: "", code: 0, timedOut: false });
    const cswap = new Cswap("cswap", runner);
    await expect(cswap.list()).rejects.toThrow("cswap --list --json: missing accounts[]");
  });

  it("throws on schemaVersion 1 with non-array accounts", async () => {
    const payload = JSON.stringify({ schemaVersion: 1, accounts: { not: "an array" } });
    const { runner } = makeRunner({ stdout: payload, stderr: "", code: 0, timedOut: false });
    const cswap = new Cswap("cswap", runner);
    await expect(cswap.list()).rejects.toThrow("cswap --list --json: missing accounts[]");
  });

  it("throws on non-JSON stdout", async () => {
    const { runner } = makeRunner({
      stdout: "not json",
      stderr: "",
      code: 0,
      timedOut: false,
    });
    const cswap = new Cswap("cswap", runner);
    await expect(cswap.list()).rejects.toThrow();
  });

  it("passes timeoutMs to runner", async () => {
    const { runner, calls } = makeRunner({
      stdout: fixtureStdout,
      stderr: "",
      code: 0,
      timedOut: false,
    });
    const cswap = new Cswap("cswap", runner);
    await cswap.list(5000);
    expect(calls[0]!.timeoutMs).toBe(5000);
  });
});

describe("Cswap.prewarm()", () => {
  it("passes correct argv to runner: ['run','2','--','--version']", async () => {
    const { runner, calls } = makeRunner({
      stdout: "",
      stderr: "",
      code: 0,
      timedOut: false,
    });
    const cswap = new Cswap("cswap", runner);
    await cswap.prewarm(2, ["--version"], 10000);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["run", "2", "--", "--version"]);
  });

  it("passes timeoutMs to runner", async () => {
    const { runner, calls } = makeRunner({
      stdout: "",
      stderr: "",
      code: 0,
      timedOut: false,
    });
    const cswap = new Cswap("cswap", runner);
    await cswap.prewarm(1, ["--version"], 15000);
    expect(calls[0]!.timeoutMs).toBe(15000);
  });

  it("returns {ok:true} on exit code 0", async () => {
    const { runner } = makeRunner({
      stdout: "Claude 2.1.195",
      stderr: "",
      code: 0,
      timedOut: false,
    });
    const cswap = new Cswap("cswap", runner);
    const result = await cswap.prewarm(1, ["--version"], 10000);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns {ok:false, error} on non-zero exit without throwing", async () => {
    const { runner } = makeRunner({
      stdout: "",
      stderr: "something went wrong",
      code: 1,
      timedOut: false,
    });
    const cswap = new Cswap("cswap", runner);
    const result = await cswap.prewarm(1, ["--version"], 10000);
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
  });

  it("returns {ok:false, error:'timed out'} on timeout without throwing", async () => {
    const { runner } = makeRunner({
      stdout: "",
      stderr: "",
      code: 1,
      timedOut: true,
    });
    const cswap = new Cswap("cswap", runner);
    const result = await cswap.prewarm(1, ["--version"], 10000);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("timed out");
  });

  it("handles multiple args after --", async () => {
    const { runner, calls } = makeRunner({
      stdout: "",
      stderr: "",
      code: 0,
      timedOut: false,
    });
    const cswap = new Cswap("cswap", runner);
    await cswap.prewarm(3, ["--flag", "value"], 10000);
    expect(calls[0]!.args).toEqual(["run", "3", "--", "--flag", "value"]);
  });
});

describe("Cswap.switch()", () => {
  it("passes argv ['--switch','--json'] for plain switch()", async () => {
    const { runner, calls } = makeRunner({
      stdout: switchFixtureStdout,
      stderr: "",
      code: 0,
      timedOut: false,
    });
    const cswap = new Cswap("cswap", runner);
    const result = await cswap.switch();
    expect(calls[0]!.args).toEqual(["--switch", "--json"]);
    expect(result.schemaVersion).toBe(1);
  });

  it("passes argv ['--switch','--strategy','best','--json'] for switch('best')", async () => {
    const { runner, calls } = makeRunner({
      stdout: switchFixtureStdout,
      stderr: "",
      code: 0,
      timedOut: false,
    });
    const cswap = new Cswap("cswap", runner);
    await cswap.switch("best");
    expect(calls[0]!.args).toEqual(["--switch", "--strategy", "best", "--json"]);
  });

  it("throws on timeout", async () => {
    const { runner } = makeRunner({ stdout: "", stderr: "", code: 1, timedOut: true });
    const cswap = new Cswap("cswap", runner);
    await expect(cswap.switch()).rejects.toThrow();
  });

  it("throws on non-zero exit code", async () => {
    const { runner } = makeRunner({
      stdout: "",
      stderr: "cswap: fatal error",
      code: 1,
      timedOut: false,
    });
    const cswap = new Cswap("cswap", runner);
    await expect(cswap.switch()).rejects.toThrow();
  });

  it("throws on non-JSON stdout", async () => {
    const { runner } = makeRunner({ stdout: "not json", stderr: "", code: 0, timedOut: false });
    const cswap = new Cswap("cswap", runner);
    await expect(cswap.switch()).rejects.toThrow();
  });

  it("throws on schemaVersion !== 1", async () => {
    const payload = JSON.stringify({ schemaVersion: 2, switched: false });
    const { runner } = makeRunner({ stdout: payload, stderr: "", code: 0, timedOut: false });
    const cswap = new Cswap("cswap", runner);
    await expect(cswap.switch()).rejects.toThrow();
  });
});

describe("Cswap.switchTo()", () => {
  it("passes argv ['--switch-to','2','--json'] for switchTo(2)", async () => {
    const { runner, calls } = makeRunner({
      stdout: switchFixtureStdout,
      stderr: "",
      code: 0,
      timedOut: false,
    });
    const cswap = new Cswap("cswap", runner);
    await cswap.switchTo(2);
    expect(calls[0]!.args).toEqual(["--switch-to", "2", "--json"]);
  });

  it("returns parsed result for switchTo(3)", async () => {
    const { runner } = makeRunner({
      stdout: switchFixtureStdout,
      stderr: "",
      code: 0,
      timedOut: false,
    });
    const cswap = new Cswap("cswap", runner);
    const result = await cswap.switchTo(3);
    expect(result.schemaVersion).toBe(1);
    expect(result.switched).toBe(false);
    expect(result.strategy).toBe("direct");
    expect(result.from.number).toBe(3);
    expect(result.from.email).toBe("pat@ovr.ltd");
  });

  it("resolves without throwing when switched:false (already-active)", async () => {
    const { runner } = makeRunner({
      stdout: switchFixtureStdout,
      stderr: "",
      code: 0,
      timedOut: false,
    });
    const cswap = new Cswap("cswap", runner);
    const result = await cswap.switchTo(3);
    expect(result.switched).toBe(false);
    expect(result.reason).toBe("already-active");
  });

  it("throws on structured error envelope containing type and message", async () => {
    const payload = JSON.stringify({
      schemaVersion: 1,
      error: { type: "AccountNotFoundError", message: "Account-999 does not exist" },
    });
    const { runner } = makeRunner({ stdout: payload, stderr: "", code: 0, timedOut: false });
    const cswap = new Cswap("cswap", runner);
    const err = await cswap.switchTo(999).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("AccountNotFoundError");
    expect((err as Error).message).toContain("Account-999 does not exist");
  });

  it("throws on timeout", async () => {
    const { runner } = makeRunner({ stdout: "", stderr: "", code: 1, timedOut: true });
    const cswap = new Cswap("cswap", runner);
    await expect(cswap.switchTo(1)).rejects.toThrow();
  });

  it("throws on non-zero exit code", async () => {
    const { runner } = makeRunner({
      stdout: "",
      stderr: "fatal error",
      code: 2,
      timedOut: false,
    });
    const cswap = new Cswap("cswap", runner);
    await expect(cswap.switchTo(1)).rejects.toThrow();
  });

  it("throws on non-JSON stdout", async () => {
    const { runner } = makeRunner({ stdout: "not json", stderr: "", code: 0, timedOut: false });
    const cswap = new Cswap("cswap", runner);
    await expect(cswap.switchTo(1)).rejects.toThrow();
  });

  it("throws on schemaVersion !== 1", async () => {
    const payload = JSON.stringify({ schemaVersion: 99, switched: true });
    const { runner } = makeRunner({ stdout: payload, stderr: "", code: 0, timedOut: false });
    const cswap = new Cswap("cswap", runner);
    await expect(cswap.switchTo(1)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 0.23 field contract — LAYER 1: the typed accessor must reach every newly
// consumed key on output captured from the real CLI.
//
// Every new field is optional, and `list()` casts the parsed JSON to the
// interface without per-field validation — so an interface key that disagrees
// with what cswap actually emits reads back `undefined` rather than failing
// anywhere. Asserting through the TYPED accessor is what catches that: rename
// `usageAgeSeconds` in the interface and this test goes red.
//
// Layer 2 (normalization, in accounts.test.ts) covers the independent case of
// a reader that misspells the key. See docs/contracts/cswap-0.23-fields.md.
// ---------------------------------------------------------------------------

describe("Cswap.list — 0.23 fields, captured from the real CLI", () => {
  async function listCaptured(): Promise<CswapListResult> {
    const { runner } = makeRunner({
      stdout: JSON.stringify(sample023Raw),
      stderr: "",
      code: 0,
      timedOut: false,
    });
    return new Cswap("cswap", runner).list();
  }

  it("reaches alias / disabled / organizationName / usageAgeSeconds through the typed accessor", async () => {
    const result = await listCaptured();
    const parked = result.accounts.find((a) => a.disabled === true);
    expect(parked).toBeDefined();
    expect(parked?.alias).toBe("devbox");

    for (const acct of result.accounts) {
      expect(typeof acct.organizationName).toBe("string");
      // 0.0 is a legitimate age — assert on the type, never on truthiness.
      expect(typeof acct.usageAgeSeconds).toBe("number");
      expect(Number.isFinite(acct.usageAgeSeconds)).toBe(true);
    }
  });

  it("reaches every spend sub-field on the accounts that report a plan", async () => {
    const result = await listCaptured();
    const withSpend = result.accounts.filter((a) => a.usage?.spend !== undefined);
    expect(withSpend.length).toBeGreaterThan(0);

    for (const acct of withSpend) {
      const spend = acct.usage?.spend;
      expect(typeof spend?.used).toBe("number");
      expect(typeof spend?.limit).toBe("number");
      expect(typeof spend?.pct).toBe("number");
      expect(typeof spend?.currency).toBe("string");
    }
  });

  it("reaches pace fields on both sevenDay and a scoped window", async () => {
    const result = await listCaptured();

    const weekly = result.accounts.map((a) => a.usage?.sevenDay).filter((w) => w !== undefined);
    expect(weekly.length).toBeGreaterThan(0);
    for (const w of weekly) {
      expect(typeof w?.expectedPct).toBe("number");
      expect(typeof w?.aheadOfPace).toBe("boolean");
    }
    // The capture caught a genuinely ahead-of-pace window; pin that the `true`
    // case is represented, not just the field's presence.
    expect(weekly.some((w) => w?.aheadOfPace === true)).toBe(true);

    const scoped = result.accounts.flatMap((a) => a.usage?.scoped ?? []);
    expect(scoped.length).toBeGreaterThan(0);
    for (const w of scoped) {
      expect(typeof w.name).toBe("string");
      expect(typeof w.expectedPct).toBe("number");
      expect(typeof w.aheadOfPace).toBe("boolean");
    }
  });
});
