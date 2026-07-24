import type { PluginUINode, PluginUIView } from "../types";
import type { ResolvedConfig } from "./config";
import type { PoolAccount, SpendInfo, WindowPace } from "./accounts";
import type { SelectionState } from "./selection";
import type { LastSpawn } from "./status";
import type { HealRecord, HealRestoreFailure } from "./prewarm";
import { History, downsample, CHART_WINDOW, MAX_DETAILED_ACCOUNTS } from "./history";

/** Neutral identity chip so every account row names its account even on a host that does not
 *  render plain `text` nodes (the bug this addresses: bars/rows with no account attribution).
 *
 *  Also the only place a `cswap-disabled` row can say so. The status badge cannot carry it:
 *  `buildStatusBadge` short-circuits on `active` and then `usageUnavailable`, and `classifyPool`
 *  orders non-ok `usageStatus` ahead of the cswap-disabled branch — so an active parked account
 *  badges "primary" and an unavailable one badges its status, both with no rotation button and no
 *  indication of why. The marker is the reason, not the remedy — it reads `cswap-disabled`, which
 *  names the cswap-side gate; the README documents `cswap enable <n>` as the release. This label
 *  renders unconditionally on every row, in both the flat and graphical sections, and costs no
 *  extra node. */
function identityBadge(acct: PoolAccount, spendInline: boolean): PluginUINode {
  const age = usageAgeLabel(acct.usageAgeSeconds);
  const segments = [
    // The email is ALWAYS rendered, even when an alias is set: this badge is the only place the
    // panel shows it, and it is what maps a row to its on-disk profile
    // (`sessions/<n>-<slugify(email)>/`). An alias is a nickname, not an identity.
    acct.alias !== null ? `${acct.alias} (${acct.email})` : acct.email,
    ...(acct.cswapDisabled ? ["cswap-disabled"] : []),
    ...(acct.organizationName !== null ? [acct.organizationName] : []),
    ...(spendInline && acct.spend !== null ? [spendSegment(acct.spend)] : []),
    ...(age !== null ? [`usage ${age} old (at last refresh)`] : []),
  ];
  return {
    type: "badge",
    props: { label: `#${acct.number} ${segments.join(" · ")}`, tone: "neutral" },
  };
}

/**
 * Staleness threshold (seconds) for surfacing `usageAgeSeconds`.
 *
 * Deliberately a FLAT constant tied to cswap's own ~3-minute poll cadence, NOT derived from this
 * plugin's `refreshIntervalMs`. They measure different clocks: `usageAgeSeconds` is how long cswap
 * has been serving a stale snapshot, while `refreshIntervalMs` is how often we re-read that number.
 * Gating the former on the latter could only ever suppress — at the shipped 600 000 ms it would
 * hide ten minutes of cswap last-good serving, and at a legal 3 600 000 a full hour of it, which is
 * exactly the condition worth showing. Our own polling lag is handled by the "at last refresh"
 * qualifier instead.
 */
const STALE_USAGE_S = 300;

/** Human age for a stale usage measurement, or null when it is fresh enough to be uninteresting. */
function usageAgeLabel(ageSeconds: number | null): string | null {
  if (ageSeconds === null || ageSeconds < STALE_USAGE_S) return null;
  const mins = Math.round(ageSeconds / 60);
  return mins < 60 ? `${mins}m` : `${Math.round(mins / 60)}h`;
}

/** Display-rounded spend percentage.
 *
 *  cswap pre-rounds the 5h/7d window pcts, which is why `quotaCaption` can interpolate them raw —
 *  but it passes `spend.pct` through from the API verbatim, and that arrives at full float
 *  precision (a live account reports `1.3727272727272726`). Rounded only for display; the raw
 *  value still drives the tone threshold, so a 99.96% budget is not rounded up into `error`. */
function spendPctLabel(spend: SpendInfo): string {
  return `${Math.round(spend.pct * 10) / 10}%`;
}

/** Compact spend text for the identity label: `spend <pct>% (<used>/<limit> <CUR>)`. */
function spendSegment(spend: SpendInfo): string {
  return (
    `spend ${spendPctLabel(spend)} (${spend.used}/${spend.limit} ${spend.currency}` +
    `${resetSuffix(spend.resetClock, spend.resetCountdown)})`
  );
}

/** Reset suffix for a quota caption. Anchored on the absolute `clock` (non-drifting); the
 *  relative `countdown` is appended in parens when present. Empty when no clock is available. */
