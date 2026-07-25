# cswap 0.19 → 0.23 — pinned source evidence

cswap **0.23.0**, claude **2.1.219**, Linux host. Captured 2026-07-24.
Source tree: `~/.local/share/uv/tools/claude-swap/lib/python3.13/site-packages/claude_swap/`

The cswap source is **not** in this repo; this file pins the file-level evidence the 0.23 field work
relies on, so a future reader can verify the reasoning without a live cswap install. Companion to
[`cswap-heal-mechanism.md`](cswap-heal-mechanism.md).

---

## 1. Compatibility of what the plugin already called

Re-verified **before** consuming anything new. Three of these gate `ready`: if `cswap run`'s argv or
the session-profile layout had changed anywhere in 0.20–0.23, no account would ever warm and — under
the shipped `abortOnEmpty: true` — every spawn would abort. They had not been re-checked since cswap
**0.14.0** (see [`step0-verification.md`](step0-verification.md)), four minor releases back.

| Fact                                                                                                                                                                                                                                                                                         | Evidence                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Still emits `schemaVersion: 1` — `Cswap.list()` throws on anything else                                                                                                                                                                                                                      | live `cswap --list --json`                                                                                 |
| `--list`, `--switch`, `--switch-to` still argparse-defined. The subcommand spellings are aliases **onto** them (`"list": "--list"`, `switch` dispatching to `--switch-to` when given an argument), so the plugin's flag-style argv is cswap's canonical internal form, not a deprecated path | `cli.py` — flag definitions + subcommand→flag alias map                                                    |
| `--switch-to` on a bad target returns the documented error envelope that `cswapErrorMessage()` parses                                                                                                                                                                                        | live: `cswap --switch-to 999 --json` → `{schemaVersion:1, error:{type:"AccountNotFoundError", …}}`, exit 1 |
| `Cswap.prewarm()`'s exact argv still works — `["run", "<n>", "--", ...args]`, also reused by the heal path via `healLaunchArgs`                                                                                                                                                              | live: `cswap run 3 -- --version` → `2.1.219 (Claude Code)`, exit 0                                         |
| Session-profile layout unchanged: `<backupRoot>/sessions/<n>-<slugify(email)>`                                                                                                                                                                                                               | `session.py` → `session_dir_for()` = `backup_dir / "sessions" / f"{account_num}-{slugify_email(email)}"`   |
| **Still keyed on `email`, NOT the `alias` added in 0.21** — both call sites pass `email`; `alias` appears nowhere in the path                                                                                                                                                                | `session.py:449`, `switcher.py:1606` — the only two `session_dir_for()` callers                            |
| The slug rule still matches `src/paths.ts` → `slugifyEmail()` character-for-character (NFC-normalize, keep `[A-Za-z0-9._-]`)                                                                                                                                                                 | `session.py` → `slugify_email()`                                                                           |
| Confirmed on the live filesystem, including the `.credentials.json` that `Prewarmer.warm()` probes                                                                                                                                                                                           | `~/.local/share/claude-swap/sessions/{1-…, 2-…, 3-…}`                                                      |

**No migration was required** — the plugin's argv and path logic are untouched by this work. Only
operator-facing docs use the subcommand spelling (`cswap disable <n>`), which is verified accepted:
`cswap disable 99` → `Error: Account-99 does not exist`, exit 1.

---

## 2. Release inventory 0.19 → 0.23

Every shipped feature gets an explicit verdict, so "surveyed and rejected" is distinguishable from
"not noticed".

