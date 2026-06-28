# PRD — `claude-swap` integration plugin for Shepherd

**Status:** Draft for review · **Owner:** Patrick Lenz · **Date:** 2026-06-27

## 1. Problem

[Shepherd](https://github.com/erwins-enkel/shepherd) orchestrates many concurrent
Claude Code agents. Run enough of them under a single Claude account and you hit the
5-hour / 7-day usage limits — agents stall or fail mid-task. Operators with multiple
Claude accounts have no built-in way to spread Shepherd's spawns across those accounts.

Shepherd recently shipped a **server-side plugin system** (`#1124`) whose load-bearing
seam is `ctx.onSpawn(d → SpawnPatch)` — a hook that runs just before each agent launches
and can inject `env` / `credentialDir` (= `CLAUDE_CONFIG_DIR`). Its public example,
`spawn-labeler` (`#1153`), is explicitly described in `docs/plugins.md` as the
"benign, public-safe analog of the private `claude-swap` env-injection seam." This project
builds that real plugin: it wraps the external [`realiti4/claude-swap`](https://github.com/realiti4/claude-swap)
CLI (`cswap`) to give each spawned agent its own Claude account, with true per-process
isolation.

## 2. Goals

- Spread Shepherd's agent spawns across multiple Claude accounts so parallel work stops
  exhausting a single account's quota.
- Reuse `cswap` as the credential store / switcher rather than reimplementing account
  management — the plugin is an **integration**, not a second account manager.
- Per-agent isolation: each spawned agent runs under exactly one account via its own
  `CLAUDE_CONFIG_DIR`, with no global credential mutation that could rotate creds out from
  under another running agent.
- Keep a session on one account across its lifecycle (create + every resume) for auth and
  cost-replay continuity.
- Refuse to spawn under the wrong account: if no usable account is available, refuse the
  spawn rather than silently fall back to the default login.
- Surface what the plugin is doing (pool, per-account quota, assignments) in Shepherd's
  Settings → Plugins panel.

## 3. Non-goals (v1)

- Reimplementing account add/login/token-refresh — that stays `cswap`'s job.
- Usage-aware auto-disable / predictive rate-limit avoidance beyond skipping accounts
  `cswap` already reports as rate-limited. (Deferred — see §9.)
- Overriding the spawn **model** (Shepherd's plugin API defers `model` patching in v1).
- API-key accounts: `cswap run` (session mode) is OAuth-only, so API-key slots are
  excluded from the rotation pool.
- A standalone UI beyond the Settings → Plugins status panel + the plugin's HTTP routes.
- Multi-host / shared-account coordination across more than one Shepherd instance.

## 4. Target users

- **Primary:** Shepherd operators (self-hosted, single-author trust model) who run many
  parallel Claude Code agents and hold 2+ Claude accounts.
- **Secondary:** Shepherd plugin authors who will read this plugin as the canonical
  real-world reference for the `onSpawn → { credentialDir }` seam.

## 5. Core user stories

1. As an operator, I drop the plugin into `~/.shepherd/plugins/`, point its `config.json`
   at my `cswap` install, restart Shepherd, and parallel agents transparently fan out
   across my accounts.
2. As an operator, when a new session is created it is assigned the next account in
   round-robin order; when that session later resumes (autopilot / automerge / manual) it
   reuses the **same** account it was created under.
3. As an operator, when all accounts are rate-limited or none can be made ready, the spawn
   is **refused** instead of running under my default login — and I see why. A refused
   create is held in Shepherd's hold queue and retried until an account frees (no task
   loss); a non-forced resume returns "can't resume".
4. As an operator, I open Settings → Plugins and see each account's 5h/7d quota, which
   session is on which account, and the last spawn decision.
5. As an operator, I call `GET /api/plugins/claude-swap/stats` to inspect assignments and
   `POST /api/plugins/claude-swap/reset` to clear the sticky session→account map.

## 6. Scope

### In scope (v1)

- A Shepherd plugin folder (`plugin.json` + `index.ts` + `config.json`) targeting
  plugin `apiVersion: 1`, declaring capabilities `["spawn", "state", "routes", "status"]`.
- **Account enumeration** via `cswap --list --json` (accounts, 5h/7d `pct`/`resetsAt`,
  `usageStatus`, `active`), filtered to OAuth accounts in the configured pool.
- **Selection strategy:** sticky-per-session (sessionId → account, persisted in
  `ctx.state`) with round-robin assignment for new sessions; rate-limited accounts
  (`usageStatus` reported by `cswap`) are skipped when assigning a new session. Accounts whose usage `cswap` reports as unavailable (`usageStatus: "ok"` but no 5h/7d `pct`) have unknown quota and are deprioritized — used for a new session only when no fully-known ready account exists (resume stays pinned).
- **Per-spawn injection:** `onSpawn` returns `{ credentialDir: <session-profile-dir> }`
  pointing at the chosen account's `cswap` session profile
  (`<cswap-backup>/sessions/<num>-<email-slug>/`).
- **Profile pre-warming (out of band):** because `cswap` only creates session profiles via
  `cswap run` (which `exec`s Claude), the plugin bootstraps each pool account's profile
  off the hot path (at boot and/or in the background) by invoking a throwaway
  `cswap run <N> -- <trivial-exit>`, then resolves the deterministic profile path. Token
  refresh / seeding therefore never runs inside the 5-second `onSpawn` budget.
- **Spawn refusal:** `ctx.abortSpawn(reason)` when no usable account is ready for
  assignment. Shepherd parks a refused create in its `held_tasks` hold queue
  (`reason='capacity'`) and retries it via the sweeper until an account frees (no task
  loss); a non-forced resume is hard-blocked ("can't resume").
- **Status panel:** `ctx.publishStatus(...)` with config in effect, per-account quota,
  current session→account assignments, and the last spawn decision.
- **Routes (behind operator auth):** `GET stats`, `POST reset`.
- **Config (`config.json`):** `cswap` binary path/command, account pool (slots to include
  or exclude), throwaway pre-warm argv, and toggles for skip-rate-limited and
  abort-on-empty.

### Out of scope (v1)

- Everything in §3 (Non-goals).
- Hot-reload / live reconfiguration (plugins load at boot only — by Shepherd's design).
- Modifying Shepherd core or the `realiti4/claude-swap` source (the plugin is additive and
  out-of-repo). Any upstream `cswap` improvement is a separate, optional follow-up.

## 7. Key design decisions (resolved)

| Decision            | Choice                                                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integration target  | Wrap external `realiti4/claude-swap` (`cswap`) — not a self-contained switcher                                                                                                     |
| Isolation mechanism | Per-spawn `credentialDir` = the account's `cswap` session-profile `CLAUDE_CONFIG_DIR` (no global `cswap --switch`, which would race parallel spawns and rotate live agents' creds) |
| Selection           | Sticky-per-session; round-robin for new sessions; skip `cswap`-reported rate-limited accounts; deprioritize unknown-quota accounts                                                 |
| No usable account   | Refuse via `ctx.abortSpawn`; Shepherd holds + retries a refused create (no task loss), hard-blocks a non-forced resume                                                             |
| Profile seam        | Self-contained: pre-warm profiles out-of-band via `cswap run`, inject the resolved path                                                                                            |
| Scope               | Lean: select + inject + status panel + stats/reset routes                                                                                                                          |

## 8. Assumptions

- `cswap` is installed and reachable, and the operator has already run `cswap --add-account`
  for each pool account (the plugin consumes accounts; it does not create them).
- The host is Linux/WSL (Shepherd's deployment target), so credentials are file-based and
  the backup root is `$XDG_DATA_HOME/claude-swap` (default `~/.local/share/claude-swap`);
  session-profile paths follow `cswap`'s documented `sessions/<num>-<email-slug>/` scheme.
- Shepherd runs under the `trusted` spawn profile, so an injected `credentialDir` /
  `CLAUDE_CONFIG_DIR` reaches the agent (the SpawnPatch `env` merges last and wins over
  Shepherd's api-key-mode mirror).
- `onSpawn` must stay well under its 5-second timeout; all network / token-refresh work is
  pushed off the hot path into pre-warming.

## 9. Risks & mitigations

- **`cswap` profile-path coupling.** The plugin computes the session-profile path from
  `cswap`'s documented scheme. If `cswap` changes that layout the plugin breaks.
  _Mitigation:_ centralize path derivation in one module, validate the resolved dir is a
  valid logged-in profile before injecting, fail-block on mismatch. A future upstream
  `cswap prepare --json` command (out of scope here) would remove the coupling entirely.
- **Pre-warm staleness.** A profile may go stale (token rotation, `cswap`'s
  `.cswap-stale-credentials` marker) between pre-warm and spawn. _Mitigation:_ validate at
  injection time; re-warm out of band; block (don't silently spawn) if a profile can't be
  made valid in time.
- **Concurrency.** Many agents spawn near-simultaneously on Shepherd's single event loop.
  _Mitigation:_ keep `onSpawn` to cheap in-memory selection + a `state` write; never run
  blocking `cswap`/`fs` calls synchronously on the hot path.
- **API-key accounts.** Unsupported by `cswap run`. _Mitigation:_ exclude them from the
  pool and surface the exclusion in the status panel.
- **Resume after pool change.** A session's sticky account may be removed from the pool.
  _Mitigation:_ on resume, if the pinned account is gone/unusable, block the resume with a
  clear reason rather than silently reassigning.

## 10. Success criteria

1. With ≥2 OAuth accounts configured, N concurrently-created sessions are distributed
   round-robin across the pool, each agent observing a distinct `CLAUDE_CONFIG_DIR`.
2. A session created on account A resumes on account A across autopilot / automerge /
   manual resume.
3. With every pool account rate-limited (or no profile ready), a create is refused and
   parked in Shepherd's hold queue, then retried until an account frees (no worktree loss);
   a non-forced resume returns "can't resume" — neither spawns under the default login.
4. No global `cswap --switch` is performed; a running agent's credentials are never
   rotated by another spawn.
5. The Settings → Plugins panel shows live per-account quota and session→account
   assignments; `GET stats` returns them and `POST reset` clears the sticky map.
6. A missing/empty plugin install, or absent `cswap`, degrades cleanly — the plugin reports
   `errored` in the panel and (per config) blocks rather than mis-spawns; a stock Shepherd
   with no plugin is unaffected.
7. The plugin honors the single-loop discipline: no synchronous blocking work in `onSpawn`,
   which stays within its 5-second budget.
