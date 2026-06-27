import type { PluginUINode, PluginUIView } from "../types";
import type { ResolvedConfig } from "./config";
import type { PoolAccount } from "./accounts";
import type { SelectionState } from "./selection";
import type { LastSpawn } from "./status";

/** Build a `settings-panel` PluginUIView with the same data as buildStatus. */
export function buildUIView(
  cfg: ResolvedConfig,
  pool: PoolAccount[],
  ready: Set<number>,
  state: SelectionState,
  lastSpawn: LastSpawn | null,
  lastError: string | null,
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
    for (const acct of pool) {
      const isReady = ready.has(acct.number);
      let badge: PluginUINode;
      if (isReady) {
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
      const fiveCaption = acct.fiveHourPct !== null ? `${acct.fiveHourPct}%` : "n/a";
      const sevenCaption = acct.sevenDayPct !== null ? `${acct.sevenDayPct}%` : "n/a";
      const fiveTone = fivePct >= cfg.rateLimitPct ? "error" : "ok";
      const sevenTone = sevenPct >= cfg.rateLimitPct ? "error" : "ok";

      const acctStack: PluginUINode = {
        type: "stack",
        props: { direction: "vertical", gap: "sm" },
        children: [
          {
            type: "stack",
            props: { direction: "horizontal" },
            children: [
              { type: "text", props: { content: `#${acct.number} ${acct.email}` } },
              badge,
            ],
          },
          {
            type: "meter",
            props: { label: "5h", value: fivePct, max: 100, caption: fiveCaption, tone: fiveTone },
          },
          {
            type: "meter",
            props: {
              label: "7d",
              value: sevenPct,
              max: 100,
              caption: sevenCaption,
              tone: sevenTone,
            },
          },
        ],
      };
      nodes.push(acctStack);
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
