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
`CHART_WINDOW = 60`. A test (`tests/ui-view.test.ts`) proves the worst case (FULL 288-sample rings ×
16 accounts + 50 spawns, 40-account pool) stays within all four caps.

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
