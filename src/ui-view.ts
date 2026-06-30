import type { PluginUINode, PluginUIView } from "../types";
import type { ResolvedConfig } from "./config";
import type { PoolAccount } from "./accounts";
import type { SelectionState } from "./selection";
import type { LastSpawn } from "./status";
import type { HealRecord, HealRestoreFailure } from "./prewarm";
import { History, downsample, CHART_WINDOW, MAX_DETAILED_ACCOUNTS } from "./history";

/** Neutral identity chip so every account row names its account even on a host that does not
 *  render plain `text` nodes (the bug this addresses: bars/rows with no account attribution). */
function identityBadge(number: number, email: string): PluginUINode {
  return { type: "badge", props: { label: `#${number} ${email}`, tone: "neutral" } };
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

/** Meters (5h + 7d) for an account with known quota, or the quota-unknown note. */
function buildAccountMeters(acct: PoolAccount, rateLimitPct: number): PluginUINode[] {
  if (acct.usageUnavailable) return [quotaUnknownNote(acct.active)];
  const fivePct = acct.fiveHourPct ?? 0;
  const sevenPct = acct.sevenDayPct ?? 0;
  const fiveCaption = quotaCaption(
    acct.fiveHourPct,
    acct.fiveHourResetClock,
    acct.fiveHourResetCountdown,
  );
  const sevenCaption = quotaCaption(
    acct.sevenDayPct,
    acct.sevenDayResetClock,
    acct.sevenDayResetCountdown,
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
        tone: sevenPct >= rateLimitPct ? "error" : "ok",
      },
    },
  ];
}

/** Build the flat pool row for one account: identity + status badge + meters or unknown note.
 *  When `showMakePrimary` is on (config flag) and the account is an eligible target, the header
 *  also carries a "Make primary" action-button. */
function buildPoolAccountRow(
  acct: PoolAccount,
  isReady: boolean,
  rateLimitPct: number,
  showMakePrimary: boolean,
): PluginUINode {
  const header: PluginUINode[] = [
    identityBadge(acct.number, acct.email),
    buildStatusBadge(acct, isReady),
  ];
  if (showMakePrimary && canMakePrimary(acct)) header.push(makePrimaryButton(acct));
  return {
    type: "stack",
    props: { direction: "vertical", gap: "sm" },
    children: [
      {
        type: "stack",
        props: { direction: "horizontal" },
        children: header,
      },
      ...buildAccountMeters(acct, rateLimitPct),
    ],
  };
}

/** Build the graphical section node for one account: gauges + sparkline, or unknown note. */
function buildGraphicsAccountNode(
  a: PoolAccount,
  rateLimitPct: number,
  history: History,
): PluginUINode {
  if (a.usageUnavailable) {
    return {
      type: "stack",
      props: { direction: "vertical" },
      children: [identityBadge(a.number, a.email), quotaUnknownNote(a.active)],
    };
  }
  const fp = a.fiveHourPct ?? 0;
  const sp = a.sevenDayPct ?? 0;
  const toneFor = (pct: number) => (pct >= rateLimitPct ? "error" : "ok");
  const fiveCaption = quotaCaption(a.fiveHourPct, a.fiveHourResetClock, a.fiveHourResetCountdown);
  const sevenCaption = quotaCaption(a.sevenDayPct, a.sevenDayResetClock, a.sevenDayResetCountdown);
  const points = downsample(
    history.quotaFor(a.number).map((s) => s.five ?? 0),
    CHART_WINDOW,
  );
  return {
    type: "stack",
    props: { direction: "vertical" },
    children: [
      identityBadge(a.number, a.email),
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
          tone: toneFor(sp),
          caption: sevenCaption,
        },
      },
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
        { key: "autoHeal", value: String(cfg.autoHeal) },
        { key: "autoHealAfterCycles", value: String(cfg.autoHealAfterCycles) },
      ],
    },
  });

  // ── Pool section ──────────────────────────────────────────────────────────
  nodes.push({ type: "text", props: { content: "Pool", weight: "bold" } });

  if (pool.length === 0) {
    nodes.push({ type: "text", props: { content: "No accounts" } });
  } else {
    const detailed = pool.slice(0, MAX_DETAILED_ACCOUNTS);
    for (const acct of detailed) {
      nodes.push(
        buildPoolAccountRow(acct, ready.has(acct.number), cfg.rateLimitPct, cfg.makePrimaryButtons),
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
    nodes.push(buildGraphicsAccountNode(a, cfg.rateLimitPct, history));
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