function resetSuffix(clock: string | null, countdown: string | null): string {
  if (clock === null) return "";
  return countdown !== null ? ` · resets ${clock} (${countdown})` : ` · resets ${clock}`;
}

/** Caption for a quota meter/gauge: `<pct>%` plus reset suffix, or `n/a` when pct is unknown.
 *  Gating on `pct !== null` keeps null-pct windows rendering exactly `"n/a"`. */
function quotaCaption(pct: number | null, clock: string | null, countdown: string | null): string {
  if (pct === null) return "n/a";
  return `${pct}%${resetSuffix(clock, countdown)}`;
}

/** Caption for a WEEKLY window: the quota caption plus an "ahead of pace" note when cswap says the
 *  window is burning faster than the week's elapsed fraction. cswap noise-gates that flag (>=15pp
 *  over expected, suppressed for 24h after a reset), so it is shown verbatim rather than re-judged. */
function weeklyCaption(
  pct: number | null,
  clock: string | null,
  countdown: string | null,
  pace: WindowPace,
): string {
  const base = quotaCaption(pct, clock, countdown);
  if (!pace.aheadOfPace) return base;
  const expected = pace.expectedPct !== null ? ` (expected ${pace.expectedPct}%)` : "";
  return `${base} · ahead of pace${expected}`;
}

/** Tone for a weekly window: `error` at/over the limit, else `warn` when ahead of pace, else ok. */
function weeklyTone(pct: number, rateLimitPct: number, pace: WindowPace): string {
  if (pct >= rateLimitPct) return "error";
  return pace.aheadOfPace ? "warn" : "ok";
}

/** Text node explaining why quota is unknown. Wording differs for the active (primary) account
 *  because it is excluded from rotation, not merely deprioritized. */
function quotaUnknownNote(active: boolean): PluginUINode {
  const content = active
    ? "quota unknown — primary account (excluded from rotation)"
    : "quota unknown — deprioritized; re-checked next refresh";
  return { type: "text", props: { content } };
}

/** Status badge for one account: `active` wins first, then the remaining chain. */
function buildStatusBadge(acct: PoolAccount, isReady: boolean): PluginUINode {
  if (acct.active) return { type: "badge", props: { label: "primary", tone: "info" } };
  if (acct.usageUnavailable)
    return { type: "badge", props: { label: "quota unknown", tone: "warn" } };
  if (isReady) return { type: "badge", props: { label: "ready", tone: "ok" } };
  if (acct.rateLimited) return { type: "badge", props: { label: "rate-limited", tone: "error" } };
  if (acct.usable) return { type: "badge", props: { label: "warming", tone: "warn" } };
  return { type: "badge", props: { label: acct.reason ?? "unusable", tone: "neutral" } };
}

/** Per-account "Make primary" action-button: POSTs a specific-account switch to the plugin's own
 *  `switch-primary` route. The bare path is resolved by the host under `/api/plugins/claude-swap/`
 *  (leading `/` and `..` are rejected host-side). `account` is the slot number — the route's
 *  specific-by-number fast path drops only the target from `ready`. Confirmed before POST because
 *  switching the primary is a global, disruptive action. Emitted only for eligible non-primary
 *  accounts and gated by `cfg.makePrimaryButtons` (see `buildPoolAccountRow`). */
function makePrimaryButton(acct: PoolAccount): PluginUINode {
  return {
    type: "action-button",
    props: {
      label: "Make primary",
      tone: "neutral",
      route: { method: "POST", path: "switch-primary" },
      body: { mode: "specific", account: acct.number },
      confirm: "Make this the primary account?",
    },
  };
}

/** Whether an account is a sensible "Make primary" target: a non-active account that is usable and
 *  not rate-limited. Quota-unknown (`usageUnavailable`) accounts stay eligible — that is a reporting
 *  gap, not unusability, and an operator may legitimately move the primary onto one. */
function canMakePrimary(acct: PoolAccount): boolean {
  return !acct.active && acct.usable && !acct.rateLimited;
}

/** Whether an account is excluded by STATIC config (`excludeSlots` / `includeSlots`). Decided
 *  directly from `cfg`, NOT from `PoolAccount.reason`: `classifyPool` short-circuits on non-ok
 *  usageStatus before the exclude branches, so a config-excluded account that is also unavailable
 *  carries `reason:"unavailable"`. Config exclusion is the permanent, higher-order lever, so such a
 *  row gets NEITHER rotation button (mirrors classifyPool's `excluded-slot`-over-out-of-rotation
 *  ranking). Consequence: while config-excluded, an out-of-rotation flag can't be cleared from the
 *  UI — the operator must remove the config exclusion first. */
