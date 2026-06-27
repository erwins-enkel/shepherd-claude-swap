import { describe, expect, it } from "bun:test";
import { classifyPool } from "../src/accounts";
import { parseConfig } from "../src/config";
import type { CswapListResult } from "../src/cswap";
import fixtureRaw from "../docs/contracts/cswap-list.sample.json";

// Cast fixture to our interface (extra fields are ignored at runtime).
const fixture = fixtureRaw as unknown as CswapListResult;

describe("classifyPool — fixture baseline", () => {
  it("returns one PoolAccount per account", () => {
    const pool = classifyPool(fixture, parseConfig({}));
    expect(pool).toHaveLength(2);
  });

  it("both ok accounts are usable with default config", () => {
    const pool = classifyPool(fixture, parseConfig({}));
    expect(pool[0]!.usable).toBe(true);
    expect(pool[1]!.usable).toBe(true);
  });

  it("usable accounts have reason: null", () => {
    const pool = classifyPool(fixture, parseConfig({}));
    expect(pool[0]!.reason).toBeNull();
    expect(pool[1]!.reason).toBeNull();
  });

  it("carries account numbers and emails from fixture", () => {
    const pool = classifyPool(fixture, parseConfig({}));
    expect(pool[0]!.number).toBe(1);
    expect(pool[0]!.email).toBe("acct1@example.com");
    expect(pool[1]!.number).toBe(2);
    expect(pool[1]!.email).toBe("acct2@example.com");
  });

  it("carries active flag from fixture", () => {
    const pool = classifyPool(fixture, parseConfig({}));
    expect(pool[0]!.active).toBe(true);
    expect(pool[1]!.active).toBe(false);
  });

  it("carries fiveHourPct and sevenDayPct", () => {
    const pool = classifyPool(fixture, parseConfig({}));
    expect(pool[0]!.fiveHourPct).toBe(93);
    expect(pool[0]!.sevenDayPct).toBe(19);
    expect(pool[1]!.fiveHourPct).toBe(0);
    expect(pool[1]!.sevenDayPct).toBe(98);
  });
});

describe("classifyPool — rate-limit threshold", () => {
  it("not rate-limited at default rateLimitPct=100 (all pcts below 100)", () => {
    const pool = classifyPool(fixture, parseConfig({}));
    expect(pool[0]!.rateLimited).toBe(false);
    expect(pool[1]!.rateLimited).toBe(false);
  });

  it("rate-limited when pct === rateLimitPct (exact boundary, acct1 fiveHour=93)", () => {
    const pool = classifyPool(fixture, parseConfig({ rateLimitPct: 93 }));
    // acct1: fiveHour 93 >= 93 → rate-limited
    expect(pool[0]!.rateLimited).toBe(true);
  });

  it("NOT rate-limited when pct === rateLimitPct - 1 (just below boundary, acct1 fiveHour=93)", () => {
    const pool = classifyPool(fixture, parseConfig({ rateLimitPct: 94 }));
    // acct1: fiveHour 93 < 94, sevenDay 19 < 94 → not rate-limited
    expect(pool[0]!.rateLimited).toBe(false);
  });

  it("rate-limited when sevenDay pct === rateLimitPct (acct2 sevenDay=98)", () => {
    const pool = classifyPool(fixture, parseConfig({ rateLimitPct: 98 }));
    // acct2: fiveHour 0 < 98, sevenDay 98 >= 98 → rate-limited
    expect(pool[1]!.rateLimited).toBe(true);
  });

  it("NOT rate-limited when pct is just below sevenDay boundary (acct2 sevenDay=98)", () => {
    const pool = classifyPool(fixture, parseConfig({ rateLimitPct: 99 }));
    // acct2: fiveHour 0 < 99, sevenDay 98 < 99 → not rate-limited
    expect(pool[1]!.rateLimited).toBe(false);
  });

  it("rateLimited is false when account is unusable", () => {
    const list: CswapListResult = {
      schemaVersion: 1,
      accounts: [
        {
          number: 1,
          email: "a@b.com",
          active: false,
          usageStatus: "api_key",
          usage: { fiveHour: { pct: 200 } },
        },
      ],
    };
    const pool = classifyPool(list, parseConfig({ rateLimitPct: 50 }));
    expect(pool[0]!.usable).toBe(false);
    expect(pool[0]!.rateLimited).toBe(false);
  });
});

