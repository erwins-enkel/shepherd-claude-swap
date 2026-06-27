export type Strategy = "round-robin" | "least-used";

export interface ResolvedConfig {
  cswapBin: string;
  includeSlots: number[] | null;
  excludeSlots: number[];
  rateLimitPct: number;
  strategy: Strategy;
  prewarmArgs: string[];
  refreshIntervalMs: number;
  bootWarmTimeoutMs: number;
  abortOnEmpty: boolean;
}

function requireFiniteInt(val: unknown, name: string): number {
  if (typeof val !== "number" || !Number.isFinite(val) || !Number.isInteger(val)) {
    throw new Error(`${name}: expected finite integer, got ${JSON.stringify(val)}`);
  }
  return val;
}

function requireIntArray(val: unknown, name: string): number[] {
  if (!Array.isArray(val)) {
    throw new Error(`${name}: expected array, got ${JSON.stringify(val)}`);
  }
  return val.map((v: unknown, i: number) => requireFiniteInt(v, `${name}[${i}]`));
}

/**
 * Parse ctx.config (unknown record, {} when absent). Apply defaults, validate types/ranges
 * (bin non-empty string; slot arrays of finite ints; pct 0..1000; positive ms; bool).
 * Throw a clear Error on invalid config.
 */
export function parseConfig(raw: Record<string, unknown>): ResolvedConfig {
  // cswapBin
  const cswapBin = "cswapBin" in raw ? raw["cswapBin"] : "cswap";
  if (typeof cswapBin !== "string" || cswapBin.length === 0) {
    throw new Error(`cswapBin: expected non-empty string, got ${JSON.stringify(cswapBin)}`);
  }

  // includeSlots
  const rawInclude = "includeSlots" in raw ? raw["includeSlots"] : null;
  const includeSlots: number[] | null =
    rawInclude === null || rawInclude === undefined
      ? null
      : requireIntArray(rawInclude, "includeSlots");

  // excludeSlots
  const rawExclude = "excludeSlots" in raw ? raw["excludeSlots"] : [];
  const excludeSlots = requireIntArray(rawExclude, "excludeSlots");

  // rateLimitPct
  const rateLimitPct = "rateLimitPct" in raw ? raw["rateLimitPct"] : 100;
  if (
    typeof rateLimitPct !== "number" ||
    !Number.isFinite(rateLimitPct) ||
    rateLimitPct < 0 ||
    rateLimitPct > 1000
  ) {
    throw new Error(
      `rateLimitPct: expected number in [0, 1000], got ${JSON.stringify(rateLimitPct)}`,
    );
  }

  // strategy
  const strategy = "strategy" in raw ? raw["strategy"] : "round-robin";
  if (strategy !== "round-robin" && strategy !== "least-used") {
    throw new Error(
      `strategy: expected "round-robin" | "least-used", got ${JSON.stringify(strategy)}`,
    );
  }

  // prewarmArgs
  const rawPrewarm = "prewarmArgs" in raw ? raw["prewarmArgs"] : ["--version"];
  if (!Array.isArray(rawPrewarm)) {
    throw new Error(`prewarmArgs: expected array, got ${JSON.stringify(rawPrewarm)}`);
  }
  const prewarmArgs: string[] = rawPrewarm.map((v: unknown, i: number) => {
    if (typeof v !== "string") {
      throw new Error(`prewarmArgs[${i}]: expected string, got ${JSON.stringify(v)}`);
    }
    return v;
  });

  // refreshIntervalMs
  const refreshIntervalMs = "refreshIntervalMs" in raw ? raw["refreshIntervalMs"] : 60000;
  if (
    typeof refreshIntervalMs !== "number" ||
    !Number.isFinite(refreshIntervalMs) ||
    refreshIntervalMs <= 0
  ) {
    throw new Error(
      `refreshIntervalMs: expected positive finite number, got ${JSON.stringify(refreshIntervalMs)}`,
    );
  }

  // bootWarmTimeoutMs
  const bootWarmTimeoutMs = "bootWarmTimeoutMs" in raw ? raw["bootWarmTimeoutMs"] : 30000;
  if (
    typeof bootWarmTimeoutMs !== "number" ||
    !Number.isFinite(bootWarmTimeoutMs) ||
    bootWarmTimeoutMs <= 0
  ) {
    throw new Error(
      `bootWarmTimeoutMs: expected positive finite number, got ${JSON.stringify(bootWarmTimeoutMs)}`,
    );
  }

  // abortOnEmpty
  const abortOnEmpty = "abortOnEmpty" in raw ? raw["abortOnEmpty"] : true;
  if (typeof abortOnEmpty !== "boolean") {
    throw new Error(`abortOnEmpty: expected boolean, got ${JSON.stringify(abortOnEmpty)}`);
  }

  return {
    cswapBin,
    includeSlots,
    excludeSlots,
    rateLimitPct,
    strategy,
    prewarmArgs,
    refreshIntervalMs,
    bootWarmTimeoutMs,
    abortOnEmpty,
  };
}