function isConfigExcluded(cfg: ResolvedConfig, accountNumber: number): boolean {
  return (
    cfg.excludeSlots.includes(accountNumber) ||
    (cfg.includeSlots !== null && !cfg.includeSlots.includes(accountNumber))
  );
}

/** Per-account "Take out of rotation" action-button: POSTs `{ account, inRotation:false }` to the
 *  plugin's `set-rotation` route (host-resolved under `/api/plugins/claude-swap/`). Confirmed before
 *  POST because taking an account out aborts resumes pinned to it. */
function takeOutOfRotationButton(acct: PoolAccount): PluginUINode {
  return {
    type: "action-button",
    props: {
      label: "Take out of rotation",
      tone: "warn",
      route: { method: "POST", path: "set-rotation" },
      body: { account: acct.number, inRotation: false },
      confirm: "Take this account out of rotation?",
    },
  };
}

/** Per-account "Return to rotation" action-button: POSTs `{ account, inRotation:true }`. Purely
 *  additive (re-includes the account), so no confirm dialog. */
function returnToRotationButton(acct: PoolAccount): PluginUINode {
  return {
    type: "action-button",
    props: {
      label: "Return to rotation",
      tone: "ok",
      route: { method: "POST", path: "set-rotation" },
      body: { account: acct.number, inRotation: true },
    },
  };
}

/** The rotation toggle button for one account, or null when none applies. Gated by
 *  `cfg.rotationButtons` (host `action-button` support). Config-excluded accounts get none;
 *  a cswap-disabled account gets none (the panel cannot release that gate — see below);
 *  a set member gets "Return to rotation"; any other non-active account gets "Take out of rotation";
 *  the active account gets none (it is already outside the rotation pool). */
function rotationButtonFor(
  acct: PoolAccount,
  cfg: ResolvedConfig,
  outOfRotation: Set<number>,
): PluginUINode | null {
  if (!cfg.rotationButtons) return null;
  if (isConfigExcluded(cfg, acct.number)) return null;
  // Parked by cswap itself: the panel cannot release that gate (only `cswap enable <n>` can), so
  // offering "Return to rotation" would be a lie. The identity label names the lever instead.
  if (acct.cswapDisabled) return null;
  if (outOfRotation.has(acct.number)) return returnToRotationButton(acct);
  if (!acct.active) return takeOutOfRotationButton(acct);
  return null;
}

/** Meters (5h + 7d + one per scoped weekly window, e.g. Fable) for an account with known
 *  quota, or the quota-unknown note. Scoped-window tone is display-only — it never affects
 *  account classification (that invariant lives in accounts.ts). */
function buildAccountMeters(
  acct: PoolAccount,
  rateLimitPct: number,
  richSpend: boolean,
): PluginUINode[] {
  // Spend is a DIFFERENT axis from the 5h/7d quota windows and can be known while they are not,
  // so a quota-unknown row still shows it rather than hiding real information.
  const spendNodes = richSpend && acct.spend !== null ? [spendMeter(acct.number, acct.spend)] : [];
  if (acct.usageUnavailable) return [quotaUnknownNote(acct.active), ...spendNodes];
  const fivePct = acct.fiveHourPct ?? 0;
  const sevenPct = acct.sevenDayPct ?? 0;
  const fiveCaption = quotaCaption(
    acct.fiveHourPct,
    acct.fiveHourResetClock,
    acct.fiveHourResetCountdown,
  );
  const sevenCaption = weeklyCaption(
    acct.sevenDayPct,
    acct.sevenDayResetClock,
    acct.sevenDayResetCountdown,
    acct.sevenDayPace,
  );
  return [
    {
      type: "meter",
      props: {
        label: `#${acct.number} · 5h`,
        value: fivePct,
        max: 100,
        caption: fiveCaption,
        tone: fivePct >= rateLimitPct ? "error" : "ok",
      },
    },
    {
      type: "meter",
      props: {
        label: `#${acct.number} · 7d`,
        value: sevenPct,
        max: 100,
        caption: sevenCaption,
        tone: weeklyTone(sevenPct, rateLimitPct, acct.sevenDayPace),
      },
    },
    ...acct.scopedWindows.map((w): PluginUINode => ({
      type: "meter",
      props: {
        label: `#${acct.number} · ${w.name} wk`,
        value: w.pct,
        max: 100,
        caption: weeklyCaption(w.pct, w.resetClock, w.resetCountdown, w),
        tone: weeklyTone(w.pct, rateLimitPct, w),
      },
    })),
    ...spendNodes,
  ];
}

