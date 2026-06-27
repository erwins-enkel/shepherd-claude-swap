# Step 0 — external-contract verification (gate results)

All gates run on the target host (Patrick's machine: `cswap 0.14.0`, `claude 2.1.195`,
`bun 1.3.14`) on 2026-06-27. Shepherd source inspected at
`/home/patrick/Work/shepherd` @ **`9124026a13479ca1d30173bf1f523e8950587051`** (main).

| Gate                                                                                           | Verdict     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **V1** — Shepherd plugin contract (`SpawnPatch`, `apiVersion`, capabilities, sync `state.set`) | ✅ VERIFIED | `types.ts` vendored at the pinned SHA; `apiVersion` const = 1; `SpawnPatch` = `env`/`extraArgs`/`credentialDir`; `PluginState.set` returns `void` (synchronous).                                                                                                                                                                                                                                           |
| **V2** — `cswap --list --json` schema                                                          | ✅ VERIFIED | `schemaVersion` 1; `usageStatus` ∈ {`ok`,…}; `usage.{fiveHour,sevenDay}.{pct,resetsAt}` present. Redacted fixture: `cswap-list.sample.json`. Live pool: acct1 `ok` 5h=92%, acct2 `ok` 5h=0%/7d=98%.                                                                                                                                                                                                        |
| **V3** — session-profile path scheme                                                           | ✅ VERIFIED | `cswap run 2 -- --version` created `~/.local/share/claude-swap/sessions/2-plenz_topmedia.de` — exactly `<backup>/sessions/<num>-<slug>`, backup root `~/.local/share/claude-swap`, slug = email with `@`/`.`→safe (`plenz@topmedia.de` → `plenz_topmedia.de`).                                                                                                                                             |
| **V4** — injected `CLAUDE_CONFIG_DIR` wins; no api-key env override (LOAD-BEARING)             | ✅ VERIFIED | Plugin patch folded into `patchEnv` (credentialDir → CLAUDE_CONFIG_DIR) and spread **last**: `service.ts:1425` `{...apiKeyPassthrough, ...rendererEnv, ...patchEnv}`. api-key mode injects **no** `ANTHROPIC_API_KEY`/`*_OAUTH_TOKEN` env var (uses `apiKeyHelper` in `--settings` + membrane masking, `spawn-auth.ts:54-83`); its only env is the mirror `CLAUDE_CONFIG_DIR`, merged _before_ `patchEnv`. |
| **V5** — `cswap run … -- --version` is quota-free                                              | ✅ VERIFIED | acct2 usage 5h 0.0→0.0, 7d 98.0→98.0 across a warm; `--version` makes no API turn (OAuth refresh is a token-endpoint call, not usage).                                                                                                                                                                                                                                                                     |
| **V6 / 0.6** — loader imports TS entry directly under Bun (no build)                           | ✅ VERIFIED | `loader.ts:209` candidates include `index.ts`/`index.tsx`; `loader.ts:176` `await import(pathToFileURL(entry))`; server runs `bun run src/index.ts`; `spawn-labeler` ships `index.ts`.                                                                                                                                                                                                                     |
| **0.7 / V8** — `register()` completes before HTTP accepts requests                             | ✅ VERIFIED | `index.ts:1951` `await pluginRegistry.loadAll()` precedes `index.ts:1961` `serve()` (→ `Bun.serve`, `server.ts:5285`); boot comment states the invariant. Underpins the boot-warm spawn-acceptance gate.                                                                                                                                                                                                   |

## Preconditions surfaced (documented, not blocking)

1. **Trusted (non-membrane) spawn profile required.** Under a membrane/sandbox profile the
   jail only binds Shepherd's own `claudeDir`; an alternate per-account `credentialDir`
   would not be bound and `claude` would see an empty dir. The trusted profile (passthrough)
   has no bind constraint. (Already a PRD §8 assumption; reinforce in README.)
2. **Subscription (non-api-key) Shepherd auth mode.** If Shepherd runs in api-key mode the
   agent still receives an `apiKeyHelper`, which would authenticate via the managed key
   regardless of the injected OAuth `CLAUDE_CONFIG_DIR` — defeating per-account subscription
   rotation. The plugin targets subscription-auth deployments; document this precondition in
   the README. (Refinement of PRD §8; not a design change.)

**Conclusion:** all gates green — the `onSpawn → { credentialDir }` per-account isolation
design is valid. Scaffolding (Task 1) may proceed.
