import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface CswapUsageWindow {
  pct: number;
  resetsAt?: string;
  countdown?: string;
  clock?: string;
}

/**
 * A WEEKLY window (`sevenDay` or a `scoped` entry) additionally carries pace fields (cswap 0.23+).
 * Both are absent when pace is not computable — cswap suppresses them for 24h after a window reset
 * — so both are optional and normalize to null/false.
 *
 * `projectedExhaustionAt` and `willLastToReset` are deliberately NOT typed: cswap documents them as
 * JSON-only because the linear projection has wide error bars, nothing here reads them, and typing
 * them would be dead data.
 */
export interface CswapWeeklyWindow extends CswapUsageWindow {
  expectedPct?: number;
  aheadOfPace?: boolean;
}

/** A per-model weekly limit window (e.g. "Fable"). Absent on cswap < the version that added it. */
export interface CswapScopedWindow extends CswapWeeklyWindow {
  name: string;
}

/**
 * Pay-as-you-go extra-usage budget (cswap 0.23+). cswap emits the entry only when used_credits,
 * monthly_limit AND utilization are all non-null, so those four are required here; an unlimited
 * plan (monthly_limit null) omits the whole entry rather than reporting a zero limit. `pct` is the
 * API's `utilization` verbatim and is NOT derivable from used/limit — a live account reports
 * used 100.33 / limit 100.00 with pct 100.0. The reset trio appears together or not at all.
 */
export interface CswapSpend {
  used: number;
  limit: number;
  pct: number;
  currency: string;
  resetsAt?: string;
  countdown?: string;
  clock?: string;
}

export interface CswapAccount {
  number: number;
  email: string;
  active: boolean;
  usageStatus: string;
  /** Short operator-set display name (cswap 0.21+). Emitted only when set. */
  alias?: string;
  /** Held out of cswap's own rotation via `cswap disable` (0.21+). Emitted only when true. */
  disabled?: boolean;
  organizationName?: string;
  /**
   * Age in seconds of the usage measurement AT EMIT TIME (cswap 0.23+) — how long cswap has been
   * serving this snapshot, not how long ago the plugin last polled. Emitted only alongside a
   * non-null `usage` and only when an age is known.
   */
  usageAgeSeconds?: number;
  usage: {
    fiveHour?: CswapUsageWindow;
    sevenDay?: CswapWeeklyWindow;
    spend?: CswapSpend;
    scoped?: CswapScopedWindow[];
  } | null;
}

export interface CswapListResult {
  schemaVersion: number;
  activeAccountNumber?: number;
  accounts: CswapAccount[];
}

export interface CswapSwitchRef {
  number: number | null;
  email: string;
}

export interface CswapSwitchResult {
  schemaVersion: number;
  switched: boolean;
  from: CswapSwitchRef;
  to: CswapSwitchRef;
  strategy: string;
  reason: string;
  message: string;
  warnings: string[];
}

/**
 * Injectable runner for tests: runs argv, resolves {stdout,stderr,code,timedOut}.
 * Default impl uses node:child_process execFile (promisified) — async, never sync.
 */
export type Runner = (
  bin: string,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }>;

const execFileAsync = promisify(execFile);

const defaultRunner: Runner = async (bin, args, { timeoutMs }) => {
  try {
    const result = await execFileAsync(bin, args, { timeout: timeoutMs, encoding: "utf8" });
    return {
      stdout: result.stdout as string,
      stderr: result.stderr as string,
      code: 0,
      timedOut: false,
    };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number | string | null;
      killed?: boolean;
    };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      code: typeof e.code === "number" ? e.code : 1,
      timedOut: e.killed === true,
    };
  }
};

const DEFAULT_LIST_TIMEOUT_MS = 30_000;
const DEFAULT_SWITCH_TIMEOUT_MS = 30_000;

/**
 * Extract the error message from a cswap JSON response envelope, or return null if no error.
 * Handles both structured ({error:{type,message}}) and plain-string ({error:string}) forms.
 */
function cswapErrorMessage(obj: Record<string, unknown>): string | null {
  // Documented structured error envelope: {schemaVersion, error: {type, message}}
  if (typeof obj["error"] === "object" && obj["error"] !== null) {
    const err = obj["error"] as Record<string, unknown>;
    return `cswap error: ${String(err["type"])}: ${String(err["message"])}`;
  }
  // Defensive: plain string error (mirrors list() discipline)
  if (typeof obj["error"] === "string") {
    return `cswap error: ${obj["error"]}`;
  }
  return null;
}

