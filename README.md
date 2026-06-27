# shepherd-claude-swap

A Shepherd server-side plugin that spreads agent spawns across a pool of Claude accounts
managed by [`cswap`](https://github.com/realiti4/claude-swap). On each `onSpawn` event it
assigns an account from the pool and injects that account's isolated `CLAUDE_CONFIG_DIR`
(`credentialDir` in the `SpawnPatch`). Assignments are sticky per session: every resume of a
session lands on the same account it was created under. New sessions are distributed
round-robin over usable, ready accounts. When no account is usable the spawn is hard-blocked
rather than silently falling back to the default login.

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

| Field               | Type               | Default         | Meaning                                                                                                                          |
| ------------------- | ------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `cswapBin`          | `string`           | `"cswap"`       | `cswap` binary name or absolute path.                                                                                            |
| `includeSlots`      | `number[] \| null` | `null`          | Account numbers eligible for the pool. `null` = all accounts.                                                                    |
| `excludeSlots`      | `number[]`         | `[]`            | Account numbers always excluded from the pool.                                                                                   |
| `rateLimitPct`      | `number`           | `100`           | Accounts with a 5-hour or 7-day usage `pct` ≥ this value are treated as rate-limited and skipped for new sessions. Range 0–1000. |
| `prewarmArgs`       | `string[]`         | `["--version"]` | Args passed after `cswap run <N> --` to bootstrap a session profile. `--version` exits instantly with no quota usage.            |
| `refreshIntervalMs` | `number`           | `60000`         | Background `cswap --list` refresh + stale-profile re-warm interval (ms).                                                         |
| `bootWarmTimeoutMs` | `number`           | `30000`         | Max time (ms) the plugin waits for ≥1 account to become ready at boot before unblocking HTTP.                                    |
| `abortOnEmpty`      | `boolean`          | `true`          | Hard-block spawns (`ctx.abortSpawn`) when no usable account is available. Set `false` to fail-open (not recommended).            |

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

**Background loop:** Every `refreshIntervalMs` the pool is re-listed and any usable-but-not-
ready accounts are re-warmed out of band.

**No global `cswap --switch` is ever called.** Isolation is per-spawn `credentialDir` only,
so a running agent's credentials are never rotated by a concurrent spawn.

**Status panel:** Open Settings → Plugins in the Shepherd UI to see per-account 5h/7d quota,
current session→account assignments, and the last spawn decision in real time.

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

### (a) Two concurrent sessions land on different accounts

```sh
# In two terminals, simultaneously:
shepherd create --session A
shepherd create --session B

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

```sh
shepherd resume --session A

# In the resumed agent:
claude auth status --json | jq '{email: .email}'
# Expected: same email as in step (a) for session A.
```

### (c) All accounts rate-limited → create is blocked

Temporarily set `rateLimitPct: 0` in `config.json` (treats all accounts as rate-limited),
then restart Shepherd. Attempt a create:

```sh
shepherd create --session C
# Expected: spawn refused with an error — no agent launched, worktree rolled back.
# Restore rateLimitPct to 100 and restart when done.
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

- **`cswap` profile-path coupling.** The plugin derives the session-profile path from
  `cswap`'s documented scheme (`sessions/<N>-<emailSlug>/`). If `cswap` changes its layout
  the plugin breaks. See [docs/PRD.md §9](docs/PRD.md) for the mitigation strategy.

- **No hot-reload.** Plugins load at boot only (Shepherd's design). Config changes require
  `systemctl --user restart shepherd`.

- **`types.ts` is vendored from Shepherd** (Apache-2.0). See [NOTICE](NOTICE) for the exact
  commit SHA and full attribution.
