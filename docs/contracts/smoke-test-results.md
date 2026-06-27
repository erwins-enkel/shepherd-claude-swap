# Real end-to-end smoke test (live `cswap`)

`register()` was run with the **default (real) runner** against the live `cswap` on the
target host (Linux, `cswap 0.14.0`), then the captured `onSpawn` hook was invoked for fresh
and repeat sessions. Emails redacted below; the run used the host's real accounts.

## Boot — pool after boot-warm

`cswap --list --json` returned 3 accounts; classified pool:

| #   | active  | usageStatus | 5h pct | 7d pct | usable | rateLimited | ready   | why                                                                                                                     |
| --- | ------- | ----------- | ------ | ------ | ------ | ----------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | no      | ok          | 100    | 20     | yes    | **yes**     | no      | rate-limited (5h ≥ 100) → skipped for assignment                                                                        |
| 2   | no      | ok          | 0      | 98     | yes    | no          | **yes** | profile exists + warmed → assignable                                                                                    |
| 3   | **yes** | ok          | 11     | 3      | yes    | no          | no      | **active account** → `cswap run` same-account fast path creates no session profile → existence guard keeps it not-ready |

`lastError: null`.

## onSpawn results

```
onSpawn(sess-A) -> { credentialDir: ".../sessions/2-<slug>" }
onSpawn(sess-B) -> { credentialDir: ".../sessions/2-<slug>" }   # account 2 is the only ready+usable+non-rate-limited account
onSpawn(sess-A) -> { credentialDir: ".../sessions/2-<slug>" }   # resume reuses the same account → STICKY PASS
```

`GET stats` → `assignments: { sess-A: 2, sess-B: 2 }`, `cursor: 2`, `lastSpawn` set,
`lastError: null`. State persisted: `cursor=2`, `assignments={sess-A:2,sess-B:2}`.

## What this verifies (beyond unit tests)

- Real `cswap --list --json` parsing + classification on live data (3 accounts).
- Boot-warm gating produced a non-empty ready set; **the warm-time existence guard correctly
  excluded the active account** (no isolated profile) and the **rate-limited account**.
- `onSpawn` returns a real, on-disk `credentialDir`; sticky-per-session holds; state persists;
  `GET stats` works; no quota consumed (warm uses `--version`).

## Behavior confirmed → documented as a limitation

The active `cswap` account is structurally excluded from rotation (it has no isolated session
profile). This is correct and safe — the plugin never injects a non-existent `credentialDir` —
but it means rotation spans **non-active** accounts only. See the README "Limitations" section.
A future enhancement could let the active account participate by injecting the default
`~/.claude` instead of a per-account profile; deferred as out of v1 scope.
