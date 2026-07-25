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
| `table`       | `PuiTable.svelte`                        | `columns` (string[]), `rows` (string[][]) — **no tone, no label**    |

`table` is listed here as well as among the flat widgets because the folded per-model rendering
(below) depends entirely on it: on a host without that renderer the whole per-model payload degrades
to `UnknownNodeTile`, on exactly the large pools the fold exists to fix, and no in-repo test can
detect it. Verified at the same pinned SHA by the release-gate command below. It also renders no
tone and no label, which is why the folded table carries a `note` column and prefixes its `model`
cells — and why one tone-carrying gauge survives the fold.

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
nodes(N, S) = BASE + Σ over min(N, 16) accounts of perAccount(Sᵢ) + (N > 16 ? 1 : 0)

  BASE           10, plus one per error callout present (restoreFailure, lastError) => 12 worst
                 case. Last-spawn and last-heal always emit a node (a placeholder when null), so
                 they are already inside the 10 and never vary it. An empty pool adds one
                 "No accounts" node.
  perAccount(S)  (rich ? 15 : 13) + (S >= 1 ? 2 : 0)
                 S = 1  -> one meter (flat) + one gauge (graphics)
                 S >= 2 -> one table (flat) + one worst-window gauge (graphics)
  +1             the "+N more accounts" node, above MAX_DETAILED_ACCOUNTS
```

The scoped-window term is **uniform in `S`**: since issue #56 an account's per-model windows fold
into one table plus one gauge from two windows up, so any account carrying at least one window costs
the same `+2`. A `usageUnavailable` row is cheaper still (10 nodes: flat 7 + graphics 3 — no 5h/7d,
no sparkline, and no scoped windows on either path).

#### Why `MAX_NODES` cannot be exceeded — and what that depends on

```
compact — perAccount <= 15, and MAX_DETAILED_ACCOUNTS caps the count  => Σ <= 16 × 15 = 240
rich    — perAccount <= 17, which at 16 accounts would be 272. RICH_NODE_BUDGET prevents it,
          capping a rich pool at R <= 12 with any scoped window (12 × 17 = 204) and R <= 14
          without (14 × 15 = 210)                                     => Σ <= 210
```

so `total <= 240 + 12 + 1 = 253`. **The bound depends on `RICH_NODE_BUDGET`** — the binding
constraint is `floor(budget / 17) <= 14`, so it holds only while `RICH_NODE_BUDGET <= 254`. At 255 a
rich pool reaches 15 accounts and the view hits 267, over the cap. Raising that budget means
re-deriving this proof, not just editing this paragraph.

#### Validator caps, by binding corner

| cap                  | bound                                                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_NODES` (256)    | `<= 253` as above. Sampled grid maxima: 251 (BASE 10) overall and on the folded path; the ceiling fixture pins 253 (BASE 12, 17 accounts × `S = 1`, both callouts) and 252 for the same shape at `N = 16`. |
| `MAX_ARRAY` (500)    | `CHART_WINDOW = 60`, `SPAWN_RING_CAP = 50`, `MAX_DETAILED_ACCOUNTS = 16`, folded table `rows <= MAX_TABLE_ROWS + 1 = 9`.                                                                                   |
| `MAX_DEPTH` (16)     | fixed by tree shape.                                                                                                                                                                                       |
| `MAX_BYTES` (64 KiB) | worst folded view **53 135 B (81 %)** — 16 accounts × 9 rows plus 16 worst-window gauges, built by the grid's 16 × `S = 12` combination. Asserted as a bound with headroom, not an equality.               |

**`MAX_BYTES` residual.** It is not closed by construction: several interpolated strings are
cswap/operator-supplied and unbounded in length — `email`, `alias` and `organizationName` in the
identity badge (pre-existing), and **`ScopedWindow.name`**, which the folded table's `model` cell
interpolates verbatim. `MAX_TABLE_ROWS` bounds the row _count_, not the row _bytes_. The figures
above use short model names (6–7 chars); the same view with 32-character names measures
**57 023 B (87 %)**. At that corner the name is interpolated **144 times** — 8 rows × 16 accounts
plus 16 worst-window gauge labels — so each extra character costs 144 B against 12 401 B of
headroom, and the ceiling is a **~92-character name** (93 is the first length that exceeds
`MAX_BYTES`, measured). The fold _reduces_ this exposure — `name` was previously
interpolated twice per window (meter and gauge labels) and is now interpolated once, at most 8
times per account.

