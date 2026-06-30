export type Strategy = "round-robin" | "least-used" | "reset-soon";

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
  makePrimaryButtons: boolean;
  routeAuxQuota: boolean;
  autoHeal: boolean;
  autoHealAfterCycles: number;
  healLaunchArgs: string[];
  healLaunchTimeoutMs: number;
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
  if (strategy !== "round-robin" && strategy !== "least-used" && strategy !== "reset-soon") {
    throw new Error(
      `strategy: expected "round-robin" | "least-used" | "reset-soon", got ${JSON.stringify(strategy)}`,
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

  // makePrimaryButtons — gate per-account "Make primary" action-button emission. Default true
  // assumes a host whose publishUI renderer includes `action-button` (shepherd #1209/#1210+);
  // set false on an older host to fall back to the badge-only view (no UnknownNodeTile tiles).
  const makePrimaryButtons = "makePrimaryButtons" in raw ? raw["makePrimaryButtons"] : true;
  if (typeof makePrimaryButtons !== "boolean") {
    throw new Error(
      `makePrimaryButtons: expected boolean, got ${JSON.stringify(makePrimaryButtons)}`,
    );
  }

  // routeAuxQuota — gate aux-spawn (review / plan-gate / doc) credential routing onto a pool
  // account. Default true assumes a host whose reviewer sandbox binds a plugin-patched
  // credentialDir (shepherd#1217+); on an older host the routed dir is never mounted, so the
  // reviewer would start UNAUTHENTICATED — set false there to fall back to pass-through (the
  // active account). DELIBERATE default-true override: #1217 is not yet in a shipped Shepherd
  // release, so operators on a pre-#1217 host MUST set this false (see README + config.json).
  const routeAuxQuota = "routeAuxQuota" in raw ? raw["routeAuxQuota"] : true;
  if (typeof routeAuxQuota !== "boolean") {
    throw new Error(`routeAuxQuota: expected boolean, got ${JSON.stringify(routeAuxQuota)}`);
  }

  // autoHeal — enables auto-healing of accounts cswap transiently marks unavailable. Default true.
  const autoHeal = "autoHeal" in raw ? raw["autoHeal"] : true;
  if (typeof autoHeal !== "boolean") {
    throw new Error(`autoHeal: expected boolean, got ${JSON.stringify(autoHeal)}`);
  }

  // autoHealAfterCycles — consecutive cycles an account must report unavailable before auto-heal
  // attempts a revive (switch to it → launch one Claude session → switch back). Default 2, must be finite integer >= 1.
  const autoHealAfterCycles = requireFiniteInt(
    "autoHealAfterCycles" in raw ? raw["autoHealAfterCycles"] : 2,
    "autoHealAfterCycles",
  );
  if (autoHealAfterCycles < 1) {
    throw new Error(
      `autoHealAfterCycles: expected integer >= 1, got ${JSON.stringify(autoHealAfterCycles)}`,
    );
  }

  // healLaunchArgs
  const rawHealLaunchArgs = "healLaunchArgs" in raw ? raw["healLaunchArgs"] : ["-p", "ok"];
  if (!Array.isArray(rawHealLaunchArgs) || rawHealLaunchArgs.length === 0) {
    throw new Error(
      `healLaunchArgs: expected non-empty array of strings, got ${JSON.stringify(rawHealLaunchArgs)}`,
    );
  }
  const healLaunchArgs: string[] = rawHealLaunchArgs.map((v: unknown, i: number) => {
    if (typeof v !== "string") {
      throw new Error(`healLaunchArgs[${i}]: expected string, got ${JSON.stringify(v)}`);
    }
    return v;
  });

  // healLaunchTimeoutMs
  const healLaunchTimeoutMs = "healLaunchTimeoutMs" in raw ? raw["healLaunchTimeoutMs"] : 60000;
  if (
    typeof healLaunchTimeoutMs !== "number" ||
    !Number.isFinite(healLaunchTimeoutMs) ||
    healLaunchTimeoutMs <= 0
  ) {
    throw new Error(
      `healLaunchTimeoutMs: expected positive finite number, got ${JSON.stringify(healLaunchTimeoutMs)}`,
    );
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
    makePrimaryButtons,
    routeAuxQuota,
    autoHeal,
    autoHealAfterCycles,
    healLaunchArgs,
    healLaunchTimeoutMs,
  };
}
