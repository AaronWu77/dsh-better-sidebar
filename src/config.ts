/**
 * Serializable configuration and defaults for the sidebar host half. Loader
 * schema validation normally fills defaults; {@link resolveSidebarConfig}
 * applies the same defaults for direct callers that bypass the Loader.
 *
 * DSH 0.1.7 derives a plugin's settings namespace from the volatile fields of
 * its Config schema, so the user-facing preferences declared in
 * {@link PrefsSchema} are also live (`.volatile()`) fields of {@link Config}:
 * the settings service serves and edits them, and {@link readPrefs} reads the
 * current values (with schema defaults) out of the runtime Config.
 * @module dsh-better-sidebar/config
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  SIDEBAR_PREFS_DEFAULTS,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TITLE_BAR_STRIP_DEFAULT,
  TITLE_BAR_STRIP_MAX,
  TITLE_BAR_STRIP_MIN,
  type SidebarPrefs,
} from './prefs-shared.ts'

export {
  SIDEBAR_PREFS_DEFAULTS,
  SIDEBAR_PREFS_NS,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TITLE_BAR_STRIP_DEFAULT,
  TITLE_BAR_STRIP_MAX,
  TITLE_BAR_STRIP_MIN,
  type SidebarPrefs,
} from './prefs-shared.ts'

/** Tunable sidebar host limits (every field optional; defaults fill in). */
export interface SidebarHostConfig {
  /** Read cap of one text file (bytes); larger files return truncated. */
  readLimit?: number
  /** Media route cap (bytes); larger binaries are refused. */
  mediaLimit?: number
  /** Upload route cap (bytes); larger files are refused without touching disk. */
  uploadLimit?: number
  /** Explorer row bound of one level. */
  listLimit?: number
  /** Terminals per session. */
  terminalsPerSession?: number
  /** How long a disconnected terminal process survives awaiting a reconnect. */
  reconnectGraceMs?: number
  /**
   * Terminal shell (absolute path or bare executable name) for BOTH the UI
   * terminal tabs and the model-facing `terminal_*` tools. Empty = auto:
   * POSIX follows `$SHELL` then the account login shell; Windows follows
   * `DSH_SIDEBAR_SHELL`, then probes for `pwsh.exe`, then falls back to the
   * inbox `powershell.exe` (5.1). Set it from `cordis.patch.yml` / profile
   * plugin config, e.g. `config: { shell: /bin/zsh }`.
   */
  shell?: string
  /**
   * Optional arguments passed to the shell executable. When non-empty these
   * REPLACE the automatic platform defaults (POSIX `-l` / Windows none), so
   * the deployment has full control over how the shell starts. When omitted
   * the existing default behavior is kept.
   */
  shellArgs?: string[]
}

/** Plain plugin config: host tunables plus the plain preference values. */
export type SidebarConfig = SidebarHostConfig & Partial<SidebarPrefs>

/**
 * Live references for the preference fields of the runtime Config. Each
 * reference may resolve undefined: the scheme/preset/CSS prefs have no schema
 * default so a stored document that predates them stays absent, and the client
 * parsePrefs (or {@link readPrefs}) applies the default.
 */
export type VolatilePrefs = { [K in keyof SidebarPrefs]: Volatile<SidebarPrefs[K] | undefined> }

/** The plugin Config the Loader hands to `apply()`: host tunables plus pref references. */
export type VolatileConfig = Required<SidebarHostConfig> & VolatilePrefs

/** Fully defaulted sidebar host settings. */
export interface ResolvedSidebarConfig {
  readLimit: number
  mediaLimit: number
  uploadLimit: number
  listLimit: number
  terminalsPerSession: number
  reconnectGraceMs: number
  /** The configured terminal shell; empty means the host auto-resolves it. */
  shell: string
  /** Explicit shell arguments; empty means use the platform defaults. */
  shellArgs: string[]
}

/**
 * Apply direct-call defaults after Loader schema validation has normally run.
 *
 * @param config - Deployment-provided sidebar host settings.
 * @returns Complete settings consumed by the host half.
 */
export function resolveSidebarConfig(config: SidebarHostConfig | undefined): ResolvedSidebarConfig {
  return {
    readLimit: config?.readLimit ?? 512 * 1024,
    mediaLimit: config?.mediaLimit ?? 20 * 1024 * 1024,
    uploadLimit: config?.uploadLimit ?? 128 * 1024 * 1024,
    listLimit: config?.listLimit ?? 1000,
    terminalsPerSession: config?.terminalsPerSession ?? 3,
    reconnectGraceMs: config?.reconnectGraceMs ?? 30_000,
    shell: config?.shell?.trim() ?? '',
    shellArgs: config?.shellArgs ?? [],
  }
}

/** Read the current value behind one live Config reference, plain values unchanged. */
function configValue<T>(value: T | Volatile<T> | undefined): T | undefined {
  return value !== null && typeof value === 'object' && 'get' in value
    ? (value as { get(): T | undefined }).get()
    : value as T | undefined
}

/**
 * Read the current side-card preferences out of the runtime Config, falling
 * back to {@link SIDEBAR_PREFS_DEFAULTS} for fields the composition omits.
 * @param config - the Loader-provided Config (live prefs) or undefined.
 * @returns complete preferences.
 */
export function readPrefs(config: SidebarConfig | VolatileConfig | undefined): SidebarPrefs {
  const source = config as Record<string, unknown> | undefined
  const prefs: Record<string, unknown> = { ...SIDEBAR_PREFS_DEFAULTS }
  for (const key of Object.keys(prefs)) {
    const value = configValue<unknown>(source?.[key])
    if (value !== undefined) prefs[key] = value
  }
  return prefs as unknown as SidebarPrefs
}

