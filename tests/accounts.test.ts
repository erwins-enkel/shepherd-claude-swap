import { describe, expect, it } from "bun:test";
import { classifyPool } from "../src/accounts";
import { parseConfig } from "../src/config";
import type { CswapListResult } from "../src/cswap";
import fixtureRaw from "../docs/contracts/cswap-list.sample.json";
import sample023Raw from "../docs/contracts/cswap-list-0.23.sample.json";
import syntheticRaw from "../docs/contracts/cswap-list-0.23.synthetic.json";

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

  it("carries reset fields (resetsAt/clock/countdown) from fixture", () => {
    const pool = classifyPool(fixture, parseConfig({}));
    // acct1: both windows have full reset data
    expect(pool[0]!.fiveHourResetsAt).toBe("2026-06-27T20:00:00.277424+00:00");
    expect(pool[0]!.fiveHourResetClock).toBe("22:00");
    expect(pool[0]!.fiveHourResetCountdown).toBe("1h 43m");
    expect(pool[0]!.sevenDayResetsAt).toBe("2026-07-04T15:00:00.277447+00:00");
    expect(pool[0]!.sevenDayResetClock).toBe("Jul 4 17:00");
    expect(pool[0]!.sevenDayResetCountdown).toBe("6d 20h");
  });

  it("reset fields are null when the window omits them (acct2 fiveHour has only pct)", () => {
    const pool = classifyPool(fixture, parseConfig({}));
    expect(pool[1]!.fiveHourResetsAt).toBeNull();
    expect(pool[1]!.fiveHourResetClock).toBeNull();
    expect(pool[1]!.fiveHourResetCountdown).toBeNull();
    // acct2 sevenDay still carries reset data
    expect(pool[1]!.sevenDayResetClock).toBe("Jun 30 00:00");
    expect(pool[1]!.sevenDayResetCountdown).toBe("2d 3h");
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
    it(`usageStatus="${status}" → usable:false, reason:"${status}", usageUnavailable:false`, () => {
      const list: CswapListResult = {
        schemaVersion: 1,
        accounts: [
          { number: 1, email: "a@b.com", active: false, usageStatus: status, usage: null },
        ],
      };
      const pool = classifyPool(list, parseConfig({}));
      expect(pool[0]!.usable).toBe(false);
      expect(pool[0]!.reason).toBe(status);
      expect(pool[0]!.usageUnavailable).toBe(false);
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

describe("classifyPool — out-of-rotation set", () => {
  it("defaults to an empty set (no arg) — both accounts usable", () => {
    const pool = classifyPool(fixture, parseConfig({}));
    expect(pool[0]!.usable).toBe(true);
    expect(pool[1]!.usable).toBe(true);
  });

  it("member → usable:false, reason:'out-of-rotation', usageUnavailable:false", () => {
    const pool = classifyPool(fixture, parseConfig({}), new Set([2]));
    expect(pool[1]!.usable).toBe(false);
    expect(pool[1]!.reason).toBe("out-of-rotation");
    expect(pool[1]!.usageUnavailable).toBe(false);
    // acct1 unaffected
    expect(pool[0]!.usable).toBe(true);
  });

  it("carries pct + active + reset fields for an out-of-rotation account", () => {
    const pool = classifyPool(fixture, parseConfig({}), new Set([1]));
    expect(pool[0]!.reason).toBe("out-of-rotation");
    expect(pool[0]!.fiveHourPct).toBe(93);
    expect(pool[0]!.sevenDayPct).toBe(19);
    expect(pool[0]!.active).toBe(true);
    expect(pool[0]!.fiveHourResetClock).toBe("22:00");
  });

  it("excludeSlots takes priority over the out-of-rotation set (keeps excluded-slot reason)", () => {
    const pool = classifyPool(fixture, parseConfig({ excludeSlots: [1] }), new Set([1]));
    expect(pool[0]!.usable).toBe(false);
    expect(pool[0]!.reason).toBe("excluded-slot");
  });

  it("non-ok usageStatus takes priority over the out-of-rotation set (keeps status reason)", () => {
    const list: CswapListResult = {
      schemaVersion: 1,
      accounts: [
        { number: 1, email: "a@b.com", active: false, usageStatus: "token_expired", usage: null },
      ],
    };
    const pool = classifyPool(list, parseConfig({}), new Set([1]));
    expect(pool[0]!.usable).toBe(false);
    expect(pool[0]!.reason).toBe("token_expired");
  });

  it("out-of-rotation applies before not-in-include (member gets out-of-rotation reason)", () => {
    // acct2 is in includeSlots (so not 'not-in-include') but toggled out → out-of-rotation
    const pool = classifyPool(fixture, parseConfig({ includeSlots: [1, 2] }), new Set([2]));
    expect(pool[1]!.usable).toBe(false);
    expect(pool[1]!.reason).toBe("out-of-rotation");
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
    expect(pool[0]!.usageUnavailable).toBe(true);
  });

  it("usage: null → not rate-limited (null pcts don't trigger rate-limit)", () => {
    const list: CswapListResult = {
      schemaVersion: 1,
      accounts: [{ number: 1, email: "a@b.com", active: true, usageStatus: "ok", usage: null }],
    };
    const pool = classifyPool(list, parseConfig({ rateLimitPct: 0 }));
    expect(pool[0]!.usable).toBe(true);
    expect(pool[0]!.rateLimited).toBe(false);
    expect(pool[0]!.usageUnavailable).toBe(true);
  });

  it("both-null pcts + ok → usable:true, usageUnavailable:true", () => {
    // usage: {} has no windows → both pcts null → usageUnavailable
    const list: CswapListResult = {
      schemaVersion: 1,
      accounts: [{ number: 1, email: "a@b.com", active: true, usageStatus: "ok", usage: {} }],
    };
    const pool = classifyPool(list, parseConfig({}));
    expect(pool[0]!.usable).toBe(true);
    expect(pool[0]!.usageUnavailable).toBe(true);
  });

  it("one window present (sevenDay only) → usageUnavailable:false", () => {
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
    expect(pool[0]!.usageUnavailable).toBe(false);
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

describe("classifyPool — scopedWindows", () => {
  it("normalizes usage.scoped into scopedWindows (name/pct carried, missing fields null)", () => {
    const list: CswapListResult = {
      schemaVersion: 1,
      accounts: [
        {
          number: 1,
          email: "a@b.com",
          active: true,
          usageStatus: "ok",
          usage: {
            fiveHour: { pct: 10 },
            scoped: [{ name: "Fable", pct: 42 }],
          },
        },
      ],
    };
    const pool = classifyPool(list, parseConfig({}));
    expect(pool[0]!.scopedWindows).toEqual([
      {
        name: "Fable",
        pct: 42,
        resetsAt: null,
        resetClock: null,
        resetCountdown: null,
        expectedPct: null,
        aheadOfPace: false,
      },
    ]);
  });

  it("carries resetsAt/clock/countdown when present on a scoped window", () => {
    const list: CswapListResult = {
      schemaVersion: 1,
      accounts: [
        {
          number: 1,
          email: "a@b.com",
          active: true,
          usageStatus: "ok",
          usage: {
            scoped: [
              {
                name: "Fable",
                pct: 42,
                resetsAt: "2026-07-04T15:00:00.277447+00:00",
                clock: "Jul 4 17:00",
                countdown: "6d 20h",
              },
            ],
          },
        },
      ],
    };
    const pool = classifyPool(list, parseConfig({}));
    expect(pool[0]!.scopedWindows[0]!.resetsAt).toBe("2026-07-04T15:00:00.277447+00:00");
    expect(pool[0]!.scopedWindows[0]!.resetClock).toBe("Jul 4 17:00");
    expect(pool[0]!.scopedWindows[0]!.resetCountdown).toBe("6d 20h");
  });

  it("scoped absent → scopedWindows: [] on the usable branch", () => {
    const list: CswapListResult = {
      schemaVersion: 1,
      accounts: [
        {
          number: 1,
          email: "a@b.com",
          active: true,
          usageStatus: "ok",
          usage: { fiveHour: { pct: 1 } },
        },
      ],
    };
    const pool = classifyPool(list, parseConfig({}));
    expect(pool[0]!.scopedWindows).toEqual([]);
  });

  it("scoped absent → scopedWindows: [] on the non-ok usageStatus branch", () => {
    const list: CswapListResult = {
      schemaVersion: 1,
      accounts: [
        { number: 1, email: "a@b.com", active: false, usageStatus: "api_key", usage: null },
      ],
    };
    const pool = classifyPool(list, parseConfig({}));
    expect(pool[0]!.scopedWindows).toEqual([]);
  });

  it("scoped absent → scopedWindows: [] on the excluded-slot branch", () => {
    const list: CswapListResult = {
      schemaVersion: 1,
      accounts: [
        {
          number: 1,
          email: "a@b.com",
          active: true,
          usageStatus: "ok",
          usage: { fiveHour: { pct: 1 } },
        },
      ],
    };
    const pool = classifyPool(list, parseConfig({ excludeSlots: [1] }));
    expect(pool[0]!.scopedWindows).toEqual([]);
  });

  it("scoped present but pct=100 has NO effect on usable/rateLimited/usageUnavailable (display-only)", () => {
    const list: CswapListResult = {
      schemaVersion: 1,
      accounts: [
        {
          number: 1,
          email: "a@b.com",
          active: true,
          usageStatus: "ok",
          usage: {
            fiveHour: { pct: 10 },
            sevenDay: { pct: 20 },
            scoped: [{ name: "Fable", pct: 100 }],
          },
        },
      ],
    };
    const pool = classifyPool(list, parseConfig({ rateLimitPct: 90 }));
    expect(pool[0]!.usable).toBe(true);
    expect(pool[0]!.rateLimited).toBe(false);
    expect(pool[0]!.usageUnavailable).toBe(false);
    expect(pool[0]!.scopedWindows).toEqual([
      {
        name: "Fable",
        pct: 100,
        resetsAt: null,
        resetClock: null,
        resetCountdown: null,
        expectedPct: null,
        aheadOfPace: false,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// cswap's own `disabled` flag — honored read-only as a second rotation gate.
// ---------------------------------------------------------------------------

/** The 0.23 sample, captured from the real CLI with slot 3 aliased and disabled. */
const sample023 = sample023Raw as unknown as CswapListResult;

/** Clone the base fixture and set `disabled` on one raw row. */
function withDisabled(number: number, disabled: boolean): CswapListResult {
  const clone = structuredClone(fixture);
  const row = clone.accounts.find((a) => a.number === number);
  if (row === undefined) throw new Error(`fixture has no account ${number}`);
  if (disabled) row.disabled = true;
  else delete row.disabled;
  return clone;
}

describe("classifyPool — cswap-disabled gate", () => {
  it("marks a cswap-disabled account unusable with reason cswap-disabled", () => {
    const pool = classifyPool(withDisabled(2, true), parseConfig({}));
    const acct = pool.find((a) => a.number === 2)!;
    expect(acct.cswapDisabled).toBe(true);
    expect(acct.usable).toBe(false);
    expect(acct.reason).toBe("cswap-disabled");
  });

  it("leaves other accounts untouched", () => {
    const pool = classifyPool(withDisabled(2, true), parseConfig({}));
    const other = pool.find((a) => a.number === 1)!;
    expect(other.cswapDisabled).toBe(false);
    expect(other.usable).toBe(true);
  });

  it("an absent `disabled` key normalizes to false, never undefined", () => {
    const pool = classifyPool(withDisabled(2, false), parseConfig({}));
    for (const acct of pool) expect(acct.cswapDisabled).toBe(false);
  });

  it("populates cswapDisabled on the non-ok usageStatus path, which short-circuits first", () => {
    const list = withDisabled(2, true);
    list.accounts.find((a) => a.number === 2)!.usageStatus = "unavailable";
    const acct = classifyPool(list, parseConfig({})).find((a) => a.number === 2)!;
    // The status wins the `reason`, but the flag must still be readable — Prewarmer.inScope()
    // and the panel marker both depend on it being set on every path.
    expect(acct.reason).toBe("unavailable");
    expect(acct.cswapDisabled).toBe(true);
  });

  it("cswap-disabled outranks the plugin's own out-of-rotation set", () => {
    const acct = classifyPool(withDisabled(2, true), parseConfig({}), new Set([2])).find(
      (a) => a.number === 2,
    )!;
    expect(acct.reason).toBe("cswap-disabled");
  });

  it("falls back to out-of-rotation once cswap's flag clears", () => {
    const acct = classifyPool(withDisabled(2, false), parseConfig({}), new Set([2])).find(
      (a) => a.number === 2,
    )!;
    expect(acct.reason).toBe("out-of-rotation");
    expect(acct.cswapDisabled).toBe(false);
  });

  it("excludeSlots still outranks cswap-disabled", () => {
    const cfg = parseConfig({ excludeSlots: [2] });
    const acct = classifyPool(withDisabled(2, true), cfg).find((a) => a.number === 2)!;
    expect(acct.reason).toBe("excluded-slot");
  });
});

// ---------------------------------------------------------------------------
// 0.23 field contract — LAYER 2: normalization must read the keys the real CLI
// actually emits. A key misspelled consistently across the interface, this
// reader and a raw-JSON assertion would pass a presence check while the
// normalized field sat at null; asserting post-classifyPool closes that.
// ---------------------------------------------------------------------------

describe("classifyPool — captured 0.23 sample normalizes cswap-disabled", () => {
  it("reads `disabled` off the captured row", () => {
    const pool = classifyPool(sample023, parseConfig({}));
    const parked = pool.filter((a) => a.cswapDisabled);
    expect(parked).toHaveLength(1);
    expect(parked[0]!.reason).toBe("cswap-disabled");
    expect(parked[0]!.usable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LAYER 2 of the 0.23 field contract: normalization must read the keys the real
// CLI actually emits.
//
// Layer 1 (cswap.test.ts) catches an INTERFACE key that disagrees with cswap.
// This catches the independent case of a READER that misspells one: the typed
// read would still compile and still yield undefined, and the normalized field
// would sit at null — indistinguishable from "cswap didn't send it". Asserting
// the captured values after classifyPool is what closes that.
// ---------------------------------------------------------------------------

describe("classifyPool — captured 0.23 sample normalizes every consumed field", () => {
  const pool = classifyPool(sample023, parseConfig({}));
  const parked = pool.find((a) => a.cswapDisabled)!;

  it("alias", () => {
    expect(parked.alias).toBe("devbox");
    // Accounts without an alias must normalize to null, not undefined or "".
    expect(pool.filter((a) => a.alias === null).length).toBe(pool.length - 1);
  });

  it("organizationName", () => {
    for (const acct of pool) expect(typeof acct.organizationName).toBe("string");
    // Slots 1 and 2 share an email and differ only by organisation — the real-world case.
    const [a, b] = [pool[0]!, pool[1]!];
    expect(a.email).toBe(b.email);
    expect(a.organizationName).not.toBe(b.organizationName);
  });

  it("usageAgeSeconds", () => {
    for (const acct of pool) {
      expect(typeof acct.usageAgeSeconds).toBe("number");
      expect(Number.isFinite(acct.usageAgeSeconds)).toBe(true);
    }
  });

  it("spend, every sub-field", () => {
    const withSpend = pool.filter((a) => a.spend !== null);
    expect(withSpend.length).toBeGreaterThan(0);
    for (const acct of withSpend) {
      expect(typeof acct.spend!.used).toBe("number");
      expect(typeof acct.spend!.limit).toBe("number");
      expect(typeof acct.spend!.pct).toBe("number");
      expect(typeof acct.spend!.currency).toBe("string");
    }
    // An account with no pay-as-you-go plan normalizes to null — "no plan", not "unknown".
    expect(pool.some((a) => a.spend === null)).toBe(true);
  });

  it("pace on the 7-day window, including a genuinely ahead-of-pace one", () => {
    for (const acct of pool) expect(typeof acct.sevenDayPace.expectedPct).toBe("number");
    expect(pool.some((a) => a.sevenDayPace.aheadOfPace)).toBe(true);
  });

  it("pace on scoped windows", () => {
    const scoped = pool.flatMap((a) => a.scopedWindows);
    expect(scoped.length).toBeGreaterThan(0);
    for (const w of scoped) {
      expect(typeof w.expectedPct).toBe("number");
      expect(typeof w.aheadOfPace).toBe("boolean");
    }
  });

  it("spend never affects classification", () => {
    // The spend-capped account is at 100% of its budget and must still be usable — spend is a
    // display axis, exactly like scopedWindows.
    const capped = pool.filter((a) => a.spend !== null && a.spend.pct >= 100);
    expect(capped.length).toBeGreaterThan(0);
    for (const acct of capped) {
      if (!acct.cswapDisabled) expect(acct.rateLimited).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The CONDITIONAL spend reset display strings.
//
// cswap emits spend's countdown/clock (alongside a raw resetsAt this plugin
// does not carry) only when the API supplies a reset instant (json_output.py:
// `if "resets_at" in spend`). Neither account on the capture host has one, so
// no live capture there could carry them — yet both are consumed
// (toSpend -> resetSuffix). This uses the labelled
// synthetic fixture reserved for exactly that case; every other field is
// asserted against the captured sample instead. See cswap-0.23-fields.md §5.
// ---------------------------------------------------------------------------

describe("classifyPool — conditional spend reset keys (synthetic fixture)", () => {
  const synthetic = syntheticRaw as unknown as CswapListResult;

  it("normalizes both display strings, so a reader misspelling cannot pass silently", () => {
    const acct = classifyPool(synthetic, parseConfig({}))[0]!;
    expect(acct.spend).not.toBeNull();
    expect(acct.spend!.resetCountdown).toBe("7d 4h");
    expect(acct.spend!.resetClock).toBe("Aug 1 02:00");
  });

  it("still normalizes the four unconditional sub-fields", () => {
    const acct = classifyPool(synthetic, parseConfig({}))[0]!;
    expect(acct.spend!.used).toBe(12.5);
    expect(acct.spend!.limit).toBe(100);
    expect(acct.spend!.pct).toBe(12.5);
    expect(acct.spend!.currency).toBe("EUR");
  });

  it("captured-sample accounts omit them entirely, which must read as null", () => {
    // The real-world shape: cswap sends no reset instant for these spend blocks.
    for (const acct of classifyPool(sample023, parseConfig({}))) {
      if (acct.spend === null) continue;
      expect(acct.spend.resetCountdown).toBeNull();
      expect(acct.spend.resetClock).toBeNull();
    }
  });
});
