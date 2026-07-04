# shepherd-claude-swap

A Shepherd server-side plugin that spreads agent spawns across a pool of Claude accounts
managed by [`cswap`](https://github.com/realiti4/claude-swap). On each `onSpawn` event it
assigns an account from the pool and injects that account's isolated `CLAUDE_CONFIG_DIR`
(`credentialDir` in the `SpawnPatch`). Assignments are sticky per session: every resume of a
session lands on the same account it was created under. New sessions are distributed
round-robin over usable, ready accounts by default, by most-remaining-quota when the
`least-used` strategy is enabled, or — under `reset-soon` — onto an account whose 7-day window
resets within 24h and still has capacity (drain it before it refills), falling back to
`least-used` when none qualify. When no account is usable the spawn is refused rather
than silently falling back to the default login — Shepherd holds and retries a refused
create until an account frees (no task loss), while a non-forced resume is hard-blocked.

See [docs/PRD.md](docs/PRD.md) for full background and design rationale.

---

## Requirements / preconditions

These are correctness preconditions — without them the plugin misbehaves silently.

1. **`cswap` installed and on `PATH`**, with ≥2 accounts already added via
   `cswap --add-account`. The plugin consumes accounts; it never adds them. The binary must
   be the one from [realiti4/claude-swap](https://github.com/realiti4/claude-swap) (MIT).

2. **Trusted (non-membrane) spawn profile (normal sessions).** On a host predating
   shepherd#1217, a sandbox/membrane profile does not bind the injected per-account
   `credentialDir` into the jail — `claude` would see an empty dir — so run normal sessions under
   the trusted (passthrough) profile. (shepherd#1217+ _does_ bind a plugin-patched `credentialDir`
   into the membrane, validate-and-fail-open; that is what enables aux-spawn routing — see
   _Aux spawns_ — but the trusted profile remains the supported config for normal sessions.) See
   [docs/contracts/step0-verification.md](docs/contracts/step0-verification.md) precondition 1.

3. **Subscription (non-api-key) Shepherd auth mode.** In api-key mode Shepherd injects an
   `apiKeyHelper` that authenticates via the managed key regardless of the OAuth
   `CLAUDE_CONFIG_DIR` this plugin injects, so per-account _quota_ rotation is a no-op (the managed
   key bills). This applies to aux-spawn routing too: under shepherd#1217 an api-key reviewer is
   authenticated without a prompt, but the key still bills, so `routeAuxQuota` distributes no quota
   in api-key mode (see _Aux spawns_). See
   [docs/contracts/step0-verification.md](docs/contracts/step0-verification.md) precondition 2.

4. **Linux/WSL host.** `cswap` credential files live under
   `$XDG_DATA_HOME/claude-swap` (default `~/.local/share/claude-swap`). The path scheme is
   `sessions/<accountNumber>-<emailSlug>/`.

5. **OAuth accounts only.** API-key `cswap` accounts are automatically excluded from the
   rotation pool (`cswap run` session mode is OAuth-only).

---

## Install

Shepherd loads plugins at boot from `~/.shepherd/plugins/`. No build step — Bun imports
`index.ts` directly.

```sh
# Copy or symlink the repo into the plugins directory:
cp -r /path/to/shepherd-claude-swap ~/.shepherd/plugins/claude-swap
# or: ln -s /path/to/shepherd-claude-swap ~/.shepherd/plugins/claude-swap

# Restart Shepherd (plugins load at boot only):
systemctl --user restart shepherd
```

Edit `~/.shepherd/plugins/claude-swap/config.json` to override any defaults (see below).

---

## Configuration

All fields are optional — the shipped `config.json` sets every default explicitly.

| Field                 | Type                                            | Default         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------- | ----------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cswapBin`            | `string`                                        | `"cswap"`       | `cswap` binary name or absolute path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `includeSlots`        | `number[] \| null`                              | `null`          | Account numbers eligible for the pool. `null` = all accounts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `excludeSlots`        | `number[]`                                      | `[]`            | Account numbers always excluded from the pool.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `rateLimitPct`        | `number`                                        | `100`           | Accounts with a 5-hour or 7-day usage `pct` ≥ this value are treated as rate-limited and skipped for new sessions. Range 0–1000.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `strategy`            | `"round-robin" \| "least-used" \| "reset-soon"` | `"round-robin"` | New-session selection strategy. `round-robin` spreads sessions evenly across eligible accounts. `least-used` assigns the eligible account with the most remaining quota (lowest `max(5h, 7d)` usage). `reset-soon` favors an account whose **7-day** window resets within 24h and still has capacity (`7d < rateLimitPct`, and the 5-hour window keeps ≥10 pp of headroom so the funnel can't push it into a 5h rate-limit), drained by the `least-used` metric; with several such it picks lowest `max(5h, 7d)`, and with none it falls back to `least-used`. Resume always reuses the pinned account regardless. All three also govern **session-less** aux routing (doc / standalone critic); parent-pinned aux (review / plan-gate) inherits the parent's account regardless of strategy. |
| `prewarmArgs`         | `string[]`                                      | `["--version"]` | Args passed after `cswap run <N> --` to bootstrap a session profile. `--version` exits instantly with no quota usage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `refreshIntervalMs`   | `number`                                        | `60000`         | Background `cswap --list` refresh + stale-profile re-warm interval (ms).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `bootWarmTimeoutMs`   | `number`                                        | `30000`         | Max time (ms) the plugin waits for ≥1 account to become ready at boot before unblocking HTTP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `abortOnEmpty`        | `boolean`                                       | `true`          | Refuse spawns (`ctx.abortSpawn`) when no usable account is available — Shepherd then holds and retries a refused create (no task loss) and hard-blocks a non-forced resume. Set `false` to fail-open (not recommended).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `makePrimaryButtons`  | `boolean`                                       | `true`          | Show a per-account **Make primary** `action-button` in the panel (see _Make primary picker_ below). Requires a host whose `publishUI` renderer includes `action-button` (shepherd#1209/#1210). Set `false` on an older host to fall back to badge-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `routeAuxQuota`       | `boolean`                                       | `true`          | Route aux spawns (review / plan-gate / doc) onto a pool account (see _Aux spawns_ below). **Requires a Shepherd release containing shepherd#1217**, which binds the routed `credentialDir` into the reviewer sandbox. ⚠️ #1217 is **not yet in a shipped release** (latest v1.38.0 predates it), so on any host without it you **must** set `false` or routed reviewers run **unauthenticated** (re-login + theme prompt). Default `true` is a deliberate choice; the opt-out is annotated in `config.json`.                                                                                                                                                                                                                                                                                  |
| `autoHeal`            | `boolean`                                       | `true`          | Auto-revive non-active accounts that cswap transiently reports as `usageStatus: "unavailable"` (a usage-fetch failure, not a real auth fault), by switching the primary to the stuck account, launching a real Claude session against it, and switching back. Set `false` to disable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `autoHealAfterCycles` | `number`                                        | `2`             | Consecutive `--list` refreshes an account must stay `unavailable` before a heal is attempted. Higher = more conservative (waits out transient blips).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `healLaunchArgs`      | `string[]`                                      | `["-p","ok"]`   | Claude args for the heal-session launch (`cswap run <target> -- <healLaunchArgs>`). Must trigger a real API turn so the OAuth token is refreshed; `-p` headless exits on completion. A trivial quota cost per heal. Must be non-empty.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `healLaunchTimeoutMs` | `number`                                        | `60000`         | Timeout (ms) for the heal-session launch. Kills a hung session. Sized to a Claude cold start + one `-p` turn + slack.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

---

## How it works

**Boot:** `register()` runs before Shepherd accepts HTTP requests. It calls `cswap --list`
to enumerate the pool, then warms ≥1 account by running `cswap run <N> -- <prewarmArgs>` for
each usable account. It awaits until at least one account is ready or `bootWarmTimeoutMs`
elapses — this gating is what makes spawn acceptance safe. Warming creates the
per-account session profile under `cswap`'s backup directory without making any API calls
(verified: `--version` burns zero quota).

**`onSpawn` (hot path):** Purely in-memory — no `cswap` / network / filesystem I/O. Selects
an account, writes the sticky assignment to `ctx.state` (synchronously, before returning),
and returns `{ credentialDir: <session-profile-dir> }`. The injected path becomes
`CLAUDE_CONFIG_DIR` for the spawned agent.

**Aux spawns (review / plan-gate / doc) — shepherd#1205 / #1217:** When Shepherd fires
`onSpawn` for a review / plan-gate / doc sub-spawn (`kind !== "session"`), the plugin routes its
quota onto a pool account — gated by [`routeAuxQuota`](#configuration) (default `true`):

- **`routeAuxQuota: true`** (a host whose reviewer sandbox binds a plugin-patched `credentialDir`
  — [shepherd#1217](https://github.com/erwins-enkel/shepherd/pull/1217)+): a **review / plan-gate**
  spawn (has `parentSessionId`) inherits the parent session's pinned account `credentialDir`; a
  **doc / standalone-critic** spawn (no `parentSessionId`) is routed to a pool account
  _ephemerally_ — no durable pin, no cursor advance, and it never appears in the lastSpawn / spawn
  timeline. If the parent is untracked or no pool account is ready, the spawn falls open (`{}`) on
  the active account. #1217 hard-binds the routed dir, redirects its `projects` bind to the active
  projects dir (so usage/activity readback keeps working), rw-binds its `.claude.json`, and
  **validates the dir on host** — a missing dir falls open to the active account rather than
  crashing.
- **`routeAuxQuota: false`** (a host _without_ #1217): the plugin returns **no patch**, leaving the
  spawn on the sandbox-bound active account. Required on such hosts because the sandbox binds only
  Shepherd's active `~/.claude` — a routed `credentialDir` reaches it as an env var but its
  directory is never mounted, so it would resolve to an empty dir → an **unauthenticated reviewer**.
  ⚠️ #1217 is **not yet in a shipped Shepherd release** (latest v1.38.0 predates the merge), so on
  every currently-deployable host you must set `routeAuxQuota: false` until a #1217-bearing release
  is installed. The default is `true` as a deliberate, forward-looking choice.

**Auth-mode nuance:** credential routing requires a sandbox backend (bwrap). With a backend it works
in both modes — _subscription_ uses the pool account's OAuth (distributing real quota), while
_api-key_ keeps the managed key billing (the reviewer is authenticated without a prompt, but
`routeAuxQuota` distributes **no** quota — see [precondition 3](#requirements--preconditions)).
Without a backend, subscription still routes (runs unsandboxed on the host) while api-key safely
no-ops the routing via its credential-less mirror.

An aux spawn is **never aborted** in either mode (a refused review is terminal — no held retry).
Hosts predating shepherd#1205 (no `kind` field on `SpawnDescriptor`) are treated as normal session
spawns.

**Warm/retry resume edge case:** if a resume's pinned account is usable but its profile is
not yet pre-warmed (e.g. right after a restart), the spawn is aborted with a "retry" message
while a background re-warm is kicked off. This is a transient retry, not a failure — no
worktree is lost; resuming again once the account is warm lands on the same pinned account.

**Background loop:** Every `refreshIntervalMs` the pool is re-listed and any usable-but-not-
ready accounts are re-warmed out of band.

**Auto-healing unavailable accounts:** cswap sometimes marks a non-active account
`usageStatus: "unavailable"` when a transient usage-fetch fails. This is not a real auth
fault, but the account drops out of rotation until cswap can fetch its usage successfully.
The root cause: cswap refuses to refresh the OAuth token of an account that has a live
session profile (it would rotate the token out from under the running agent). Once the token
expires, usage fetches fail → `unavailable`.

A bare `cswap --switch-to <stuck>` / `--switch-to <primary>` does **not** fix this — without
a real Claude session performing an API turn, the token is never refreshed. The correct manual
fix is: `cswap --switch-to <stuck>`, then run a real Claude session (`cswap run <stuck> -- -p
ok`), then `cswap --switch-to <primary>`. `autoHeal` automates this dance.

On each background tick, after an account has been `unavailable` for `autoHealAfterCycles`
consecutive refreshes, the plugin:

1. Switches the primary to the stuck account (`cswap --switch-to <stuck>`).
2. Launches a real Claude session against it (`cswap run <stuck> -- <healLaunchArgs>`,
   default `-p ok`), which performs an API turn and refreshes the OAuth token.
3. Switches the primary back to the previous account.

The next `--list` fetch then sees fresh credentials → `ok`. One attempt per unavailable
episode; tracking resets when the account returns to `ok`. Only `usageStatus: "unavailable"`
non-active in-scope accounts are healed — `token_expired` / `no_credentials` / `api_key` are
cswap's job and are left alone.

**Timing is in refresh cycles**, so wall-clock latency depends on `refreshIntervalMs`. At the
shipped `config.json` value (600 000 ms = 10 min) with `autoHealAfterCycles: 2`, the first
heal fires ~2 cycles ≈ **20 minutes** after an account goes (and stays) unavailable; additional
stuck accounts heal one per subsequent cycle (~10 min apart). Lower `refreshIntervalMs` and/or
`autoHealAfterCycles` for faster recovery.

**Exposure / lock window:** for up to `healLaunchTimeoutMs` (default 60 s) the stuck account
is the active primary. Pass-through spawns can land on it only if `abortOnEmpty: false` or
`routeAuxQuota: false` (the defaults keep spawns off it). `POST switch-primary` returns 409
during that window.

**Outcome lag:** the "Last heal" status in `GET stats` and the Settings panel may briefly show
`failed` for a genuine heal, converging within one `refreshIntervalMs` (≈60 s at the code
default of 60 000 ms; longer at the shipped config.json value of 600 000 ms).

**Dead refresh token:** if the account's refresh token is truly invalid (needs
`cswap --add-account`), no session launch heals it — it stays `unavailable`. One attempt per
episode; the operator must re-authenticate.

**Best-effort:** the end-to-end `unavailable → ok` flip is verified against cswap **source**
(see [`docs/contracts/cswap-heal-mechanism.md`](docs/contracts/cswap-heal-mechanism.md)) but
not yet against live cswap. Treat auto-heal as best-effort.

**Restore safety:** if switching back to the prior primary fails (or lands on the wrong
account), the plugin records a durable warning — surfaced as an error in `GET stats` and the
Settings panel — that persists across restarts until the intended primary is active again.
Switch it back manually if you see it.

**No global `cswap --switch` on the hot path.** `onSpawn` uses per-spawn `credentialDir`
only — a running agent's credentials are never rotated by a concurrent spawn. An
operator-triggered global switch is available out of band via `POST switch-primary`
(never called by the hot path).

**Status panel:** Open Settings → Plugins in the Shepherd UI to see per-account 5h/7d quota,
current session→account assignments, and the last spawn decision in real time. An account whose quota `cswap` cannot currently report shows a **quota unknown** badge instead of a misleading `0%` meter. The active ("primary") account shows a **primary** badge. When the installed `cswap` reports per-model weekly limits (`usage.scoped`, unreleased as of claude-swap 0.16.0) — e.g. Fable — they appear as additional `<Model> wk` meters/gauges alongside the 5h/7d quota.

**Make primary picker:** each eligible non-primary account row carries a **Make primary** button
(a `publishUI` `action-button`) that POSTs `{ mode: "specific", account }` to the plugin's own
`switch-primary` route and re-publishes the panel — switching cswap's primary account without
leaving Settings. A confirm dialog (_"Make this the primary account?"_) guards the click, since the
switch is global. A button is shown only for accounts that are a sensible target — **usable and not
rate-limited**; the active account (it keeps its badge), rate-limited accounts, and unusable
accounts get none. A **quota-unknown** account is still eligible: unknown quota is a reporting gap,
not unusability, and you may legitimately want to move the primary onto one. (Only the first few
accounts get detailed rows; any beyond that fold into the "+N more accounts" line and get no
button.)

This picker requires a host whose `publishUI` renderer includes the `action-button` node
([shepherd#1209](https://github.com/erwins-enkel/shepherd/issues/1209) /
[#1210](https://github.com/erwins-enkel/shepherd/pull/1210)). It is enabled by default
(`makePrimaryButtons: true`); on an older host that lacks the renderer, set
`"makePrimaryButtons": false` in `config.json` to fall back to the badge-only view (otherwise those
rows render as placeholder tiles).

**Gear menu:** On Shepherd ≥ 1.39.0 the plugin also contributes a **Claude swap usage** entry to
the top-bar gear menu (desktop dropdown + mobile sheet). Clicking it opens Settings → Plugins
scrolled to this plugin's card — the same usage view described above, one click away. On older
Shepherd builds the entry is simply omitted (the capability is additive).

**Graphical widgets:** the panel also renders per-account quota gauges and sparklines, a cross-account
quota time-series, a session→account load bar-chart, and a spawn timeline (history is in-memory and
resets on plugin restart). These use declarative node types rendered by the Shepherd host
(see [`docs/contracts/plugin-ui-widgets.md`](docs/contracts/plugin-ui-widgets.md); host support landed
in shepherd #1189). Chart spans cover up to `288 × refreshIntervalMs` of history (≈4.8 h at the default
60 s interval) — distinct from the `5h`/`7d` quota-window labels.

---

## HTTP routes

Both routes require operator auth (Shepherd's standard plugin route auth).

### `GET /api/plugins/claude-swap/stats`

Returns the current pool state and session assignments as JSON:

```json
{
  "config": { "...": "..." },
  "pool": [
    {
      "number": 1,
      "email": "...",
      "usable": true,
      "rateLimited": false,
      "usageUnavailable": false,
      "ready": true,
      "fiveHourPct": 5,
      "sevenDayPct": 12
    }
  ],
  "assignments": { "<sessionId>": 1 },
  "cursor": 1,
  "lastSpawn": { "sessionId": "...", "accountNumber": 1, "credentialDir": "...", "at": "..." },
  "lastHeal": { "target": 2, "outcome": "healed", "restoreFailed": false, "at": "..." },
  "restoreFailure": null
}
```

### `POST /api/plugins/claude-swap/reset`

Clears the sticky session→account map and resets the round-robin cursor. Existing running
agents are unaffected (their `CLAUDE_CONFIG_DIR` is already set). Next new session starts
round-robin from account 1 again.

Response: `{ "ok": true, "cleared": true }`

### `POST /api/plugins/claude-swap/switch-primary`

Switches cswap's **global active ("primary") account**. Operator-triggered only — never runs
on the spawn hot path. After a successful switch the pool is refreshed: the newly-active
account leaves the rotation and the previously-active account is re-warmed in the background
and rejoins it.

Body: `{ "mode": "specific" | "next" | "best", "account"?: number | string }`

- `specific` — switch to a named account (number or email address). Requires `account`. Runs
  `cswap --switch-to <account>`.
- `next` — rotate to the next account in sequence. Runs `cswap --switch`.
- `best` — switch to the account with the most remaining 5h/7d quota. Runs
  `cswap --switch --strategy best`.

Responses:

- `200` — the cswap switch result JSON
  (`{ schemaVersion, switched, from, to, strategy, reason, message, warnings }`; see
  [`docs/contracts/cswap-switch.sample.json`](docs/contracts/cswap-switch.sample.json)).
- `400 { "ok": false, "error": … }` — malformed JSON body, or invalid/missing `mode`, or
  `specific` without `account`.
- `500 { "ok": false, "error": … }` — the cswap switch failed; selection state is left unchanged.

> **Fail-open note:** with `abortOnEmpty:false`, a `next`/`best` switch briefly clears the ready
> pool, so new creates during that short window may fail open onto the default `~/.claude` login;
> resumes still abort closed.

```sh
curl -s -X POST -H "Authorization: Bearer $SHEPHERD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"best"}' \
  http://localhost:<port>/api/plugins/claude-swap/switch-primary | jq .
```

---

## Manual smoke test (identity-asserting)

This procedure verifies **observed identity** — not just that `CLAUDE_CONFIG_DIR` is set,
but that each agent's `claude auth status --json` reports the assigned account's email.

**Prerequisites:** ≥2 OAuth accounts in the pool, Shepherd running, plugin loaded.

**Note:** Right after a Shepherd restart the entire pool is cold. Creates will block until
≥1 account warms (up to `bootWarmTimeoutMs` = 30 s by default). This is expected — wait
for the first spawn to succeed before running steps (a)–(d).

> There is no `shepherd` CLI binary. Sessions are created and resumed through the **Shepherd
> Web UI** (or the `POST /api/sessions` HTTP API); resume happens via Shepherd's normal
> autopilot / automerge / manual-resume flow.

### (a) Two concurrent sessions land on different accounts

Create two sessions in quick succession via the **Shepherd Web UI** (New Session × 2), or via
the HTTP API:

```sh
curl -s -X POST -H "Authorization: Bearer $SHEPHERD_TOKEN" \
  http://localhost:<port>/api/sessions -d '{"repo":"<repo>"}'   # session A
curl -s -X POST -H "Authorization: Bearer $SHEPHERD_TOKEN" \
  http://localhost:<port>/api/sessions -d '{"repo":"<repo>"}'   # session B

# In each session's agent, run:
claude auth status --json | jq '{email: .email}'

# Expected: session A shows accountEmail1, session B shows accountEmail2 (different).
```

Confirm via stats that both assignments are recorded:

```sh
curl -s -H "Authorization: Bearer $SHEPHERD_TOKEN" \
  http://localhost:<port>/api/plugins/claude-swap/stats | jq '.assignments'
```

### (b) Resume lands on the original account

Resume session A from the **Shepherd Web UI** (open the session and let it resume via the
normal autopilot / manual-resume flow). In the resumed agent:

```sh
claude auth status --json | jq '{email: .email}'
# Expected: same email as in step (a) for session A.
```

### (c) All accounts rate-limited → create is held and retried

Temporarily set `rateLimitPct: 0` in `config.json` (treats all accounts as rate-limited),
then restart Shepherd. Create a session from the **Shepherd Web UI** (or `POST /api/sessions`):

```sh
# Expected: session creation is refused — no agent launched, but the task is NOT lost:
# Shepherd parks the create in its hold queue (reason='capacity'). With rateLimitPct:0 no
# account ever frees, so the create stays held across sweeps. Restore rateLimitPct to 100
# and restart — a later sweep then finds a usable account and the held create proceeds.
```

### (d) Boot/background warm cycle burns no quota

```sh
# Before restart:
cswap --list --json | jq '[.accounts[] | {number, email, usage}]' > /tmp/before.json

systemctl --user restart shepherd
# Wait for Shepherd to finish boot-warming (plugin log shows "≥1 account ready").

# After restart:
cswap --list --json | jq '[.accounts[] | {number, email, usage}]' > /tmp/after.json

diff /tmp/before.json /tmp/after.json
# Expected: no change in pct values — --version makes no API calls.
```

---

## Limitations / notes

- **v1 scope.** Account add/login/token-refresh is `cswap`'s job; the plugin does not
  reimport accounts, predict rate-limit exhaustion beyond what `cswap` reports, or support
  multi-host coordination. See [docs/PRD.md §3](docs/PRD.md) for the full non-goals list.

- **Selection strategy is configurable.** New sessions default to round-robin across
  eligible accounts. Set `strategy: "least-used"` to instead assign the account with the
  most remaining quota (lowest `max(5h, 7d)` usage). Set `strategy: "reset-soon"` to favor an
  account whose 7-day window resets within 24h and still has capacity — burn the soon-to-refill
  quota first — falling back to `least-used` when no account qualifies. A 5-hour headroom guard
  keeps `reset-soon` from funnelling sessions into a short-window rate-limit that won't reset
  soon; the 7-day window itself needs no extra margin (an over-limit account self-corrects via
  the `rateLimited` flag at the next refresh). Resume is always sticky to the pinned account
  regardless, and every strategy applies to session-less aux routing too.

- **`cswap` profile-path coupling.** The plugin derives the session-profile path from
  `cswap`'s documented scheme (`sessions/<N>-<emailSlug>/`). If `cswap` changes its layout
  the plugin breaks. See [docs/PRD.md §9](docs/PRD.md) for the mitigation strategy.

- **The currently-active `cswap` account is excluded from the rotation pool.** `cswap run
<active>` takes a same-account fast path that launches `claude` under the default
  `~/.claude` **without** creating an isolated session profile. With no
  `sessions/<N>-<slug>/` dir to point at, the warm-time existence guard never marks that
  account ready, so it is never assigned (the plugin won't inject a non-existent
  `credentialDir`). Consequence: rotation spans your **non-active** accounts. To rotate
  across N accounts, make sure the one `cswap` currently has active is not the only spare —
  or use `POST switch-primary` (modes `specific`/`next`/`best`) to change the active account
  from the plugin without reaching for `cswap --switch-to` directly. After a switch the
  newly-active account leaves the rotation and the previously-active account rejoins it
  (re-warmed in the background). Verified end-to-end against live `cswap`; see
  [docs/contracts/smoke-test-results.md](docs/contracts/smoke-test-results.md).

- **Switching the primary account rewrites the global `~/.claude` default login.** This
  affects ANY `claude` session not running under an isolated `CLAUDE_CONFIG_DIR` — including
  non-Shepherd terminals and other tools that read `~/.claude`. It does **not** rotate a
  running Shepherd agent's credentials (agents run under their own isolated session-profile
  `CLAUDE_CONFIG_DIR`; only the active account uses `~/.claude` as its credential store, and
  it is excluded from rotation).

- **Operator recovery: pinned session blocked after a switch.** If you switch the primary
  **to** an account that currently has a live Shepherd session pinned to it, that account's
  isolated session profile moves into `~/.claude`, so the pinned session can no longer be
  warmed and its resume aborts ("warming; retry resume"). **Recovery:** switch the primary
  **away** from that account (to any other account, or `next`/`best`) — this restores its
  isolated session profile and the pinned session can resume.

- **Rate-limited accounts are skipped** for new assignments (5h or 7d `pct ≥ rateLimitPct`),
  as reported by `cswap --list --json`. If every non-active account is rate-limited, new
  creates are refused and held in Shepherd's hold queue, retried until one frees up (no task
  loss); a non-forced resume is hard-blocked.

- **Accounts with unknown quota are deprioritized.** When `cswap --list --json` reports an account with `usageStatus: "ok"` but no usage figures (both 5h and 7d `pct` absent), its quota is unknown for that refresh. The panel shows a **quota unknown** badge instead of a misleading `0%` meter, and selection uses such an account only as a last resort — a new session is assigned a quota-unknown account only when no fully-known ready account exists. A resume stays pinned to its account regardless. The state clears automatically on the next refresh that reports usage. (Addresses [claude-swap#62](https://github.com/realiti4/claude-swap/issues/62).)

- **No hot-reload.** Plugins load at boot only (Shepherd's design). Config changes require
  `systemctl --user restart shepherd`.

- **`types.ts` is vendored from Shepherd** (Apache-2.0). See [NOTICE](NOTICE) for the exact
  commit SHA and full attribution.