describe("classifyPool — non-ok usageStatus", () => {
  const statusCases: string[] = [
    "api_key",
    "token_expired",
    "no_credentials",
    "unavailable",
    "unknown_status",
  ];

  for (const status of statusCases) {
    it(`usageStatus="${status}" → usable:false, reason:"${status}"`, () => {
      const list: CswapListResult = {
        schemaVersion: 1,
        accounts: [
          { number: 1, email: "a@b.com", active: false, usageStatus: status, usage: null },
        ],
      };
      const pool = classifyPool(list, parseConfig({}));
      expect(pool[0]!.usable).toBe(false);
      expect(pool[0]!.reason).toBe(status);
    });
  }
});

describe("classifyPool — include/exclude filtering", () => {
  it("excludeSlots excludes matching account", () => {
    const pool = classifyPool(fixture, parseConfig({ excludeSlots: [1] }));
    expect(pool[0]!.usable).toBe(false);
    expect(pool[0]!.reason).toBe("excluded-slot");
    // acct2 is still usable
    expect(pool[1]!.usable).toBe(true);
  });

  it("excludeSlots excludes multiple accounts", () => {
    const pool = classifyPool(fixture, parseConfig({ excludeSlots: [1, 2] }));
    expect(pool[0]!.usable).toBe(false);
    expect(pool[1]!.usable).toBe(false);
  });

  it("includeSlots: [2] makes acct1 unusable with reason:'not-in-include'", () => {
    const pool = classifyPool(fixture, parseConfig({ includeSlots: [2] }));
    expect(pool[0]!.usable).toBe(false);
    expect(pool[0]!.reason).toBe("not-in-include");
    expect(pool[1]!.usable).toBe(true);
  });

  it("includeSlots: null allows all (default)", () => {
    const pool = classifyPool(fixture, parseConfig({ includeSlots: null }));
    expect(pool[0]!.usable).toBe(true);
    expect(pool[1]!.usable).toBe(true);
  });

  it("includeSlots: [1, 2] keeps both accounts usable", () => {
    const pool = classifyPool(fixture, parseConfig({ includeSlots: [1, 2] }));
    expect(pool[0]!.usable).toBe(true);
    expect(pool[1]!.usable).toBe(true);
  });

  it("excludeSlots takes priority over includeSlots when both match", () => {
    // acct1 is in includeSlots but also in excludeSlots → excluded
    const pool = classifyPool(fixture, parseConfig({ includeSlots: [1, 2], excludeSlots: [1] }));
    expect(pool[0]!.usable).toBe(false);
    expect(pool[0]!.reason).toBe("excluded-slot");
  });
});

describe("classifyPool — missing usage", () => {
  it("usage: null → fiveHourPct and sevenDayPct are null", () => {
    const list: CswapListResult = {
      schemaVersion: 1,
      accounts: [{ number: 1, email: "a@b.com", active: true, usageStatus: "ok", usage: null }],
    };
    const pool = classifyPool(list, parseConfig({}));
    expect(pool[0]!.fiveHourPct).toBeNull();
    expect(pool[0]!.sevenDayPct).toBeNull();
  });

  it("usage: null → not rate-limited (null pcts don't trigger rate-limit)", () => {
    const list: CswapListResult = {
      schemaVersion: 1,
      accounts: [{ number: 1, email: "a@b.com", active: true, usageStatus: "ok", usage: null }],
    };
    const pool = classifyPool(list, parseConfig({ rateLimitPct: 0 }));
    expect(pool[0]!.usable).toBe(true);
    expect(pool[0]!.rateLimited).toBe(false);
  });

  it("missing fiveHour window → fiveHourPct is null", () => {
    const list: CswapListResult = {
      schemaVersion: 1,
      accounts: [
        {
          number: 1,
          email: "a@b.com",
          active: true,
          usageStatus: "ok",
          usage: { sevenDay: { pct: 50 } },
        },
      ],
    };
    const pool = classifyPool(list, parseConfig({}));
    expect(pool[0]!.fiveHourPct).toBeNull();
    expect(pool[0]!.sevenDayPct).toBe(50);
  });
});

describe("classifyPool — empty accounts list", () => {
  it("returns empty array for empty accounts list", () => {
    const list: CswapListResult = { schemaVersion: 1, accounts: [] };
    const pool = classifyPool(list, parseConfig({}));
    expect(pool).toHaveLength(0);
  });
});