/** Spend meter (flat row). `value` is cswap's own `utilization`; the plugin never divides, so an
 *  unlimited plan cannot produce a divide-by-zero — cswap omits the entry entirely instead. */
function spendMeter(accountNumber: number, spend: SpendInfo): PluginUINode {
  return {
    type: "meter",
    props: {
      label: `#${accountNumber} · spend`,
      value: spend.pct,
      max: 100,
      caption: `${spendPctLabel(spend)} · ${spend.used}/${spend.limit} ${spend.currency}${resetSuffix(spend.resetClock, spend.resetCountdown)}`,
      tone: spend.pct >= 100 ? "error" : "ok",
    },
  };
}

/** Build the flat pool row for one account: identity + status badge + meters or unknown note.
 *  When `showMakePrimary` is on (config flag) and the account is an eligible target, the header
 *  also carries a "Make primary" action-button. `rotationButton`, when non-null, is the account's
 *  rotation toggle (already gated/decided by `rotationButtonFor`). */
function buildPoolAccountRow(
  acct: PoolAccount,
  isReady: boolean,
  rateLimitPct: number,
  showMakePrimary: boolean,
  rotationButton: PluginUINode | null,
  richSpend: boolean,
): PluginUINode {
  const header: PluginUINode[] = [identityBadge(acct, !richSpend), buildStatusBadge(acct, isReady)];
  if (showMakePrimary && canMakePrimary(acct)) header.push(makePrimaryButton(acct));
  if (rotationButton !== null) header.push(rotationButton);
  return {
    type: "stack",
    props: { direction: "vertical", gap: "sm" },
    children: [
      {
        type: "stack",
        props: { direction: "horizontal" },
        children: header,
      },
      ...buildAccountMeters(acct, rateLimitPct, richSpend),
    ],
  };
}

/** Spend gauge (graphics section). Mirrors `spendMeter`. */
function spendGauge(accountNumber: number, spend: SpendInfo): PluginUINode {
  return {
    type: "gauge",
    props: {
      label: `#${accountNumber} · spend`,
      value: spend.pct,
      max: 100,
      tone: spend.pct >= 100 ? "error" : "ok",
      caption: `${spendPctLabel(spend)} · ${spend.used}/${spend.limit} ${spend.currency}${resetSuffix(spend.resetClock, spend.resetCountdown)}`,
    },
  };
}

/** Build the graphical section node for one account: gauges (5h + 7d + one per scoped weekly
 *  window, e.g. Fable) + sparkline, or unknown note. */
function buildGraphicsAccountNode(
  a: PoolAccount,
  rateLimitPct: number,
  history: History,
  richSpend: boolean,
): PluginUINode {
  const spendNodes = richSpend && a.spend !== null ? [spendGauge(a.number, a.spend)] : [];
  if (a.usageUnavailable) {
    return {
      type: "stack",
      props: { direction: "vertical" },
      children: [identityBadge(a, !richSpend), quotaUnknownNote(a.active), ...spendNodes],
    };
  }
  const fp = a.fiveHourPct ?? 0;
  const sp = a.sevenDayPct ?? 0;
  const toneFor = (pct: number) => (pct >= rateLimitPct ? "error" : "ok");
  const fiveCaption = quotaCaption(a.fiveHourPct, a.fiveHourResetClock, a.fiveHourResetCountdown);
  const sevenCaption = weeklyCaption(
    a.sevenDayPct,
    a.sevenDayResetClock,
    a.sevenDayResetCountdown,
    a.sevenDayPace,
  );
  const points = downsample(
    history.quotaFor(a.number).map((s) => s.five ?? 0),
    CHART_WINDOW,
  );
  return {
    type: "stack",
    props: { direction: "vertical" },
    children: [
      identityBadge(a, !richSpend),
      {
        type: "gauge",
        props: {
          label: `#${a.number} · 5h`,
          value: fp,
          max: 100,
          tone: toneFor(fp),
          caption: fiveCaption,
        },
      },
      {
        type: "gauge",
        props: {
          label: `#${a.number} · 7d`,
          value: sp,
          max: 100,
          tone: weeklyTone(sp, rateLimitPct, a.sevenDayPace),
          caption: sevenCaption,
        },
      },
      ...a.scopedWindows.map((w): PluginUINode => ({
        type: "gauge",
        props: {
          label: `#${a.number} · ${w.name} wk`,
          value: w.pct,
          max: 100,
          tone: weeklyTone(w.pct, rateLimitPct, w),
          caption: weeklyCaption(w.pct, w.resetClock, w.resetCountdown, w),
        },
      })),
      ...spendNodes,
      {
        type: "sparkline",
        props: {
          label: `#${a.number} · 5h trend`,
          points,
          tone: toneFor(fp),
        },
      },
    ],
  };
}

