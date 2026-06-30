# cswap auto-heal — pinned source evidence

cswap **0.14.0**, claude **2.1.195**, Linux host.
Source tree: `~/.local/share/uv/tools/claude-swap/lib/python3.13/site-packages/claude_swap/`

The cswap source is **not** in this repo; this file pins the file:line evidence the auto-heal
feature relies on so future readers can verify the reasoning without access to the live install.

---

## Source evidence table

| File:line                                      | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `json_output.py:66` (`usage_fields`)           | `usageStatus: "unavailable"` is emitted exactly when `_collect_usage → fetch_usage_for_account` yields `None`, i.e. the usage API fetch failed — not a real auth fault.                                                                                                                                                                                                                                                                                                                                                                  |
| `switcher.py:74`                               | `_USAGE_CACHE_TTL = 15` (seconds): `--list` usage results are cached 15 s when the account set is unchanged. The plugin polls every `refreshIntervalMs` (code default 60 s; this repo's `config.json` ships 600 000 ms), both well above 15 s — no stale-cache risk from the refresh loop.                                                                                                                                                                                                                                               |
| `switcher.py:1153–1164` (`_collect_usage`)     | For an account with a live session profile (`has_live_session = True`), cswap treats it as active (`is_active = is_active or has_live_session`) and **never** proactively refreshes its OAuth token. The inline comment reads: "refreshing the backup copy could rotate the refresh token out from under the live session. Worst case its usage shows as unavailable until the session exits." This is the exact population auto-heal targets — accounts cswap refuses to refresh because Shepherd agents are live under their profiles. |
| `oauth.py:248`                                 | Explicit policy: "Active accounts are never refreshed — Claude Code owns those credentials."                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `oauth.py:260–305` (`fetch_usage_for_account`) | For NON-live, non-active accounts cswap **does** proactively refresh expired tokens and retries once on 401. Ordinary inactive accounts therefore self-heal without any plugin intervention; auto-heal has no advantage over cswap's own logic for those accounts.                                                                                                                                                                                                                                                                       |
| `session.py:213–225` (`SessionManager.run`)    | `cswap run <active>` uses a same-account fast path that `exec`s `claude` directly under the default `~/.claude` (no isolated profile, no `CLAUDE_CONFIG_DIR`). A real session launched here refreshes the default-login OAuth token — the token cswap was refusing to refresh.                                                                                                                                                                                                                                                           |
| `switcher.py:2101–2104` (`_perform_switch`)    | When the primary is switched away from an account, cswap backs up the **current** account's live `~/.claude` credentials to the backup store. Switching away from the just-launched stuck account therefore persists its freshly-refreshed token in the backup store, where cswap can then successfully fetch usage → `ok`.                                                                                                                                                                                                              |

---

## End-to-end chain

1. **Switch primary to the stuck account** — its isolated backup-store credentials are
   restored to `~/.claude`.
2. **`cswap run <stuck> -- <healLaunchArgs>`** — Claude Code starts under `~/.claude`,
   performs an API turn, and refreshes the OAuth access token (which cswap had refused to
   refresh while a live session was active).
3. **Switch primary back** — cswap backs up the live `~/.claude` (now holding the fresh
   token) to the backup store.
4. **Next `--list` refresh** — cswap reads the backup-store credentials, the usage fetch
   succeeds → `usageStatus: "ok"`.

---

## Ceiling — what auto-heal cannot fix

- **Genuinely dead refresh token** (`invalid_grant`): Claude Code uses the same token and
  the same endpoint. If the refresh token is truly invalid, the launched session also fails
  to refresh it. The account stays `unavailable`; the operator must run `cswap --add-account`
  to re-authenticate.
- **Transient blips that self-clear**: a very short-lived usage-fetch failure may resolve
  on its own before `autoHealAfterCycles` consecutive refreshes elapse. Auto-heal never fires
  in that case; the account returns to `ok` without the dance.

---

## Verification status

The mechanism above is verified against cswap **0.14.0 source**.
The end-to-end `unavailable → ok` flip has **not yet been verified against live cswap**
(see `docs/contracts/smoke-test-results.md` — Step 0 section).
Treat auto-heal as best-effort.