| Release | Feature                                                             | Verdict            | Why                                                                                                                                            |
| ------- | ------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.19.0  | macOS menu bar app                                                  | **reject**         | macOS-only GUI, no plugin surface. This is a Linux/WSL-only plugin (README precondition 4).                                                    |
| 0.19.0  | Per-model weekly limits; `--model` flag                             | **partial**        | The windows are already consumed as `scopedWindows`; the flag only tunes `cswap auto` / `switch --strategy`, neither of which the plugin uses. |
| 0.20.0  | Adaptive polling; dedup; throttle recovery                          | **no action**      | cswap-internal. It is what makes `usageAgeSeconds` meaningful and sets the 300 s staleness threshold.                                          |
| 0.21.0  | Per-account aliases                                                 | **adopt**          | Rendered in the identity label, alongside the email (never instead of it — see §5).                                                            |
| 0.21.0  | `cswap disable` / `enable`                                          | **adopt**          | Honoured read-only as a rotation gate with `reason: "cswap-disabled"`.                                                                         |
| 0.21.0  | Directory → account mapping (`cswap map`)                           | **reject**         | Conflicts with the plugin's own per-session assignment: it would bind a repo to one account while `assign()` picks another.                    |
| 0.21.0  | MCP servers mirrored into session mode                              | **no action**      | Improves the `cswap run` profile the plugin already prewarms; nothing to consume.                                                              |
| 0.22.0  | `cswap move` / `cswap swap` slot reordering                         | **reject + warn**  | Renumbers slots, which the plugin keys pins on — see §3. Earns a README warning, not silence.                                                  |
| 0.22.0  | MCP logins preserved across switches                                | **no action**      | Benefits the plugin's switches for free.                                                                                                       |
| 0.22.0  | Export/import refinements                                           | **n/a**            | Operator-side account management; the plugin consumes accounts, never manages them.                                                            |
| 0.23.0  | `consume-first` autoswitch strategy                                 | **adopt (ported)** | Ranking ported into `reset-soon`. Cannot be delegated: it lives in `cswap auto`, and `switch --strategy` rejects it (verified live).           |
| 0.23.0  | Weekly pace indicator + JSON pace fields                            | **adopt in part**  | `expectedPct` / `aheadOfPace` rendered; `projectedExhaustionAt` / `willLastToReset` deliberately unconsumed (§4).                              |
| 0.23.0  | Light theme (`ui.theme`)                                            | **reject**         | Styles cswap's own TUI/CLI. The plugin renders through Shepherd's `publishUI` node registry and emits no terminal output.                      |
| 0.23.0  | Multi-machine 429 backoff                                           | **no action**      | cswap-internal — but it is why 0.23 serves last-good snapshots longer, which is what makes the freshness signal worth surfacing.               |
| 0.23.0  | Menu bar notification repair; keyring dropped; export dir rejection | **n/a**            | No plugin surface.                                                                                                                             |

---

## 3. `cswap move` / `swap` is a hazard, not merely unused

The plugin keys **session pins** (`assignments: sessionId → accountNumber`), `sessionProfileDir()`,
`includeSlots` / `excludeSlots` and per-account history on the **slot number**.

`switcher.py` → `swap_accounts()` documents that everything slot-keyed moves with the swap: the
sequence records (including aliases), the per-slot credential and config backups,
`activeAccountNumber`, and each slot's session profile directory. What does **not** move is this
plugin's durable `assignments` map, which lives in Shepherd plugin state.

So `cswap swap 2 3` while sessions are pinned re-points those pins at a **different account**: a
session pinned to slot 2 resumes onto whatever account now occupies slot 2. That is an identity swap
mid-session, and nothing in the plugin can detect it — the stored slot number is still valid, it
just means something else now.

Fixing it durably would need pins keyed on a stable account identity (e.g. `organizationUuid`),
which is well beyond adopting 0.23 fields. It is therefore a documented README limitation alongside
`cswap auto`.

---

## 4. The 0.23 field additions

| Fact                                                                                                                                                                            | Evidence                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `consume-first` ranks by the **exact** epoch of the soonest future 7-day reset — sort key `(reset_ts, -headroom)`, no bucketing                                                 | `autoswitch.py` → `_rank_candidates()`, `_seven_day_reset_ts()`   |
| A past or unparseable reset is treated as unknown and sorts last (`inf`) — a stale snapshot would otherwise rank a just-rolled-over account as "soonest"                        | `autoswitch.py` → `_seven_day_reset_ts()` docstring               |
| Weekly windows gained `expectedPct`, `aheadOfPace`, `projectedExhaustionAt`, `willLastToReset`                                                                                  | `json_output.py` → `_pace_fields()`                               |
| The `aheadOfPace` marker is noise-gated upstream: ≥15 pp over expected, suppressed for 24 h after a reset. Consumed verbatim rather than re-judged here                         | `pace.py` → `AHEAD_THRESHOLD_PCT`, `SUPPRESS_AFTER_RESET_S`       |
| `usage.spend` is emitted only when `used_credits`, `monthly_limit` **and** `utilization` are all non-null; an unlimited plan (`monthly_limit: None`) omits the entry            | `oauth.py`, extra_usage block                                     |
| **`spend.pct` is not derivable from `used`/`limit`** — a live account reports `used: 100.33, limit: 100.0, pct: 100.0`. It is the API's `utilization`; the plugin never divides | live `cswap --list --json`                                        |
| `usageAgeSeconds` is the age of the measurement **at cswap's emit time** — not since this plugin last polled                                                                    | `json_output.py` → `usage_freshness_fields()`                     |
| `alias` and `disabled` are emitted **only when set**                                                                                                                            | `json_output.py` → `account_row()` (`if alias:` / `if disabled:`) |
| A disabled account **still appears** in `--list --json` — the listing loop has no disabled filter                                                                               | `switcher.py` → `list_accounts()` snapshot loop                   |
| Disabling never renumbers: `set_account_disabled()` only sets/pops `record["disabled"]` and bumps `lastUpdated`                                                                 | `switcher.py` → `set_account_disabled()`                          |
| A disabled account remains a valid explicit `cswap switch <n>` target                                                                                                           | `switcher.py` → `set_account_disabled()` docstring                |

