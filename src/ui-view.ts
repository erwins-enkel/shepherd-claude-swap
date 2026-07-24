import type { PluginUINode, PluginUIView } from "../types";
import type { ResolvedConfig } from "./config";
import type { PoolAccount } from "./accounts";
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
 *  hint that `cswap enable <n>` is the lever. This label renders unconditionally on every row, in
 *  both the flat and graphical sections, and costs no extra node. */
function identityBadge(acct: PoolAccount): PluginUINode {
  const label = `#${acct.number} ${acct.email}${acct.cswapDisabled ? " · cswap-disabled" : ""}`;
  return { type: "badge", props: { label, tone: "neutral" } };
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
    ...acct.scopedWindows.map((w): PluginUINode => ({
      type: "meter",
      props: {
        label: `#${acct.number} · ${w.name} wk`,
        value: w.pct,
        max: 100,
        caption: quotaCaption(w.pct, w.resetClock, w.resetCountdown),
        tone: w.pct >= rateLimitPct ? "error" : "ok",
      },
    })),
  ];
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
): PluginUINode {
  const header: PluginUINode[] = [identityBadge(acct), buildStatusBadge(acct, isReady)];
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
      ...buildAccountMeters(acct, rateLimitPct),
    ],
  };
}

/** Build the graphical section node for one account: gauges (5h + 7d + one per scoped weekly
 *  window, e.g. Fable) + sparkline, or unknown note. */
function buildGraphicsAccountNode(
  a: PoolAccount,
  rateLimitPct: number,
  history: History,
): PluginUINode {
  if (a.usageUnavailable) {
    return {
      type: "stack",
      props: { direction: "vertical" },
      children: [identityBadge(a), quotaUnknownNote(a.active)],
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
      identityBadge(a),
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
      ...a.scopedWindows.map((w): PluginUINode => ({
        type: "gauge",
        props: {
          label: `#${a.number} · ${w.name} wk`,
          value: w.pct,
          max: 100,
          tone: toneFor(w.pct),
          caption: quotaCaption(w.pct, w.resetClock, w.resetCountdown),
        },
      })),
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
