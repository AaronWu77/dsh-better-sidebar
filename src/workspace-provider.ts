/** Host-only workspace providers for sidebar filesystem, Git and interactive terminals. */
import type { SidebarFsListing } from './fs-tree.ts'
import type { FsSearchResult } from './fs-search.ts'
import { GitCommandError, type GitBackend } from './git.ts'
import type { SidebarSessionScope } from './session-scope.ts'
import { SidebarError, type SidebarErrorCode } from './wire.ts'

/** Filesystem spelling owned by the selected execution host. */
export interface SidebarWorkspacePaths {
  /** Validate and normalize a target on this host, without changing hosts. */
  absolute(path: string): string
  /** Join a target onto a directory using this host's separators. */
  join(base: string, path: string): string
  /** Return the directory containing a target. */
  dirname(path: string): string
  /** Return a target's final filename. */
  basename(path: string): string
  /** Identify an absolute spelling accepted by this host. */
  isAbsolute(path: string): boolean
}

/** Existing editor response fields, including bounded binary sniffing. */
export interface SidebarFileRead {
  content: string
  truncated: boolean
  binary: boolean
  size: number
  head?: string
}

/** Bounded upload belonging to one already-selected execution host. */
export interface SidebarProviderUpload {
  dir: string
  relativePath: string
  chunks: AsyncIterable<string | Uint8Array>
  limit: number
  fence: boolean
}

/** Workspace operations keep host selection fixed even when the containment fence is disabled. */
export interface SidebarWorkspaceFiles {
  /** Resolve and check an existing target; errors must not select a local filesystem. */
  resolve(path: string, fence: boolean): Promise<string>
  /** Whether a target exists; only an authoritative missing-file result returns false. */
  exists(path: string): Promise<boolean>
  /** List one level with bounded rows and lexical symlink paths. */
  list(path: string, limit: number, fence: boolean): Promise<SidebarFsListing>
  /** Read a bounded editor preview with byte-safe UTF-8 decoding. */
  read(path: string, limit: number, fence: boolean): Promise<SidebarFileRead>
  /** Read complete bytes only when the file fits the supplied bound. */
  readBytes(path: string, limit: number, fence: boolean): Promise<Uint8Array>
  /** Publish complete text; failure is caller-visible and never retried on another host. */
  write(path: string, content: string, fence: boolean): Promise<void>
  /** Upload owned temporary content before publishing its target. */
  upload(input: SidebarProviderUpload): Promise<{ path: string; size: number }>
  /** Rename a lexical row, refusing root rename and replacement of an existing destination. */
  rename(path: string, name: string, fence: boolean): Promise<{ path: string }>
  /** Remove a lexical row without following a directory symlink. */
  remove(path: string, fence: boolean): Promise<{ path: string }>
  /** Search names under the selected session root; return relative '/' paths and partial results when a work budget is reached.
   * @param query Case-insensitive filename substring; blank queries return no matches.
   * @param signal Stop subsequent traversal on cancellation; settlement awaits in-flight work.
   * @returns Sorted Session-root-relative '/' paths and whether the scan reached a limit.
   */
  search(query: string, signal?: AbortSignal): Promise<FsSearchResult>
}

/** Interactive backend lifetime is independent of a browser socket attachment. */
export interface SidebarBackendTerminal {
  readonly output: AsyncIterable<Uint8Array>
  readonly done: Promise<{ exitCode: number | null; signal?: string | null }>
  readonly quiescent: Promise<void>
  /** Dispatch input at most once; uncertain dispatch is a visible failure, not a replay request. */
  write(data: string): Promise<void>
  /** Apply geometry to the same backend terminal. */
  resize(cols: number, rows: number): Promise<void>
  /** Request termination and await owned process and subscription cleanup. */
  terminate(): Promise<void>
}

