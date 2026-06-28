# shepherd-claude-swap

A Shepherd server-side plugin that spreads agent spawns across a pool of Claude accounts
managed by [`cswap`](https://github.com/realiti4/claude-swap). On each `onSpawn` event it
assigns an account from the pool and injects that account's isolated `CLAUDE_CONFIG_DIR`
(`credentialDir` in the `SpawnPatch`). Assignments are sticky per session: every resume of a
session lands on the same account it was created under. New sessions are distributed
round-robin over usable, ready accounts by default, or by most-remaining-quota when the
`least-used` strategy is enabled. When no account is usable the spawn is refused rather
than silently falling back to the default login — Shepherd holds and retries a refused
create until an account frees (no task loss), while a non-forced resume is hard-blocked.

See [docs/PRD.md](docs/PRD.md) for full background and design rationale.

---

## Requirements / preconditions

These are correctness preconditions — without them the plugin misbehaves silently.

1. **`cswap` installed and on `PATH`**, with ≥2 accounts already added via
   `cswap --add-account`. The plugin consumes accounts; it never adds them. The binary must
   be the one from [realiti4/claude-swap](https://github.com/realiti4/claude-swap) (MIT).

2. **Trusted (non-membrane) spawn profile.** Under a sandbox/membrane profile the injected
   per-account `credentialDir` is not bound into the jail — `claude` would see an empty dir.
   Use the trusted (passthrough) spawn profile only. See
   [docs/contracts/step0-verification.md](docs/contracts/step0-verification.md) precondition 1.

3. **Subscription (non-api-key) Shepherd auth mode.** In api-key mode Shepherd injects an
   `apiKeyHelper` which authenticates via the managed key regardless of the OAuth
   `CLAUDE_CONFIG_DIR` injected by this plugin — defeating per-account rotation entirely.
   See [docs/contracts/step0-verification.md](docs/contracts/step0-verification.md) precondition 2.

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

| Field               | Type                            | Default         | Meaning                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cswapBin`          | `string`                        | `"cswap"`       | `cswap` binary name or absolute path.                                                                                                                                                                                                                     |
| `includeSlots`      | `number[] \| null`              | `null`          | Account numbers eligible for the pool. `null` = all accounts.                                                                                                                                                                                             |
| `excludeSlots`      | `number[]`                      | `[]`            | Account numbers always excluded from the pool.                                                                                                                                                                                                            |
| `rateLimitPct`      | `number`                        | `100`           | Accounts with a 5-hour or 7-day usage `pct` ≥ this value are treated as rate-limited and skipped for new sessions. Range 0–1000.                                                                                                                          |
| `strategy`          | `"round-robin" \| "least-used"` | `"round-robin"` | New-session selection strategy. `round-robin` spreads sessions evenly across eligible accounts. `least-used` assigns the eligible account with the most remaining quota (lowest `max(5h, 7d)` usage). Resume always reuses the pinned account regardless. |
| `prewarmArgs`       | `string[]`                      | `["--version"]` | Args passed after `cswap run <N> --` to bootstrap a session profile. `--version` exits instantly with no quota usage.                                                                                                                                     |
| `refreshIntervalMs` | `number`                        | `60000`         | Background `cswap --list` refresh + stale-profile re-warm interval (ms).                                                                                                                                                                                  |
| `bootWarmTimeoutMs` | `number`                        | `30000`         | Max time (ms) the plugin waits for ≥1 account to become ready at boot before unblocking HTTP.                                                                                                                                                             |
| `abortOnEmpty`      | `boolean`                       | `true`          | Refuse spawns (`ctx.abortSpawn`) when no usable account is available — Shepherd then holds and retries a refused create (no task loss) and hard-blocks a non-forced resume. Set `false` to fail-open (not recommended).                                   |

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

**Warm/retry resume edge case:** if a resume's pinned account is usable but its profile is
not yet pre-warmed (e.g. right after a restart), the spawn is aborted with a "retry" message
while a background re-warm is kicked off. This is a transient retry, not a failure — no
worktree is lost; resuming again once the account is warm lands on the same pinned account.

**Background loop:** Every `refreshIntervalMs` the pool is re-listed and any usable-but-not-
ready accounts are re-warmed out of band.

**No global `cswap --switch` is ever called.** Isolation is per-spawn `credentialDir` only,
so a running agent's credentials are never rotated by a concurrent spawn.

**Status panel:** Open Settings → Plugins in the Shepherd UI to see per-account 5h/7d quota,
current session→account assignments, and the last spawn decision in real time. An account whose quota `cswap` cannot currently report shows a **quota unknown** badge instead of a misleading `0%` meter.

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
  "lastSpawn": { "sessionId": "...", "accountNumber": 1, "credentialDir": "...", "at": "..." }
}
```

### `POST /api/plugins/claude-swap/reset`

Clears the sticky session→account map and resets the round-robin cursor. Existing running
agents are unaffected (their `CLAUDE_CONFIG_DIR` is already set). Next new session starts
round-robin from account 1 again.

Response: `{ "ok": true, "cleared": true }`

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
  most remaining quota (lowest `max(5h, 7d)` usage). Resume is always sticky to the pinned
  account either way.

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
  or `cswap --switch-to` an account you don't intend to rotate. Verified end-to-end against
  live `cswap`; see [docs/contracts/smoke-test-results.md](docs/contracts/smoke-test-results.md).

- **Rate-limited accounts are skipped** for new assignments (5h or 7d `pct ≥ rateLimitPct`),
  as reported by `cswap --list --json`. If every non-active account is rate-limited, new
  creates are refused and held in Shepherd's hold queue, retried until one frees up (no task
  loss); a non-forced resume is hard-blocked.

- **Accounts with unknown quota are deprioritized.** When `cswap --list --json` reports an account with `usageStatus: "ok"` but no usage figures (both 5h and 7d `pct` absent), its quota is unknown for that refresh. The panel shows a **quota unknown** badge instead of a misleading `0%` meter, and selection uses such an account only as a last resort — a new session is assigned a quota-unknown account only when no fully-known ready account exists. A resume stays pinned to its account regardless. The state clears automatically on the next refresh that reports usage. (Addresses [claude-swap#62](https://github.com/realiti4/claude-swap/issues/62).)

- **No hot-reload.** Plugins load at boot only (Shepherd's design). Config changes require
  `systemctl --user restart shepherd`.

- **`types.ts` is vendored from Shepherd** (Apache-2.0). See [NOTICE](NOTICE) for the exact
  commit SHA and full attribution.