export class Cswap {
  private readonly bin: string;
  private readonly runner: Runner;

  constructor(bin: string, runner: Runner = defaultRunner) {
    this.bin = bin;
    this.runner = runner;
  }

  /**
   * `cswap --list --json`. Parse + require schemaVersion===1.
   * Throw on the documented error envelope ({schemaVersion,error}) or a
   * non-zero/non-JSON/timeout result.
   */
  async list(timeoutMs = DEFAULT_LIST_TIMEOUT_MS): Promise<CswapListResult> {
    const result = await this.runner(this.bin, ["--list", "--json"], { timeoutMs });

    if (result.timedOut) {
      throw new Error("cswap --list --json timed out");
    }

    if (result.code !== 0) {
      throw new Error(`cswap --list --json exited with code ${result.code}: ${result.stderr}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(`cswap --list --json returned non-JSON: ${result.stdout}`);
    }

    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("cswap --list --json returned invalid JSON (not an object)");
    }

    const obj = parsed as Record<string, unknown>;

    // Documented error envelope: {schemaVersion, error}
    if (typeof obj["error"] === "string") {
      throw new Error(`cswap error: ${obj["error"]}`);
    }

    if (obj["schemaVersion"] !== 1) {
      throw new Error(`unsupported cswap schema version: ${String(obj["schemaVersion"])}`);
    }

    if (!Array.isArray(obj["accounts"])) {
      throw new Error("cswap --list --json: missing accounts[]");
    }

    return obj as unknown as CswapListResult;
  }

  /**
   * `cswap run <accountNumber> -- <args>` to bootstrap/validate a session profile.
   * Returns {ok:true} on exit 0, else {ok:false,error}. Never throws on non-zero;
   * honors timeoutMs (kills + ok:false on timeout).
   */
  async prewarm(
    accountNumber: number,
    args: string[],
    timeoutMs: number,
  ): Promise<{ ok: boolean; error?: string }> {
    const argv = ["run", String(accountNumber), "--", ...args];

    let result: Awaited<ReturnType<Runner>>;
    try {
      result = await this.runner(this.bin, argv, { timeoutMs });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }

    if (result.timedOut) {
      return { ok: false, error: "timed out" };
    }

    if (result.code !== 0) {
      return {
        ok: false,
        error: result.stderr || `exited with code ${result.code}`,
      };
    }

    return { ok: true };
  }

  private parseSwitchResult(
    argv: string[],
    result: Awaited<ReturnType<Runner>>,
  ): CswapSwitchResult {
    const argStr = `cswap ${argv.join(" ")}`;

    if (result.timedOut) {
      throw new Error(`${argStr} timed out`);
    }

    if (result.code !== 0) {
      throw new Error(`${argStr} exited with code ${result.code}: ${result.stderr}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(`${argStr} returned non-JSON: ${result.stdout}`);
    }

    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`${argStr} returned invalid JSON (not an object)`);
    }

    const obj = parsed as Record<string, unknown>;

    const errMsg = cswapErrorMessage(obj);
    if (errMsg !== null) {
      throw new Error(errMsg);
    }

    if (obj["schemaVersion"] !== 1) {
      throw new Error(`unsupported cswap schema version: ${String(obj["schemaVersion"])}`);
    }

    return obj as unknown as CswapSwitchResult;
  }

  /**
   * `cswap --switch [--strategy <strategy>] --json`.
   * Rotate to the next account, or pick by remaining quota with a strategy.
   */
  async switch(
    strategy?: "best" | "next-available",
    timeoutMs = DEFAULT_SWITCH_TIMEOUT_MS,
  ): Promise<CswapSwitchResult> {
    const argv = ["--switch", ...(strategy ? ["--strategy", strategy] : []), "--json"];
    const result = await this.runner(this.bin, argv, { timeoutMs });
    return this.parseSwitchResult(argv, result);
  }

  /**
   * `cswap --switch-to <target> --json`.
   * Switch to a specific account by number or email.
   */
  async switchTo(
    target: number | string,
    timeoutMs = DEFAULT_SWITCH_TIMEOUT_MS,
  ): Promise<CswapSwitchResult> {
    const argv = ["--switch-to", String(target), "--json"];
    const result = await this.runner(this.bin, argv, { timeoutMs });
    return this.parseSwitchResult(argv, result);
  }
}