// ── User-facing "Side card" preferences ─────────────────────────────────────

/** Schemastery schema for the user-facing preferences (validated by the settings service). */
export const PrefsSchema: z<SidebarPrefs> = z.object({
  autoOpenSubagent: z.boolean().default(true),
  autoOpenJobs: z.boolean().default(true),
  agentTerminalTools: z.boolean().default(false),
  agentOpenTools: z.boolean().default(false),
  bottomPanelAutoTerminal: z.boolean().default(true),
  terminalFontFamily: z.string().default(''),
  terminalFontSize: z.number().step(1).min(TERMINAL_FONT_SIZE_MIN).max(TERMINAL_FONT_SIZE_MAX).default(TERMINAL_FONT_SIZE_DEFAULT),
  editorExplorer: z.boolean().default(false),
  workspaceFence: z.boolean().default(true),
  terminalShell: z.string().default(''),
  terminalShellArgs: z.string().default(''),
  titleBarScheme: z.union([z.const('auto'), z.const('web'), z.const('preset'), z.const('custom')]),
  titleBarPresetId: z.string(),
  customCss: z.string(),
  titleBarCompat: z.boolean().default(false),
  titleBarStripPx: z.number().step(1).min(TITLE_BAR_STRIP_MIN).max(TITLE_BAR_STRIP_MAX).default(TITLE_BAR_STRIP_DEFAULT),
  htmlViewerNoSandbox: z.boolean().default(false),
  htmlViewerDefaultUnsafe: z.boolean().default(false),
  browserNoSandbox: z.boolean().default(false),
  browserInterceptLinks: z.boolean().default(true),
  browserInterceptHttp: z.boolean().default(true),
  browserInterceptHttps: z.boolean().default(false),
  browserAllowedLoopback: z.string().default(''),
  // Per-feature enable switches are OPEN maps (any tab/viewer id, built-in or
  // external): an absent key means enabled, so old documents resolve to {}
  // (everything on) with no migration. Non-boolean values fail validation.
  tabsEnabled: z.dict(z.boolean()).default({}),
  viewersEnabled: z.dict(z.boolean()).default({}),
  // Plugin-owned settings blobs (v0.12.0+) are an OPEN nested map: any
  // descriptor id may carry any JSON-serializable values. This is the
  // "settings seam" opening — without it the seam would drop third-party
  // keys as unknown schema fields.
  pluginSettings: z.dict(z.dict(z.any())).default({}),
})

/**
 * Schemastery schema for the plugin configuration.
 *
 * The host tunables stay ordinary fields; the user-facing preferences are
 * repeated from {@link PrefsSchema} as `.volatile()` fields so DSH 0.1.7's
 * settings service exposes them as this plugin's editable form. Keep the
 * preference field list here in sync with {@link PrefsSchema}.
 */
export const Config: z<SidebarConfig, VolatileConfig> = z.object({
  readLimit: z.number().step(1).min(1).default(512 * 1024),
  mediaLimit: z.number().step(1).min(1).default(20 * 1024 * 1024),
  uploadLimit: z.number().step(1).min(1).default(128 * 1024 * 1024),
  listLimit: z.number().step(1).min(1).default(1000),
  terminalsPerSession: z.number().step(1).min(1).default(3),
  reconnectGraceMs: z.number().step(1).min(0).default(30_000),
  shell: z.string().default(''),
  shellArgs: z.array(z.string()).default([]),
  autoOpenSubagent: z.boolean().default(true).volatile(),
  autoOpenJobs: z.boolean().default(true).volatile(),
  agentTerminalTools: z.boolean().default(false).volatile(),
  agentOpenTools: z.boolean().default(false).volatile(),
  bottomPanelAutoTerminal: z.boolean().default(true).volatile(),
  terminalFontFamily: z.string().default('').volatile(),
  terminalFontSize: z.number().step(1).min(TERMINAL_FONT_SIZE_MIN).max(TERMINAL_FONT_SIZE_MAX).default(TERMINAL_FONT_SIZE_DEFAULT).volatile(),
  editorExplorer: z.boolean().default(false).volatile(),
  workspaceFence: z.boolean().default(true).volatile(),
  terminalShell: z.string().default('').volatile(),
  terminalShellArgs: z.string().default('').volatile(),
  titleBarScheme: z.union([z.const('auto'), z.const('web'), z.const('preset'), z.const('custom')]).volatile(),
  titleBarPresetId: z.string().volatile(),
  customCss: z.string().volatile(),
  titleBarCompat: z.boolean().default(false).volatile(),
  titleBarStripPx: z.number().step(1).min(TITLE_BAR_STRIP_MIN).max(TITLE_BAR_STRIP_MAX).default(TITLE_BAR_STRIP_DEFAULT).volatile(),
  htmlViewerNoSandbox: z.boolean().default(false).volatile(),
  htmlViewerDefaultUnsafe: z.boolean().default(false).volatile(),
  browserNoSandbox: z.boolean().default(false).volatile(),
  browserInterceptLinks: z.boolean().default(true).volatile(),
  browserInterceptHttp: z.boolean().default(true).volatile(),
  browserInterceptHttps: z.boolean().default(false).volatile(),
  browserAllowedLoopback: z.string().default('').volatile(),
  tabsEnabled: z.dict(z.boolean()).default({}).volatile(),
  viewersEnabled: z.dict(z.boolean()).default({}).volatile(),
  pluginSettings: z.dict(z.dict(z.any())).default({}).volatile(),
})