`S` is **externally driven** — cswap emits one weekly window per model that has a per-model limit —
so any budget claim pinned at a single `S` is an overclaim. That is worth stating plainly because
this section previously claimed a 40-account test "proves the worst case … stays within all four
caps": that fixture runs at `S = 0` with `active: true` (which suppresses both action-buttons), i.e.
the cheapest column of the grid. It pins the truncation path, not the worst case.

`tests/ui-view.test.ts` therefore runs a **grid** over N ∈ {1, 3, 8, 12, 14, 16, 17, 20, 40} ×
S ∈ {0, 1, 2, 3, 4, 6, 8, 12}, with History filled to `QUOTA_RING_CAP` / `SPAWN_RING_CAP`. It
verifies the closed form exactly and asserts all four caps for **every** combination — the sweep was
previously gated on the rich path, which skipped the compact half entirely. `S = 12` is past
`MAX_TABLE_ROWS`, so it is the only column where a folded account emits the truncation row (9 rows),
which is the shape the byte figure above is measured from. The grid is swept once, at BASE 10; the
BASE-12 maximum belongs to the ceiling fixture.

### Folded per-model rendering (issue #56, fixed)

Before the fold, each scoped weekly window cost 2 nodes per account (a meter + a gauge), so from
`S = 2` the compact path had a hard account ceiling well below the 16-account truncation limit — 14
accounts at `S = 2`, 12 at `S = 3`, 8 at `S = 8` — and beyond it the host dropped the whole view.
The same combinations also exceeded `MAX_BYTES` (16 × 8 emitted 78 231 B), which the grid's
rich-only filter hid.

From **two** windows up an account now renders them as:

- **one `table`** in the flat pool section — columns `model | used | resets | note`, at most
  `MAX_TABLE_ROWS = 8` window rows plus a full-width `+N more windows` row;
- **one worst-window `gauge`** in the graphics section, carrying the tone the table cannot.

Both rank by ONE key — `worstFirst`: tone severity (`error` > `warn` > `ok`), then `pct`, then cswap
emission order. The table retains a _prefix_ of that ordering and the gauge takes its head, so **the
gauged window is always among the rendered rows**, and no higher-severity window is ever hidden
while a lower-severity one renders. Rows are then displayed back in cswap order so reading order
still matches the API. Accounts with 0 or 1 scoped windows are unchanged.

The `note` cell composes both conditions (`at/over rateLimitPct · ahead of pace (expected N%)`),
because the widget path shows both — tone carries the threshold while the caption carries the pace —
and the fold must not collapse that to one. `at/over rateLimitPct` names this plugin's configurable
threshold (`pct >= cfg.rateLimitPct`, inclusive), not a hard cswap limit.

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
      --jq '.content' | base64 -d | grep -E 'table|gauge|sparkline|time-series|bar-chart|timeline'
    # Transitional fallback only (pre-#1189): per-node tolerance present
    gh api repos/erwins-enkel/shepherd/contents/ui/src/lib/plugin-ui/PluginUIRenderer.svelte?ref=<DEPLOYED_SHA> \
      --jq '.content' | base64 -d | grep -E 'UnknownNodeTile|hasOwn'

Verified on host `main` `095d431` (2026-06-28): all five graphical keys present, plus `table` →
renders today.

## Decision log

- **2026-07-25 — Per-model windows fold from two up; one table + one worst-window gauge.** Fixes the
  `MAX_NODES` (and `MAX_BYTES`) overflow above. `table` is not a new host bet: this plugin emitted
  `{ type: "table", props: { columns, rows } }` until commit `332595c` (the main-line squash of
  "drop raw session→account table; bar-chart covers share (#34)"), which removed it for _duplication_
  — "the Assignments table duplicated data the assignment bar-chart already aggregates" — not for
  lack of host support. That same commit is the precedent for emitting the table in the flat section
  only: in the graphics section it would carry no graphic and duplicate the flat one verbatim.
  Rejected alternatives: gating the fold on a node-budget ceiling (keeps per-model bars on small
  pools, at the cost of a ceiling constant, a config-aware cost model and a conservatism band — all
  of it machinery for that one benefit); and lowering `MAX_DETAILED_ACCOUNTS` (charges every large
  pool the worst-case price regardless of how many models it actually has).
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
