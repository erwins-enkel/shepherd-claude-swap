import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface CswapUsageWindow {
  pct: number;
  resetsAt?: string;
}

export interface CswapAccount {
  number: number;
  email: string;
  active: boolean;
  usageStatus: string;
  usage: { fiveHour?: CswapUsageWindow; sevenDay?: CswapUsageWindow } | null;
}

export interface CswapListResult {
  schemaVersion: number;
  activeAccountNumber?: number;
  accounts: CswapAccount[];
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
}