/** Nodes for the "Last spawn" key-value or placeholder text. */
function buildLastSpawnNodes(lastSpawn: LastSpawn | null): PluginUINode[] {
  if (lastSpawn !== null) {
    return [
      {
        type: "key-value",
        props: {
          pairs: [
            { key: "session", value: lastSpawn.sessionId },
            { key: "account", value: `#${lastSpawn.accountNumber}` },
            { key: "at", value: lastSpawn.at },
          ],
        },
      },
    ];
  }
  return [{ type: "text", props: { content: "No spawns yet" } }];
}

/** Nodes for the "Last heal" section: bold header + key-value or placeholder. */
function buildLastHealNodes(lastHeal: HealRecord | null): PluginUINode[] {
  const result: PluginUINode[] = [
    { type: "text", props: { content: "Last heal", weight: "bold" } },
  ];
  if (lastHeal !== null) {
    result.push({
      type: "key-value",
      props: {
        pairs: [
          { key: "target", value: `#${lastHeal.target}` },
          { key: "outcome", value: lastHeal.outcome },
          { key: "at", value: lastHeal.at },
        ],
      },
    });
  } else {
    result.push({ type: "text", props: { content: "No heals yet" } });
  }
  return result;
}

/** Error callout shown when the heal dance left the primary on the wrong account. */
function buildRestoreFailureCallout(rf: HealRestoreFailure): PluginUINode {
  return {
    type: "callout",
    props: {
      tone: "error",
      text: `Primary may be on the wrong account — auto-heal could not restore #${rf.intendedActive} (landed ${rf.landedActive ?? "unknown"}). Switch primary back manually.`,
    },
  };
}

/**
 * Node budget for the rich (spend meter + gauge) rendering.
 *
 * The view's node count is an exact closed form, verified against this builder across accounts ×
 * scoped-window combinations:
 *
 *   nodes(N, S) = BASE + min(N, MAX_DETAILED_ACCOUNTS) × (perAccount + 2S) + (N > 16 ? 1 : 0)
 *   perAccount = 13 compact | 15 rich
 *   BASE       = 10, plus one per error callout present (restoreFailure, lastError) ⇒ 12 worst case.
 *                Last-spawn and last-heal emit placeholder nodes when null, so they never vary it.
 *
 * The host validator drops the ENTIRE view above MAX_NODES = 256, so the per-account budget is
 * 256 − 12 (worst-case BASE) = 244; 220 leaves ~10% headroom for future growth. `S` is externally driven —
 * cswap emits one weekly window per model with a per-model limit — so a fixed account threshold
 * would silently overclaim at a different `S` (at S=8 the rich path blows the cap at 8 accounts).
 */
const RICH_NODE_BUDGET = 220;

/** Does the rich spend rendering fit? `S` is the largest scoped-window count among the accounts
 *  that are actually RENDERED — beyond `MAX_DETAILED_ACCOUNTS` the surplus collapses into a single
 *  "+N more accounts" node and costs nothing per window, so counting those would under-render. */
function useRichSpend(pool: PoolAccount[]): boolean {
  const rendered = pool.slice(0, MAX_DETAILED_ACCOUNTS);
  const s = rendered.reduce((max, a) => Math.max(max, a.scopedWindows.length), 0);
  return rendered.length * (15 + 2 * s) <= RICH_NODE_BUDGET;
}

