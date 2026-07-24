# Plugin UI graphical widgets — host contract & verification

The claude-swap plugin publishes a declarative `publishUI` view. Alongside the flat widgets
(`stack`/`text`/`badge`/`meter`/`table`/`key-value`/`callout`) it now emits five **graphical**
node types. These render in **Settings → Plugins** of the Shepherd host UI.

## Host verification (pinned)

Verified against `erwins-enkel/shepherd` `main` @ **`095d4310eb3768502630760804b346d90e37c3d4`**
(2026-06-28). PR #1189 ("host renderers for graphical node types") is **merged and live**:
`ui/src/lib/plugin-ui/registry.ts` registers all five keys, each mapped to a shipped Svelte component.

| node `type`   | Host component (`ui/src/lib/plugin-ui/`) | Props the component reads                                            |
| ------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| `gauge`       | `PuiGauge.svelte`                        | `value`, `max`, `label`, `caption`, `tone`                           |
| `sparkline`   | `PuiSparkline.svelte`                    | `points` (number[]), `label`, `caption`, `tone`                      |
| `time-series` | `PuiTimeSeries.svelte`                   | `series` (each `{ label, tone, points }`), `yMax`, `kind`, `caption` |
| `bar-chart`   | `PuiBarChart.svelte`                     | `bars` (each `{ label, value, tone }`), `max`, `orientation`         |
| `timeline`    | `PuiTimeline.svelte`                     | `events` (each `{ at, label, caption?, tone? }`)                     |

Tone strings (`neutral`/`ok`/`warn`/`error`/`info`) flow through the host `toneColor()` helper —
the same vocabulary the existing `meter`/`badge` already render.

## Validator caps (host `src/plugins/ui-validate.ts`, verified @ `095d431`)

`validatePluginUIView` drops the ENTIRE view (fail-open) if any of these are exceeded — so the
plugin's view builder stays under all of them:

- `MAX_NODES = 256` total nodes
- `MAX_ARRAY = 500` (any props/children array)
- `MAX_DEPTH = 16` (root = depth 1)
- `MAX_BYTES = 64 KB` serialized

The builder enforces a JOINT cap of `MAX_DETAILED_ACCOUNTS = 16` detailed accounts (flat + graphical),
collapsing any surplus into one `"+N more accounts"` text node, and downsamples chart point arrays to
`CHART_WINDOW = 60`.

### Node cost is a closed form in accounts × scoped windows

```
nodes(N, S) = BASE + min(N, 16) × (perAccount + 2S) + (N > 16 ? 1 : 0)

  BASE        10, plus one node per optional section present (last-spawn, heal, error callouts)
  perAccount  13 compact | 15 rich (spend meter + gauge)
  2S          one meter + one gauge per scoped weekly window
  +1          the "+N more accounts" node, above MAX_DETAILED_ACCOUNTS
```

`S` is **externally driven** — cswap emits one weekly window per model that has a per-model limit —
so any budget claim pinned at a single `S` is an overclaim. That is worth stating plainly because
this section previously claimed a 40-account test "proves the worst case … stays within all four
caps": that fixture runs at `S = 0` with `active: true` (which suppresses both action-buttons), i.e.
the cheapest column of the grid. It pins the truncation path, not the worst case.

`tests/ui-view.test.ts` therefore runs a **grid** over N ∈ {1, 3, 8, 12, 14, 16, 17, 20, 40} ×
S ∈ {0, 1, 2, 3, 4, 6, 8}, with History filled to `QUOTA_RING_CAP` / `SPAWN_RING_CAP`. It verifies
the closed form exactly, asserts all four caps for every combination the rich/compact switch admits,
and asserts that no over-cap combination is caused by that switch.

### Known limitation: ≥2 scoped windows can exceed `MAX_NODES`

From `S = 2` the compact path has a hard account ceiling well below the 16-account truncation limit
— 14 accounts at `S = 2`, 12 at `S = 3`, 11 at `S = 4`, 9 at `S = 6`, 8 at `S = 8` — because
truncation caps at 16 detailed accounts and `16 × (13 + 2·2) = 218 + BASE` already exceeds the cap.
Beyond those ceilings the host drops the whole view.

This predates the 0.23 field work and is caused by the per-scoped-window meter and gauge, not by
spend rendering; the grid test pins the exact set so a newly introduced overflow cannot blend in.
Fixing it means changing how scoped windows render or lowering `MAX_DETAILED_ACCOUNTS` — tracked
separately.

## Chart time-span semantics

A chart's x-axis spans the in-memory history = up to `QUOTA_RING_CAP (288) × refreshIntervalMs`.
At the **default `refreshIntervalMs = 60000` (60 s)** that is ≈ **4.8 h**; a larger interval stretches
the span proportionally (e.g. `300000` ms → ~24 h), a smaller one shrinks it. Downsampling to
`CHART_WINDOW` changes resolution, not span. History is **in-memory only** and resets on plugin restart.

This is distinct from the `5h` / `7d` labels on the quota gauges/meters, which denote **cswap's rolling
quota windows** (5-hour and 7-day usage %), NOT the chart's time axis.

## Fallback on older hosts

A host predating PR #1185 exposes no `ctx.publishUI`; the plugin's `typeof ctx.publishUI === "function"`
guard then skips UI emission entirely and falls back to `publishStatus`. A host with `publishUI` but
without #1189's renderers would draw unknown node types as the host's per-node `UnknownNodeTile`
placeholder (the flat panel is unaffected — `validateNode` has no type whitelist).

## Release gate (re-run against the DEPLOYED host SHA)

Blob-SHA comparison of the vendored `types.ts` is NOT a drift signal — it is a deliberate subset
mirror (local blob `1f42a3c`, upstream@`095d431` `c34ca03`; never expected to match). The meaningful,
checkable gate is behavioral — confirm the deployed host renders these types:

    # Preferred: the five registry keys are present (#1189 live)
    gh api repos/erwins-enkel/shepherd/contents/ui/src/lib/plugin-ui/registry.ts?ref=<DEPLOYED_SHA> \
      --jq '.content' | base64 -d | grep -E 'gauge|sparkline|time-series|bar-chart|timeline'
    # Transitional fallback only (pre-#1189): per-node tolerance present
    gh api repos/erwins-enkel/shepherd/contents/ui/src/lib/plugin-ui/PluginUIRenderer.svelte?ref=<DEPLOYED_SHA> \
      --jq '.content' | base64 -d | grep -E 'UnknownNodeTile|hasOwn'

Verified on host `main` `095d431` (2026-06-28): all five keys present → renders today.

## Decision log

- **2026-06-28 — Renders today.** PR #1189 is live on host `main` `095d431`; the five node types are
  known registry keys rendered by real components. The plugin emits them additively alongside the flat
  widgets; `schemaVersion` stays `1`.
- **2026-06-28 — Hybrid emission rejected.** Expressing the new history via already-supported primitives
  (e.g. spawn history as a `table`) was considered to make the feature render without a host dependency.
  Rejected: now that #1189 is live the graphical types render natively, so a parallel primitive rendering
  would be pure transitional redundancy. (User-confirmed: "1189 is already live".)
- **2026-06-28 — Contract is the deliverable; structural verification accepted.** In-repo tests verify
  emitted-tree structure, prop alignment to the shipped host components, and host-cap compliance — not
  pixels (the host renders the pixels). User-confirmed acceptable.
- **History is in-memory only** (bounded ring buffers, reset on restart); no `ctx.state` persistence.