### Deliberately unconsumed

| Field                                      | Why not                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectedExhaustionAt`, `willLastToReset` | cswap documents both as JSON-only because the linear projection has wide error bars against bursty usage, and keeps them out of every human-facing surface. Nothing here reads them; typing them would be dead data.                                                                                                |
| `usageFetchedAt`                           | Only the derived `usageAgeSeconds` is read. Typing the absolute anchor too would be unread surface.                                                                                                                                                                                                                 |
| `spend.resetsAt`                           | Same shape: only the derived `countdown` / `clock` display strings are read. Unlike the window-level `resetsAt` — which reaches `GET stats` via `buildStatus` and drives `computeResetOrder` — spend has no such consumer (`buildStatus` does not emit `spend` at all), so carrying the anchor would be write-only. |
| `isOrganization`, `organizationUuid`       | Nothing reads them. (`organizationUuid` is the field a future fix for §3 would likely key pins on.)                                                                                                                                                                                                                 |
| `switchable`                               | Exists on cswap's internal snapshot but is **not** emitted to JSON.                                                                                                                                                                                                                                                 |

### No upstream precedent for the 7-day headroom band

An earlier draft of this work cited `_rank_candidates()` as independent precedent for the plugin's
new 7-day band. **That was wrong and is withdrawn.** Upstream skips a consume-first target whose
_used pct is at or above_ `threshold` — an at-the-limit filter, equivalent to what `classifyPool`'s
`rateLimited` flag and `assign`'s `usable && !rateLimited` already do here. It is **not** a margin
below the limit, and upstream applies none for consume-first (its only margin, `hysteresis_pct`, is
a relative candidate-vs-active comparison used by the `best` strategy).

The band rests instead on a plugin-specific argument: upstream switches a _primary_ with no pinned
sessions behind it, whereas this plugin pins sessions per account and `assign()` cannot reassign
them — so an account crossing `rateLimitPct` makes every session pinned to it unresumable.

---

## 5. The captured fixture

`cswap-list-0.23.sample.json` is **captured from the real CLI**, not hand-authored. That matters
because every new field is optional and `Cswap.list()` does no per-field validation, so a misspelled
key is indistinguishable from an absent one — a hand-written fixture could make all suites pass
against keys cswap never emits.

Capture procedure (2026-07-24, `cswap 0.23.0`):

```sh
cswap alias 3 devbox && cswap disable 3      # arrange the two conditionally-emitted keys
cswap --list --json > docs/contracts/cswap-list-0.23.sample.json
cswap enable 3 && cswap alias 3 --unset      # restore prior state
# then redact emails / organisation names / UUIDs — VALUES only, never keys
```

Redaction preserves the real-world shape: slots 1 and 2 share an email and differ only by
organisation, which is what the panel's organisation segment exists to disambiguate.

### What the capture actually exercised

Some fields are API-driven and **cannot be arranged by any cswap command**: `compute_pace()` returns
`None` within 24 h of a window reset, `aheadOfPace: true` additionally needs the live burn rate to be
≥15 pp over expected, and spend's reset fields are emitted only when the API supplies a reset instant
(`if "resets_at" in spend`). The plan therefore reserved a labelled synthetic fallback fixture.

The pace fields did not need it — this capture happened to contain them, including a genuinely
ahead-of-pace window. **Two consumed fields did**: neither spend-carrying account on this host has a
reset instant, so no capture here could contain `spend.countdown` / `spend.clock`. (cswap emits
`spend.resetsAt` alongside them; the plugin deliberately does not carry it — see §4.)

| Field                                       | Present in the capture                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `alias`, `disabled`                         | ✅ slot 3 (arranged by the procedure)                                  |
| `organizationName`                          | ✅ all three                                                           |
| `usageAgeSeconds`                           | ✅ all three                                                           |
| `spend.used` / `limit` / `pct` / `currency` | ✅ slots 1 and 2; slot 3 has no plan (so the null path is covered too) |
| `spend.countdown` / `spend.clock`           | ❌ **not present** — see below                                         |
| `expectedPct`, `aheadOfPace` (7d)           | ✅ all three                                                           |
| `aheadOfPace: true` specifically            | ✅ slot 3's 7-day window                                               |
| `expectedPct`, `aheadOfPace` (scoped)       | ✅ all three                                                           |

#### The one gap, and how far it is closed

`cswap-list-0.23.synthetic.json` is **authoritative for nothing except `spend.countdown` and
`spend.clock`.** It is a whole account row, so tests reading it necessarily touch other fields —
`used` / `limit` / `pct` / `currency` are asserted from it too — but each of those is independently
asserted from the captured sample, so no guarantee rests on the synthetic file alone. It is labelled
synthetic in its own `//` field, and the honest limitation stands: **those two spellings are the only
consumed keys in this work not verified against live CLI output.**

