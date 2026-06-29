// ─────────────────────────────────────────────────────────────────────────────
// VENDORED from Shepherd — github.com/erwins-enkel/shepherd
//   path:    src/plugins/types.ts
//   commit:  1f21237d04473caf37e6f832d6cdde9f970883ee
//   license: Apache-2.0 (see NOTICE). Redistributed with attribution; the
//            upstream plugin docs explicitly endorse vendoring this contract.
// Do not edit by hand — re-vendor from the pinned commit to update. The plugin
// imports the PluginContext/SpawnPatch types from here (erased at runtime).
//
// LOCAL DEVIATIONS (do not revert on re-vendor):
//   • SpawnDescriptor.kind / parentSessionId — synced from shepherd#1205
//     (commit 4d48948b); made optional here for back-compat with pre-#1205 hosts
//     (consistent with publishUI?/publishGearItem? optionality). Rest unchanged.
// ─────────────────────────────────────────────────────────────────────────────

// Public plugin contract for Shepherd's server-side, in-process plugin system
// (issue #1124). This module is the SOLE versioned seam between a plugin and core:
// plugins access core ONLY through the `PluginContext` (`ctx`) passed to `register`,
// never by importing core modules. Keeping every plugin call site behind `ctx` lets a
// future core swap the implementation (curated / permission-scoped / out-of-process)
// without touching plugin code. This file deliberately has NO imports so both the
// loader and the spawn path can depend on it cheaply.

/** The single versioned plugin API version. A plugin whose manifest `apiVersion`
 *  differs is skipped at load (logged + surfaced in the status panel). */
export const PLUGIN_API_VERSION = 1;

/** Plugin manifest (`plugin.json`). `capabilities[]` is declared intent — UNENFORCED
 *  in v1 (the hook a permission model bolts onto later), advisory/documentation only. */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  capabilities?: string[];
  /** Soft off-switch: `false` skips the plugin at load without removing the folder. */
  enabled?: boolean;
}

/** Read-only snapshot of how an agent is about to launch, handed to an `onSpawn` hook.
 *  A COPY — mutating it does nothing; return a `SpawnPatch` to influence the spawn. */
export interface SpawnDescriptor {
  sessionId: string;
  /** What kind of spawn this is (issue #1205). "session" is a normal task session
   *  (create/drain/resume); the others are the reviewer-style auto-process spawns that
   *  also fire onSpawn so a plugin can route their quota. */
  kind?: "session" | "review" | "plan-gate" | "doc";
  /** For an aux spawn tied to a managed session (review, plan-gate): that session's id,
   *  so a plugin can keep the aux spawn on the parent session's account. Undefined for a
   *  normal session (it IS the parent) and for session-less aux spawns (doc-agent,
   *  standalone critic). */
  parentSessionId?: string;
  repoRoot: string;
  model: string | null;
  agentProvider: string;
  /** The inner agent argv (e.g. `["claude", …]`) at hook time. Read-only copy. */
  argv: readonly string[];
  /** ADVISORY: the explicit env overlay Shepherd will set ON TOP OF the inherited
   *  process environment — NOT the full environment the agent ultimately sees. Under
   *  the `trusted` profile the agent additionally inherits Shepherd's parent env (the
   *  sandbox passthrough vars are only set explicitly when a membrane wraps the spawn). */
  env: Readonly<Record<string, string>>;
  isolated: boolean;
}

/** The bounded mutation a plugin may apply to a spawn. CANNOT rewrite core argv (the
 *  structural flags that make Shepherd's spawn work) — the bound IS the permission
 *  boundary a marketplace later scopes per-field.
 *
 *  NOTE: a `model` override is DELIBERATELY DEFERRED in v1 (issue #1124 lists it, but
 *  overriding model would diverge the stored `session.model` from the actually-spawned
 *  model and break cost replay — the same invariant the fable-availability guard
 *  protects; no v1 plugin needs it). It stays a documented future field. */
export interface SpawnPatch {
  /** Shallow-merged into the spawn env, LAST — so it wins over Shepherd's defaults,
   *  including the api-key-mode credential-less mirror's `CLAUDE_CONFIG_DIR`. */
  env?: Record<string, string>;
  /** Appended to the inner agent argv. */
  extraArgs?: string[];
  /** Convenience for `env.CLAUDE_CONFIG_DIR`; overrides it when both are set. */
  credentialDir?: string;
}

export type SpawnHook = (d: SpawnDescriptor) => SpawnPatch | void | Promise<SpawnPatch | void>;

