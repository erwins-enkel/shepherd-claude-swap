import type { PluginUINode, PluginUIView } from "../types";
import type { ResolvedConfig } from "./config";
import type { PoolAccount } from "./accounts";
import type { SelectionState } from "./selection";
import type { LastSpawn } from "./status";
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

/** Build a `settings-panel` PluginUIView with the same data as buildStatus. */
export function buildUIView(
  cfg: ResolvedConfig,
  pool: PoolAccount[],
  ready: Set<number>,
  state: SelectionState,
  lastSpawn: LastSpawn | null,
  lastError: string | null,
  history: History = new History(),
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
      const isReady = ready.has(acct.number);
      let badge: PluginUINode;
      if (acct.usageUnavailable) {
        badge = { type: "badge", props: { label: "quota unknown", tone: "warn" } };
      } else if (isReady) {
        badge = { type: "badge", props: { label: "ready", tone: "ok" } };
      } else if (acct.rateLimited) {
        badge = { type: "badge", props: { label: "rate-limited", tone: "error" } };
      } else if (acct.usable) {
        badge = { type: "badge", props: { label: "warming", tone: "warn" } };
      } else {
        badge = { type: "badge", props: { label: acct.reason ?? "unusable", tone: "neutral" } };
      }

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
      const fiveTone = fivePct >= cfg.rateLimitPct ? "error" : "ok";
      const sevenTone = sevenPct >= cfg.rateLimitPct ? "error" : "ok";

      const meterOrUnknown: PluginUINode[] = acct.usageUnavailable
        ? [
            {
              type: "text",
              props: { content: "quota unknown — deprioritized; re-checked next refresh" },
            },
          ]
        : [
            {
              type: "meter",
              props: {
                label: `#${acct.number} · 5h`,
                value: fivePct,
                max: 100,
                caption: fiveCaption,
                tone: fiveTone,
              },
            },
            {
              type: "meter",
              props: {
                label: `#${acct.number} · 7d`,
                value: sevenPct,
                max: 100,
                caption: sevenCaption,
                tone: sevenTone,
              },
            },
          ];

      const acctStack: PluginUINode = {
        type: "stack",
        props: { direction: "vertical", gap: "sm" },
        children: [
          {
            type: "stack",
            props: { direction: "horizontal" },
            children: [identityBadge(acct.number, acct.email), badge],
          },
          ...meterOrUnknown,
        ],
      };
      nodes.push(acctStack);
    }
    if (pool.length > MAX_DETAILED_ACCOUNTS) {
      nodes.push({
        type: "text",
        props: { content: `+${pool.length - MAX_DETAILED_ACCOUNTS} more accounts` },
      });
    }
  }

  // ── Assignments table ─────────────────────────────────────────────────────
  nodes.push({ type: "text", props: { content: "Assignments", weight: "bold" } });

  const assignEntries = Object.entries(state.assignments);
  if (assignEntries.length === 0) {
    nodes.push({
      type: "table",
      props: {
        columns: ["Session", "Account"],
        rows: [],
      },
    });
  } else {
    nodes.push({
      type: "table",
      props: {
        columns: ["Session", "Account"],
        rows: assignEntries.map(([sid, n]) => [sid, `#${n}`]),
      },
    });
  }

  // ── Last spawn key-value ──────────────────────────────────────────────────
  if (lastSpawn !== null) {
    nodes.push({
      type: "key-value",
      props: {
        pairs: [
          { key: "session", value: lastSpawn.sessionId },
          { key: "account", value: `#${lastSpawn.accountNumber}` },
          { key: "at", value: lastSpawn.at },
        ],
      },
    });
  } else {
    nodes.push({ type: "text", props: { content: "No spawns yet" } });
  }

  // ── Graphical section ─────────────────────────────────────────────────────
  const detailed = pool.slice(0, MAX_DETAILED_ACCOUNTS);

  const fivePctFor = (a: PoolAccount) => a.fiveHourPct ?? 0;
  const sevenPctFor = (a: PoolAccount) => a.sevenDayPct ?? 0;
  const fiveCaptionFor = (a: PoolAccount) =>
    quotaCaption(a.fiveHourPct, a.fiveHourResetClock, a.fiveHourResetCountdown);
  const sevenCaptionFor = (a: PoolAccount) =>
    quotaCaption(a.sevenDayPct, a.sevenDayResetClock, a.sevenDayResetCountdown);
  const toneFor = (pct: number) => (pct >= cfg.rateLimitPct ? "error" : "ok");
  const quotaPointsFor = (a: PoolAccount) =>
    downsample(
      history.quotaFor(a.number).map((s) => s.five ?? 0),
      CHART_WINDOW,
    );

  nodes.push({ type: "text", props: { content: "Graphics", weight: "bold" } });

  for (const a of detailed) {
    if (a.usageUnavailable) {
      nodes.push({
        type: "stack",
        props: { direction: "vertical" },
        children: [
          identityBadge(a.number, a.email),
          {
            type: "text",
            props: { content: "quota unknown — deprioritized; re-checked next refresh" },
          },
        ],
      });
    } else {
      const fp = fivePctFor(a);
      const sp = sevenPctFor(a);
      nodes.push({
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
              caption: fiveCaptionFor(a),
            },
          },
          {
            type: "gauge",
            props: {
              label: `#${a.number} · 7d`,
              value: sp,
              max: 100,
              tone: toneFor(sp),
              caption: sevenCaptionFor(a),
            },
          },
          {
            type: "sparkline",
            props: {
              label: `#${a.number} · 5h trend`,
              points: quotaPointsFor(a),
              tone: toneFor(fp),
            },
          },
        ],
      });
    }
  }

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

  // ── Error callout ─────────────────────────────────────────────────────────
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
