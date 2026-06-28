# AI agent guidelines — shepherd-claude-swap

This is the single source of truth for how AI agents should work in this repo.
`CLAUDE.md` imports it. It is a TypeScript + **Bun** plugin; deterministic guardrails do the
coaching so a human is rarely pulled in to re-explain a mechanical defect — let the gate fail
and self-correct.

## Engineering posture (surgical & mechanical)

- **Simplicity first.** Write the minimum code that solves the stated problem — no
  speculative features, abstractions for single use, or config nobody asked for.
- **Surgical changes.** Every changed line traces to the request. Don't refactor, reformat,
  or polish adjacent code; match existing style. Delete only what your change orphaned;
  surface pre-existing dead code rather than silently expanding the diff.
- **Fail closed.** Render error/unreachable paths as explicit failures; never let a swallowed
  error, empty result, or zero count masquerade as success.
- **Single source of truth.** Derive counts, totals, and dimensions from the data (array
  length, column count) — never hardcode a magic number that silently drifts.
- **Keep names and comments honest.** When you change a function's behavior, update its name,
  doc comment, and inline comments to match — no stale comment left behind.
- **No dead code.** Delete unreachable branches and unused fields/params, or wire them to a
  real path, before opening a PR.
- **Verify before claiming done.** Run the gate; show the output. Evidence before assertions.

## Guardrails in this repo (installed — they coach you)

- **The gate: `bun run verify`** — runs `tsc --noEmit`, `eslint .`, `prettier --check .`,
  `bun test`, and `fallow audit --base origin/main`. Run it before claiming done. CI runs the
  exact same command, so green locally means green in CI.
- **Pre-push** (`.husky/pre-push`) runs `bun run verify` — you never push red.
- **Commit messages** are Conventional Commits, enforced by commitlint via the `commit-msg`
  hook and a PR CI job. Use `feat:`, `fix:`, `chore:`, `ci:`, `docs:`, `refactor:`, `test:`.
- **Pre-commit** runs lint-staged (prettier + `eslint --fix`) on staged `.ts` files.
- **Dead code / complexity:** fallow (config in `.fallowrc.json`). Run `bunx fallow` for the
  full scan; before deleting an "unused" symbol confirm with
  `bunx fallow dead-code --trace <file>:<export>`. Model intentional exceptions narrowly in
  `.fallowrc.json` — never broadly disable a rule.
- **Dependencies:** Dependabot opens weekly update PRs (npm ecosystem updates `bun.lock`;
  github-actions ecosystem updates workflow pins).

## Toolchain

- Runtime & package manager: **Bun** — use `bun` / `bunx`, never `npm` / `npx`.
- TypeScript strict mode; ESM project (`"type": "module"`).