Two things narrow the risk. Their spellings are transcribed from `json_output.py` → `usage_to_json`,
not guessed. And that function derives them from the _same_ code path as the `fiveHour` / `sevenDay`
reset trio, which the captured sample **does** verify against live output — a divergence would mean
cswap emitting one spelling for window resets and another for spend resets from adjacent lines of the
same function.

What the synthetic fixture still buys is the reader half of the contract: `toSpend` misspelling either
one would leave the field `null`, indistinguishable from cswap not sending it, and now fails a test
instead.

Every guarantee other than those two spellings rests on real CLI output. Two test layers use the
captured sample, because two independent misspellings are possible:

- **Layer 1** (`tests/cswap.test.ts`) — asserts each field is reachable through the **typed
  accessor**, catching an interface key that disagrees with cswap.
- **Layer 2** (`tests/accounts.test.ts`) — asserts the **normalized values** after `classifyPool()`,
  catching a reader that misspells a key (which would compile and silently yield `null`).

---

## 6. Version floor

The plugin degrades by omission on older cswap: absent fields normalize to `null` and simply do not
render, which is indistinguishable from a plugin bug without a documented floor.

| Capability                                               | Requires                              | Basis                                                                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Minimum verified version**                             | **0.23.0**                            | Everything in this document is verified only here.                                                                                                                               |
| Core rotation (list/switch/`run`/session layout)         | 0.14.0 historically, re-verified 0.23 | §1 and `step0-verification.md`.                                                                                                                                                  |
| `organizationName` in labels                             | ≤ 0.14.0                              | Present in this repo's own `cswap-list.sample.json`, captured at 0.14.0.                                                                                                         |
| `cswap disable` / `enable`, and the `cswap-disabled` row | 0.21.0                                | 0.21.0 release notes ("disable/enable accounts without logging out").                                                                                                            |
| `alias` in labels                                        | 0.21.0                                | 0.21.0 release notes ("per-account aliases").                                                                                                                                    |
| Pace annotation; usage-age segment                       | 0.23.0                                | 0.23.0 release notes (#148); `pace.py`.                                                                                                                                          |
| Spend meter / segment                                    | 0.23.0                                | Verified live at 0.23.0. Present in the TUI by 0.18.0, but its `--list --json` introduction is **not pinned** — the floor is stated as the verified version rather than guessed. |

---

## 7. UI node budget

Node cost is a closed form in **accounts × scoped windows**; see
[`plugin-ui-widgets.md`](plugin-ui-widgets.md) for the formula and the grid test. Per-model windows
fold into one table plus one worst-window gauge from two windows up (issue #56), so the per-account
cost is uniform in `S` and the view is bounded at 253 of the host's 256 nodes.

The rich/compact spend switch (`min(N,16) × (15 + 2S) ≤ 220`) is stated in terms of `S` rather than a
fixed account threshold, because `S` is externally driven — cswap emits one weekly window per model
with a per-model limit — so a constant sized at one `S` overclaims at another. Note it is no longer
_derived from_ the node closed form: it charges 2 nodes per scoped window, while a folded account
costs 2 in total. It is a deliberately **conservative over-estimate** — it over-charges, never
under-charges, so it can only fold spend into the account label earlier than strictly necessary.

That same budget is load-bearing for the node bound: the rich path costs up to 17 nodes per account,
which at 16 accounts would exceed `MAX_NODES`, and it is `RICH_NODE_BUDGET` that caps the account
count instead. The bound holds only while `RICH_NODE_BUDGET ≤ 254`.
