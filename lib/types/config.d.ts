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
import type { Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type SidebarPrefs } from './prefs-shared.ts';
export { SIDEBAR_PREFS_DEFAULTS, SIDEBAR_PREFS_NS, TERMINAL_FONT_SIZE_DEFAULT, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN, TITLE_BAR_STRIP_DEFAULT, TITLE_BAR_STRIP_MAX, TITLE_BAR_STRIP_MIN, type SidebarPrefs, } from './prefs-shared.ts';
/** Tunable sidebar host limits (every field optional; defaults fill in). */
export interface SidebarHostConfig {
    /** Read cap of one text file (bytes); larger files return truncated. */
    readLimit?: number;
    /** Media route cap (bytes); larger binaries are refused. */
    mediaLimit?: number;
    /** Upload route cap (bytes); larger files are refused without touching disk. */
    uploadLimit?: number;
    /** Explorer row bound of one level. */
    listLimit?: number;
    /** Terminals per session. */
    terminalsPerSession?: number;
    /** How long a disconnected terminal process survives awaiting a reconnect. */
    reconnectGraceMs?: number;
    /**
     * Terminal shell (absolute path or bare executable name) for BOTH the UI
     * terminal tabs and the model-facing `terminal_*` tools. Empty = auto:
     * POSIX follows `$SHELL` then the account login shell; Windows follows
     * `DSH_SIDEBAR_SHELL`, then probes for `pwsh.exe`, then falls back to the
     * inbox `powershell.exe` (5.1). Set it from `cordis.patch.yml` / profile
     * plugin config, e.g. `config: { shell: /bin/zsh }`.
     */
    shell?: string;
    /**
     * Optional arguments passed to the shell executable. When non-empty these
     * REPLACE the automatic platform defaults (POSIX `-l` / Windows none), so
     * the deployment has full control over how the shell starts. When omitted
     * the existing default behavior is kept.
     */
    shellArgs?: string[];
}
/** Plain plugin config: host tunables plus the plain preference values. */
export type SidebarConfig = SidebarHostConfig & Partial<SidebarPrefs>;
/**
 * Live references for the preference fields of the runtime Config. Each
 * reference may resolve undefined: the scheme/preset/CSS prefs have no schema
 * default so a stored document that predates them stays absent, and the client
 * parsePrefs (or {@link readPrefs}) applies the default.
 */
export type VolatilePrefs = {
    [K in keyof SidebarPrefs]: Volatile<SidebarPrefs[K] | undefined>;
};
/** The plugin Config the Loader hands to `apply()`: host tunables plus pref references. */
export type VolatileConfig = Required<SidebarHostConfig> & VolatilePrefs;
/** Fully defaulted sidebar host settings. */
export interface ResolvedSidebarConfig {
    readLimit: number;
    mediaLimit: number;
    uploadLimit: number;
    listLimit: number;
    terminalsPerSession: number;
    reconnectGraceMs: number;
    /** The configured terminal shell; empty means the host auto-resolves it. */
    shell: string;
    /** Explicit shell arguments; empty means use the platform defaults. */
    shellArgs: string[];
}
/**
 * Apply direct-call defaults after Loader schema validation has normally run.
 *
 * @param config - Deployment-provided sidebar host settings.
 * @returns Complete settings consumed by the host half.
 */
export declare function resolveSidebarConfig(config: SidebarHostConfig | undefined): ResolvedSidebarConfig;
/**
 * Read the current side-card preferences out of the runtime Config, falling
 * back to {@link SIDEBAR_PREFS_DEFAULTS} for fields the composition omits.
 * @param config - the Loader-provided Config (live prefs) or undefined.
 * @returns complete preferences.
 */
export declare function readPrefs(config: SidebarConfig | VolatileConfig | undefined): SidebarPrefs;
/** Schemastery schema for the user-facing preferences (validated by the settings service). */
export declare const PrefsSchema: z<SidebarPrefs>;
/**
 * Schemastery schema for the plugin configuration.
 *
 * The host tunables stay ordinary fields; the user-facing preferences are
 * repeated from {@link PrefsSchema} as `.volatile()` fields so DSH 0.1.7's
 * settings service exposes them as this plugin's editable form. Keep the
 * preference field list here in sync with {@link PrefsSchema}.
 */
export declare const Config: z<SidebarConfig, VolatileConfig>;