/** Core-derived, UNSPOOFABLE plugin health (a plugin cannot set its own). */
export type PluginHealth = "ok" | "errored" | "timed-out";

/** Durable, scoped per-plugin key/value. Values are JSON-serializable. */
export interface PluginState {
  get<T = unknown>(key: string): T | null;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  keys(): string[];
}

export interface PluginLogger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export type PluginRouteHandler = (req: Request) => Response | Promise<Response>;

/** The SOLE seam between a plugin and core. */
export interface PluginContext {
  /** This plugin's manifest (frozen copy). */
  manifest: Readonly<PluginManifest>;
  /** Register a spawn hook (mutate how agents launch). Load-bearing capability. */
  onSpawn(fn: SpawnHook): void;
  /** Read-only core event stream (`session:hold`, `session:status`, …). Plugins
   *  observe; they cannot emit core events. Returns an unsubscribe fn. */
  events: { subscribe(fn: (event: string, data: unknown) => void): () => void };
  /** Push a small free-form JSON blob to the status panel (rendered verbatim). */
  publishStatus(status: unknown): void;
  /** Push a declarative UI view (issue #1185); optional — host may be older. */
  publishUI?(view: PluginUIView | null): void;
  /** Push (or replace) this plugin's single gear-menu item; `null` clears it.
   *  Additive — plugins guard with `typeof ctx.publishGearItem === "function"`. */
  publishGearItem?(item: PluginGearItem | null): void;
  /** Durable, scoped per-plugin key/value (backed by the `plugin_state` table). */
  state: PluginState;
  /** Register an HTTP route under the fixed `/api/plugins/<id>/<path>` namespace. */
  route(method: string, path: string, handler: PluginRouteHandler): void;
  /** Namespaced logger into `shepherd.log`. */
  log: PluginLogger;
  /** This plugin's own `config.json` (parsed; `{}` when absent). */
  config: Record<string, unknown>;
  /** Hard-block the in-flight spawn (opt out of the default fail-open). Throws. */
  abortSpawn(reason: string): never;
}

// ── Declarative UI descriptor (issue #1185) — mirrors shepherd src/plugins/types.ts ──
/** A node in the declarative UI tree rendered by the Shepherd host. */
export interface PluginUINode {
  type: string;
  props?: Record<string, unknown>;
  children?: PluginUINode[];
}
/** Declarative UI view pushed via `publishUI`; host renders from its component registry. */
export interface PluginUIView {
  schemaVersion: 1;
  slot: "settings-panel" | "session-sidebar" | "dashboard-card";
  title?: string;
  root: PluginUINode;
}

// ── Gear-menu item (shepherd#1202) — mirrors shepherd src/plugins/types.ts ──
/** A declarative action a plugin's gear-menu item performs on click. Discriminated by `kind`.
 *  All fields JSON-serializable; strings are verbatim plugin-authored DATA, never i18n keys. */
export type PluginGearAction =
  | { kind: "route"; method: "GET" | "POST"; path: string }
  | { kind: "url"; href: string }
  | { kind: "panel" };

/** One gear-menu item a plugin contributes via `ctx.publishGearItem` (shepherd#1202).
 *  At most ONE per plugin; latest publish wins; `null` clears it. */
export interface PluginGearItem {
  /** Verbatim plugin-authored label (NOT an i18n key). */
  label: string;
  /** Optional single glyph/emoji icon (verbatim). */
  icon?: string;
  action: PluginGearAction;
}

/** Plugin entry contract: the entry module exports `register`, called ONCE at boot
 *  after core services exist. May return an optional teardown fn for clean shutdown. */
export type PluginRegister = (
  ctx: PluginContext,
) => void | (() => void) | Promise<void | (() => void)>;

/** Thrown by `ctx.abortSpawn`; caught in the spawn path. A plugin-refused **New-Task
 *  create** is parked in the `held_tasks` queue (reason `'capacity'`) and retried when
 *  the sweeper next fires — the task is not lost. A plugin-refused **resume** still
 *  returns null (caller skips / 409) rather than escaping as an unhandled throw. */
export class PluginSpawnAborted extends Error {
  constructor(
    public readonly reason: string,
    public readonly pluginId: string,
  ) {
    super(reason);
    this.name = "PluginSpawnAborted";
  }
}

/** Panel/list view of a loaded plugin — core-derived health is authoritative. */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  health: PluginHealth;
  /** Last error message (load or hook), or null. */
  lastError: string | null;
  /** Last `publishStatus` blob (verbatim plugin-authored JSON), or null. */
  status: unknown;
}