/** Terminal allocation parameters, resolved by the selected remote provider. */
export interface SidebarBackendTerminalSpec {
  cwd: string
  cols: number
  rows: number
  signal?: AbortSignal
}

/** A remote workspace selected from an authoritative Session header.
 * Routers preserve object identity for the same host/route/cwd and replace it when host selection changes.
 */
export interface SidebarRemoteWorkspace {
  readonly kind: 'remote'
  readonly cwd: string
  /** Configured remote shell executable; metadata never comes from the local host shell. */
  readonly terminalExecutable: string
  readonly paths: SidebarWorkspacePaths
  readonly fs: SidebarWorkspaceFiles
  readonly git: GitBackend
  /** Allocate a terminal on this exact host, with its remote interactive shell. */
  createTerminal(spec: SidebarBackendTerminalSpec): Promise<SidebarBackendTerminal>
}

/** Local routing must be a positive router result, not an interpretation of a remote failure. */
export type SidebarWorkspaceRoute = { readonly kind: 'local'; readonly cwd: string } | SidebarRemoteWorkspace

/** Router registered by an independently loaded remote workspace plugin. */
export type SidebarWorkspaceRouter = (scope: SidebarSessionScope) => Promise<SidebarWorkspaceRoute>

/** Provider contributions are removed by their owning plugin's registration effect. */
export class SidebarWorkspaceProviders {
  private router: SidebarWorkspaceRouter | undefined
  private routerRequired: boolean

  /** Create the resolver with an observation of whether a remote manager is configured.
   * @param remoteConfigured Whether a remote manager requires a matching router contribution.
   */
  constructor(private readonly remoteConfigured: () => boolean) { this.routerRequired = remoteConfigured() }

  /** Preserve remote-required routing across manager/bridge unload; only a router can select local. */
  requireRouter(): void { this.routerRequired = true }

  /** Construct a sidebar HTTP failure without a remote plugin importing sidebar runtime code.
   * @param code Machine-readable failure owned by the sidebar protocol.
   * @param message Caller-visible diagnostic.
   * @param status HTTP failure status.
   * @returns An error recognized by sidebar route handlers.
   */
  workspaceError(code: SidebarErrorCode, message: string, status: number): SidebarError {
    return new SidebarError(code, message, status)
  }

  /** Construct a completed Git diagnostic for backend-specific execution.
   * @param message Complete stderr diagnostic, never a fabricated transport result.
   * @param command Fixed argv command description.
   * @param exitCode Completed process exit status.
   * @returns A Git diagnostic recognized by repository discovery and compatibility checks.
   */
  gitCommandError(message: string, command: string, exitCode?: number): GitCommandError {
    return new GitCommandError(message, 'git-error', command, exitCode)
  }

  /** Register the single execution-world router used by current sidebar consumers.
   * @param router Router that returns explicit local/remote selection or rejects.
   * @returns Idempotent removal of this contribution only.
   */
  registerRouter(router: SidebarWorkspaceRouter): () => void {
    if (this.router !== undefined) throw new Error('Sidebar workspace router is already registered')
    this.routerRequired = true
    this.router = router
    return () => { if (this.router === router) this.router = undefined }
  }

  /** Resolve an authoritative session on a fixed host, refusing missing remote integration.
   * @param scope Live or persisted session scope, never browser-supplied cwd.
   * @returns Explicit local selection or a scoped remote provider.
   */
  resolve(scope: SidebarSessionScope): Promise<SidebarWorkspaceRoute> {
    if (this.router !== undefined) return this.router(scope)
    this.routerRequired ||= this.remoteConfigured()
    if (this.routerRequired) return Promise.reject(new SidebarError('workspace-unavailable', 'Remote sidebar workspace provider is unavailable', 503))
    return Promise.resolve({ kind: 'local', cwd: scope.cwd })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-only sidebar execution-world resolver, provided by Better Sidebar. */
    sidebarWorkspaceProviders: SidebarWorkspaceProviders
  }
}