/** Build a `settings-panel` PluginUIView with the same data as buildStatus. */
export function buildUIView(
  cfg: ResolvedConfig,
  pool: PoolAccount[],
  ready: Set<number>,
  state: SelectionState,
  lastSpawn: LastSpawn | null,
  lastError: string | null,
  history: History = new History(),
  lastHeal: HealRecord | null = null,
  restoreFailure: HealRestoreFailure | null = null,
  outOfRotation: Set<number> = new Set(),
): PluginUIView {
  const nodes: PluginUINode[] = [];

  // ── Config key-value ──────────────────────────────────────────────────────
  nodes.push({
    type: "key-value",
    props: {
      pairs: [
        { key: "strategy", value: cfg.strategy },
        { key: "rateLimitPct", value: `${cfg.rateLimitPct}%` },
        { key: "refreshIntervalMs", value: String(cfg.refreshIntervalMs) },
        { key: "abortOnEmpty", value: String(cfg.abortOnEmpty) },
        { key: "makePrimaryButtons", value: String(cfg.makePrimaryButtons) },
        { key: "rotationButtons", value: String(cfg.rotationButtons) },
        { key: "autoHeal", value: String(cfg.autoHeal) },
        { key: "autoHealAfterCycles", value: String(cfg.autoHealAfterCycles) },
      ],
    },
  });

  // Spend renders as its own meter+gauge when the pool's measured node cost leaves room, and
  // folds into the identity label otherwise. See `useRichSpend` for why this is derived rather
  // than a fixed account threshold.
  const richSpend = useRichSpend(pool);

  // ── Pool section ──────────────────────────────────────────────────────────
  nodes.push({ type: "text", props: { content: "Pool", weight: "bold" } });

  if (pool.length === 0) {
    nodes.push({ type: "text", props: { content: "No accounts" } });
  } else {
    const detailed = pool.slice(0, MAX_DETAILED_ACCOUNTS);
    for (const acct of detailed) {
      nodes.push(
        buildPoolAccountRow(
          acct,
          ready.has(acct.number),
          cfg.rateLimitPct,
          cfg.makePrimaryButtons,
          rotationButtonFor(acct, cfg, outOfRotation),
          richSpend,
        ),
      );
    }
    if (pool.length > MAX_DETAILED_ACCOUNTS) {
      nodes.push({
        type: "text",
        props: { content: `+${pool.length - MAX_DETAILED_ACCOUNTS} more accounts` },
      });
    }
  }

  // ── Last spawn key-value ──────────────────────────────────────────────────
  nodes.push(...buildLastSpawnNodes(lastSpawn));

  // ── Last heal ─────────────────────────────────────────────────────────────
  nodes.push(...buildLastHealNodes(lastHeal));

  // ── Graphical section ─────────────────────────────────────────────────────
  const detailed = pool.slice(0, MAX_DETAILED_ACCOUNTS);

  nodes.push({ type: "text", props: { content: "Graphics", weight: "bold" } });

  for (const a of detailed) {
    nodes.push(buildGraphicsAccountNode(a, cfg.rateLimitPct, history, richSpend));
  }

  const fivePctFor = (a: PoolAccount) => a.fiveHourPct ?? 0;
  const toneFor = (pct: number) => (pct >= cfg.rateLimitPct ? "error" : "ok");
  const quotaPointsFor = (a: PoolAccount) =>
    downsample(
      history.quotaFor(a.number).map((s) => s.five ?? 0),
      CHART_WINDOW,
    );

  const seriesAccounts = detailed.filter((a) => !a.usageUnavailable);
  const hiddenCount = detailed.length - seriesAccounts.length;
  const timeSeriesCaption =
    hiddenCount > 0 ? `5h % (${hiddenCount} hidden: quota unknown)` : "5h %";
  nodes.push({
    type: "time-series",
    props: {
      series: seriesAccounts.map((a) => ({
        label: `#${a.number}`,
        tone: toneFor(fivePctFor(a)),
        points: quotaPointsFor(a),
      })),
      yMax: 100,
      kind: "line",
      caption: timeSeriesCaption,
    },
  });

  const assignmentCounts = new Map<number, number>();
  for (const n of Object.values(state.assignments)) {
    assignmentCounts.set(n, (assignmentCounts.get(n) ?? 0) + 1);
  }
  nodes.push({
    type: "bar-chart",
    props: {
      bars: detailed.map((a) => ({
        label: `#${a.number}`,
        value: assignmentCounts.get(a.number) ?? 0,
        tone: "neutral",
      })),
      orientation: "horizontal",
    },
  });

  nodes.push({
    type: "timeline",
    props: {
      events: history.recentSpawns().map((e) => ({
        at: e.at,
        label: `${e.sessionId} → #${e.accountNumber}`,
      })),
    },
  });

  // ── Error callouts ────────────────────────────────────────────────────────
  if (restoreFailure !== null) nodes.push(buildRestoreFailureCallout(restoreFailure));
  if (lastError !== null) {
    nodes.push({ type: "callout", props: { tone: "error", text: lastError } });
  }

  return {
    schemaVersion: 1,
    slot: "settings-panel",
    title: "claude-swap",
    root: {
      type: "stack",
      props: { direction: "vertical" },
      children: nodes,
    },
  };
}
