/**
 * dsh-better-sidebar host half: the /sidebar JSON API (explorer listing, file
 * read/write, git), the /sidebar/file media route (images), the /sidebar/html
 * preview route, the /sidebar/bundle lazy-chunk route (client code splits),
 * and the terminal WebSocket upgrade. Every route passes the same
 * authenticated browser admission as the /api gateway. Connection owns
 * Host/Origin validation and login cookies; every request and WebSocket
 * handshake is checked before session access or resource allocation.
 *
 * All operations are conversation-scoped: requests carry a sessionId, the
 * session's authoritative cwd comes from the session store, and terminal
 * processes are keyed by session.
 */
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { Context, SidebarHttpRequest, SidebarSessionEvent } from './context-types.ts'
import {
  Config,
  readPrefs,
  resolveSidebarConfig,
  SIDEBAR_PREFS_DEFAULTS,
  SIDEBAR_PREFS_NS,
  type ResolvedSidebarConfig,
  type SidebarConfig,
  type SidebarPrefs,
  type VolatileConfig,
} from './config.ts'
import { parentOf, requireAbsolute, listDirectory, rootLabel } from './fs-tree.ts'
import { resolveSessionPath } from './session-path.ts'
import { renameWorkspaceEntry, removeWorkspaceEntry, writeWorkspaceUpload } from './fs-operations.ts'
import { ensureWorkspacePath, ensureWorkspaceWritePath, resolveWorkspaceTarget } from './path-security.ts'
import { searchFiles } from './fs-search.ts'
import { observeSearchRequest } from './search-request.ts'
import { decodeHtmlUrl } from './html-route.ts'
import { extractFrameAncestors } from './browser-probe.ts'
import { isLoopbackHostname } from './trust-fence.ts'
import { browserAdmission, rejectSidebarHttp, rejectSidebarUpgrade } from './authentication.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { resolveSidebarSessionScope } from './session-scope.ts'
import { SidebarWorkspaceProviders, type SidebarWorkspaceRoute } from './workspace-provider.ts'
import type { GitBackend, GitClient } from './git.ts'
import { registerBundleRoute } from './bundle-route.ts'
import { launchExternal } from './open-external.ts'
import * as git from './git.ts'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { defaultShell, ensureSpawnHelper, PtyManager, shellDisplayName, splitShellArgs, unquotePath } from './pty-manager.ts'
import { AgentPtyRegistry, armPtyResizeGate, tryResizePty, clampDims, type AgentTerminalHandle } from './agent-pty.ts'
import { RemoteTerminalRegistry, RemoteTerminalHandle } from './remote-terminal-registry.ts'
import { captureTerminalInput, terminalInputText } from './terminal-attach-input.ts'
import {
  DSH_NODE_PTY_RANGE,
  depsStatus,
  loadNodePty,
  PTY_DEPS_MISSING,
} from './pty-deps.ts'
import { registerTools } from './tools.ts'
import { AgentOpenRegistry, registerOpenTool, type AgentOpenRequest } from './agent-opens.ts'
import { buildJobsApi, type SidebarJobsRoutes } from './jobs-routes.ts'
import { buildSubagentLiveApi, type SidebarSubagentLiveRoutes } from './subagent-live-route.ts'
import { buildSidechatApi } from './sidechat-routes.ts'
import { createAssistantLiveBuffer, type AssistantLiveBuffer } from './assistant-live.ts'
import { readJsonBody, requireString, SidebarError, writeError, writeJson, writeOk } from './wire.ts'
import { readPersistedSession } from './session-store.ts'
// Register this plugin's producer-owned message source kind ('dsh-better-sidebar')
// for the injected Side Chat boundary message; DSH Session V4 refuses the
// retired `kind: 'plugin'` wrapper. Side-effect import: the augmentation must
// be in the program.
import './message-source.ts'

export { Config }
export type { SidebarConfig, ResolvedSidebarConfig }
// Re-export the Context augmentation (`declare module '@deepseek-ai/cordis'`)
// so consumers `import type {} from 'dsh-better-sidebar'` and gain
// `ctx.betterSidebar`; the Context re-export below is the vendored cordis
// Context intersected with the structural service faces.
// Also re-export the service descriptor types so consumers can type their
// registerTab / registerFileViewer arguments without reaching into /client.
export type { Context } from './context-types.ts'
export type {
  BetterSidebarService,
  TabDescriptor,
  TabComponentProps,
  FileViewerDescriptor,
  FileViewerProps,
  FileFetchStrategy,
} from './client/service.ts'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-better-sidebar'

/** Required services include Connection's authenticated HTTP and upgrade admission. */
export const inject = ['webServer', 'sessions', 'tools', 'connection']

/** Content types for the media route, by extension. */
const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.htm': 'text/html',
}

/** Content type served by /sidebar/file (binary-safe fallback for unknowns). */
export function mediaTypeForPath(path: string): string {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** Resolve a positively selected local workspace, rejecting remote routes. */
async function localWorkspaceCwdOf(ctx: Context, providers: SidebarWorkspaceProviders, sessionId: string): Promise<string> {
  const workspace = await sessionWorkspaceOf(ctx, providers, sessionId)
  if (workspace.kind === 'remote') throw new SidebarError('workspace-unavailable', 'This sidebar operation has no remote backend attached', 501)
  return workspace.cwd
}

/** Optional repository selected by the Git panel when cwd is a container. */
function selectedRepoOf(payload: unknown, workspace: SidebarWorkspaceRoute): string | undefined {
  const record = payload as { repoRoot?: unknown }
  if (record.repoRoot === undefined) return undefined
  const path = requireString(payload, 'repoRoot')
  return workspace.kind === 'remote' ? workspace.paths.absolute(path) : requireAbsolute(path)
}

async function sessionWorkspaceOf(ctx: Context, providers: SidebarWorkspaceProviders, sessionId: string): Promise<SidebarWorkspaceRoute> {
  const scope = await resolveSidebarSessionScope(ctx.sessions, ctx.get('sessionPersistence'), SessionId(sessionId))
  return providers.resolve(scope)
}

/**
 * Resolve a path that a git command reported — `git status`/`git diff`
 * print paths RELATIVE TO THE REPO TOP LEVEL, which may sit above the
 * session cwd (a session inside a subdirectory of a repository). Absolute
 * paths pass through; relative ones join the repo root (falling back to the
 * cwd when the root cannot be resolved, e.g. a bare directory).
 */
async function resolveGitPath(cwd: string, raw: string, selected: string | undefined, workspace: SidebarWorkspaceRoute, backend: GitClient): Promise<string> {
  if (workspace.kind === 'remote') {
    if (workspace.paths.isAbsolute(raw)) return workspace.paths.absolute(raw)
    const sessionPath = workspace.paths.join(cwd, raw)
    if (await workspace.fs.exists(sessionPath)) return sessionPath
    try {
      return workspace.paths.join(await backend.repoRoot(cwd, selected), raw)
    } catch (error) {
      if (error instanceof git.GitCommandError && error.code === 'not-repo') return sessionPath
      throw error
    }
  }
  if (isAbsolute(raw)) return requireAbsolute(resolveSessionPath(cwd, raw))
  const sessionPath = requireAbsolute(join(cwd, raw))
  const exists = await stat(sessionPath).then(() => true).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  })
  if (exists) return sessionPath
  try {
    return requireAbsolute(join(await backend.repoRoot(cwd, selected), raw))
  } catch (error) {
    if (error instanceof git.GitCommandError && error.code === 'not-repo') return sessionPath
    throw error
  }
}

/** How many leading bytes a binary read returns for client-side detect sniffing. */
const READ_HEAD_LIMIT = 4096

/** Text read of a file with the size cap; binary detection via NUL probe.
 *  Binary reads also return the first {@link READ_HEAD_LIMIT} bytes (base64)
 *  so the client can re-match viewers by content (`detect`). */
async function readText(path: string, readLimit: number): Promise<{
  content: string
  truncated: boolean
  binary: boolean
  size: number
  head?: string
}> {
  const info = await stat(path).catch((error: unknown) => {
    throw new SidebarError('fs-error', `cannot read "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
  })
  if (info.isDirectory()) {
    throw new SidebarError('fs-error', `"${path}" is a directory`, 400)
  }
  const size = info.size
  const truncated = size > readLimit
  const handle = await open(path, 'r').catch((error: unknown) => {
    throw new SidebarError('fs-error', `cannot read "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
  })
  try {
    const buffer = Buffer.alloc(Math.min(size, readLimit))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const slice = buffer.subarray(0, bytesRead)
    const binary = slice.includes(0)
    const head = binary
      ? slice.subarray(0, Math.min(slice.length, READ_HEAD_LIMIT)).toString('base64')
      : undefined
    return {
      content: binary ? '' : slice.toString('utf8'),
      truncated,
      binary,
      size,
      head,
    }
  } finally {
    await handle.close()
  }
}

/** Read complete media bytes on the selected execution host. */
async function readWorkspaceBytes(workspace: SidebarWorkspaceRoute, raw: string, limit: number, fence: boolean): Promise<{ path: string; body: Uint8Array }> {
  if (workspace.kind === 'remote') {
    const target = workspace.paths.isAbsolute(raw) ? workspace.paths.absolute(raw) : workspace.paths.join(workspace.cwd, raw)
    const path = await workspace.fs.resolve(target, fence)
    return { path, body: await workspace.fs.readBytes(path, limit, fence) }
  }
  const path = await ensureWorkspacePath(workspace.cwd, resolveWorkspaceTarget(workspace.cwd, raw), fence)
  const info = await stat(path)
  if (!info.isFile() || info.size > limit) throw new SidebarError('fs-error', 'not a file or too large', 400)
  const body = await readFile(path)
  if (body.byteLength > limit) throw new SidebarError('too-large', 'file exceeds media byte limit', 413)
  return { path, body }
}

/** One API method dispatch table entry. */
type ApiMethod = (payload: unknown, signal?: AbortSignal) => Promise<unknown> | unknown

/**
 * The live face of the side card settings namespace, bound to the settings
 * service when it is mounted. The DSH settings RPC domain only serves
 * allowlisted namespaces (api-proxy exposedNamespaces), so the client reads
 * and writes THIS namespace through the plugin's own fenced /sidebar routes,
 * which call the seam in-process — no configuration-client gate involved.
 */
export interface SidebarSettingsFace {
  /** The current resolved value + revision (undefined while the settings service is absent). */
  get(): { value?: unknown; revision?: number }
  /**
   * Whether the dsh-web-ui family's aionui-panel has been selected as the
   * right-panel provider (the `aionui-panel` settings namespace resolves
   * `rightPanel: 'aionui-panel'`). While true the sidebar must not mount —
   * the two right panels are mutually exclusive. False when the namespace is
   * absent (no aionui installed) or the provider is anything else.
   */
  externalDisable(): boolean
  /** Merge a patch (revision-guarded) and return the fresh resolved view. */
  update(patch: Record<string, unknown>, expectedRevision?: number): Promise<{ value?: unknown; revision?: number }>
}

/** Build the API method table bound to the plugin context, pty manager, agent pty registry, resolved config, and effective terminal shell. */
/**
 * Resolve the settings-page terminal shell overrides (the terminal card's
 * gear rows). Empty fields mean "unset": keep the yaml `config.shell` /
 * `shellArgs` (or the platform auto-resolution). The settings page is the
 * runtime complement to the boot-time yaml — same contract, later binding:
 * the values here win for terminals opened afterwards.
 */
function shellOverridesOf(getSettings: () => SidebarSettingsFace | undefined): { shell?: string; shellArgs?: string[] } {
  const settings = getSettings()
  const value = settings?.get().value
  if (value === null || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  const shell = typeof record.terminalShell === 'string' ? unquotePath(record.terminalShell.trim()) : ''
  const args = typeof record.terminalShellArgs === 'string' ? record.terminalShellArgs.trim() : ''
  return {
    shell: shell === '' ? undefined : shell,
    shellArgs: args === '' ? undefined : splitShellArgs(args),
  }
}

/**
 * Whether the workspace fence is armed for the sidebar's filesystem routes
 * (the settings-page `workspaceFence` switch under the files card's gear).
 * An absent settings service or a missing field keeps the fence ON — the
 * containment default never depends on the settings surface being reachable.
 */
function fenceEnabledOf(getSettings: () => SidebarSettingsFace | undefined): boolean {
  const settings = getSettings()
  const value = settings?.get().value
  if (value === null || typeof value !== 'object') return true
  return (value as Record<string, unknown>).workspaceFence !== false
}

/**
 * Parse the browser tab's `browserAllowedLoopback` allowlist into a matcher
 * over host:port (same contract as the client-side helper in
 * src/client/browser.ts — kept in sync). Bare hosts (`localhost`,
 * `127.0.0.1`) match every port; `host:port` entries match exactly.
 */
function parseLoopbackAllowlist(allowlist: string): (host: string, port: string) => boolean {
  const entries = allowlist.split(',').map(entry => entry.trim().toLowerCase()).filter(entry => entry !== '')
  const exact = new Set(entries)
  const hosts = new Set<string>()
  for (const entry of entries) {
    if (!entry.includes(':')) hosts.add(entry.replace(/^\[|\]$/g, ''))
  }
  return (host, port) => {
    const key = `${host}:${port}`
    if (exact.has(key) || exact.has(host)) return true
    return port !== '' && hosts.has(host)
  }
}

function buildApi(
  ctx: Context,
  ptyManager: PtyManager | null,
  agentPtyRegistry: AgentPtyRegistry | null,
  resolved: ResolvedSidebarConfig,
  terminalShell: string,
  getSettings: () => SidebarSettingsFace | undefined,
  assistantLive: AssistantLiveBuffer,
  workspaceProviders: SidebarWorkspaceProviders,
  remoteTerminals: RemoteTerminalRegistry,
): Record<string, ApiMethod> {
  const gitClients = new WeakMap<GitBackend, GitClient>()
  const cwdOf = async (payload: unknown) => {
    const sessionId = requireString(payload, 'sessionId')
    const workspace = await sessionWorkspaceOf(ctx, workspaceProviders, sessionId)
    let backend: GitClient = git
    if (workspace.kind === 'remote') {
      const cached = gitClients.get(workspace.git)
      backend = cached ?? git.createGitClient(workspace.git)
      if (cached === undefined) gitClients.set(workspace.git, backend)
    }
    return { sessionId, cwd: workspace.cwd, workspace, backend }
  }
  /** Validate linked checkouts against the selected repository on the same host. */
  const gitCwdOf = async (payload: unknown) => {
    const base = await cwdOf(payload)
    const record = payload as { worktree?: unknown } | null
    const selected = selectedRepoOf(payload, base.workspace)
    const raw = typeof record?.worktree === 'string' && record.worktree !== '' ? record.worktree : undefined
    if (raw === undefined) return { ...base, repoRoot: selected }
    const requested = base.workspace.kind === 'remote' ? base.workspace.paths.absolute(raw) : requireAbsolute(raw)
    const repository = await base.backend.repoRoot(base.cwd, selected)
    const cwd = await base.backend.resolveWorktree(repository, requested)
    return { ...base, cwd, repoRoot: undefined }
  }
  // Background jobs: the LIST rides the harness's `session/jobs` push
  // mirror, so these routes only replay output the model has read (from the
  // session's own event log — no DSH source is touched, the model's
  // job_output cursor is never consumed) and kill (the registry's stock
  // API). A deployment without the jobs registry downgrades kill to a 503.
  const jobsApi: SidebarJobsRoutes = buildJobsApi(ctx, resolved.readLimit)
  // Subagent live previews: one batch request instead of N per-child
  // `subagents.history` calls. The route degrades to a 503 when the host
  // subagent runtime is absent (the page has no topology to show anyway).
  const subagentLiveApi: SidebarSubagentLiveRoutes = buildSubagentLiveApi(ctx)
  return {
    'session.cwd': async (payload) => {
      const { sessionId, cwd, workspace } = await cwdOf(payload)
      if (workspace.kind === 'remote') {
        const parent = workspace.paths.dirname(cwd)
        return { sessionId, cwd, root: workspace.paths.basename(cwd) || cwd, parent: parent === cwd ? null : parent }
      }
      return { sessionId, cwd, root: rootLabel(cwd), parent: parentOf(cwd) ?? null }
    },
    'fs.tree': async (payload) => {
      const { cwd, workspace } = await cwdOf(payload)
      const record = payload as { path?: unknown }
      if (workspace.kind === 'remote') return workspace.fs.list(record.path === undefined ? cwd : requireString(payload, 'path'), resolved.listLimit, fenceEnabledOf(getSettings))
      const target = record.path === undefined ? cwd : await ensureWorkspacePath(cwd, requireString(payload, 'path'), fenceEnabledOf(getSettings))
      return listDirectory(target, resolved.listLimit)
    },
    'fs.search': async (payload, signal) => {
      signal?.throwIfAborted()
      const { cwd, workspace } = await cwdOf(payload)
      signal?.throwIfAborted()
      const query = requireString(payload, 'query')
      if (workspace.kind === 'remote') return workspace.fs.search(query, signal)
      return searchFiles(cwd, query, { signal })
    },
    'fs.read': async (payload) => {
      const { cwd, workspace, backend } = await cwdOf(payload)
      // Relative paths are git-derived (status/diff report repo-root-relative
      // names; the untracked diff view reads the file through this route). A
      // child-repo path is relative to the selected repoRoot, not the session
      // cwd; thread it so the path resolves inside the authorized workspace.
      const selected = selectedRepoOf(payload, workspace)
      const target = await resolveGitPath(cwd, requireString(payload, 'path'), selected, workspace, backend)
      const fence = fenceEnabledOf(getSettings)
      const result = workspace.kind === 'remote'
        ? await workspace.fs.read(target, resolved.readLimit, fence)
        : await readText(await ensureWorkspacePath(cwd, target, fence), resolved.readLimit)
      const { content, truncated, binary, size, head } = result
      if (binary) return { kind: 'binary', size, truncated, head }
      return { kind: 'text', content, truncated }
    },
    'fs.write': async (payload) => {
      const { cwd, workspace } = await cwdOf(payload)
      const content = requireString(payload, 'content')
      const target = requireString(payload, 'path')
      if (workspace.kind === 'remote') {
        await workspace.fs.write(target, content, fenceEnabledOf(getSettings))
        return { ok: true }
      }
      const path = await ensureWorkspaceWritePath(cwd, target, fenceEnabledOf(getSettings))
      const tmp = `${path}.dsh-sidebar-tmp-${process.pid}`
      try {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(tmp, content, 'utf8')
        await rename(tmp, path)
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => {})
        throw new SidebarError('fs-error', `cannot write "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
      }
      return { ok: true }
    },
    // The tree row's rename: single-segment name, destination-existence and
    // workspace-root refusals, link-aware (renames the row, not its target).
    // fs-operations.ts owns the containment and shape rules.
    'fs.rename': async (payload) => {
      const { cwd, workspace } = await cwdOf(payload)
      if (workspace.kind === 'remote') return workspace.fs.rename(requireString(payload, 'path'), requireString(payload, 'name'), fenceEnabledOf(getSettings))
      return renameWorkspaceEntry({
        cwd,
        path: requireString(payload, 'path'),
        name: requireString(payload, 'name'),
        fence: fenceEnabledOf(getSettings),
      })
    },
    // The tree row's delete (permanent — the host has no trash): recursive
    // for directories, unlinks a symlink row without touching its target.
    'fs.remove': async (payload) => {
      const { cwd, workspace } = await cwdOf(payload)
      if (workspace.kind === 'remote') return workspace.fs.remove(requireString(payload, 'path'), fenceEnabledOf(getSettings))
      return removeWorkspaceEntry({
        cwd,
        path: requireString(payload, 'path'),
        fence: fenceEnabledOf(getSettings),
      })
    },
    'git.worktrees': async (payload) => {
      const { cwd, backend, repoRoot } = await gitCwdOf(payload)
      const selected = repoRoot
      // A workspace container (no repo at cwd) has child repos; the worktree
      // list belongs to the SELECTED child, not the container. Thread the
      // validated repoRoot so linked checkouts of a chosen child appear.
      const base = selected !== undefined ? await backend.repoRoot(cwd, selected) : cwd
      return backend.worktrees(base)
    },
    'git.status': async (payload) => {
      const { cwd, backend, repoRoot } = await gitCwdOf(payload)
      return backend.status(cwd, repoRoot)
    },
    'git.diff': async (payload) => {
      const { cwd, backend, repoRoot, workspace } = await gitCwdOf(payload)
      const record = payload as { path?: unknown; staged?: unknown }
      const path = record.path === undefined ? undefined : await resolveGitPath(cwd, requireString(payload, 'path'), repoRoot, workspace, backend)
      return { diff: await backend.diff(cwd, path, record.staged === true, repoRoot) }
    },
    'git.stage': async (payload) => {
      const { cwd, backend, repoRoot } = await gitCwdOf(payload)
      const record = payload as { path?: unknown }
      const path = record.path === undefined ? undefined : requireString(payload, 'path')
      await backend.stage(cwd, path, repoRoot)
      return { ok: true }
    },
    'git.unstage': async (payload) => {
      const { cwd, backend, repoRoot } = await gitCwdOf(payload)
      const record = payload as { path?: unknown }
      const path = record.path === undefined ? undefined : requireString(payload, 'path')
      await backend.unstage(cwd, path, repoRoot)
      return { ok: true }
    },
    'git.commit': async (payload) => {
      const { cwd, backend, repoRoot } = await gitCwdOf(payload)
      const message = requireString(payload, 'message')
      await backend.commit(cwd, message, repoRoot)
      return { ok: true }
    },
    'git.branch': async (payload) => {
      const { cwd, backend, repoRoot } = await gitCwdOf(payload)
      return backend.branches(cwd, repoRoot)
    },
    'git.checkout': async (payload) => {
      const { cwd, backend, repoRoot } = await gitCwdOf(payload)
      await backend.checkout(cwd, requireString(payload, 'branch'), repoRoot)
      return { ok: true }
    },
    'git.log': async (payload) => {
      const { cwd, backend, repoRoot } = await gitCwdOf(payload)
      const record = payload as { count?: unknown; skip?: unknown }
      const count = typeof record.count === 'number' && Number.isInteger(record.count) && record.count > 0
        ? record.count
        : undefined
      const skip = typeof record.skip === 'number' && Number.isInteger(record.skip) && record.skip >= 0
        ? record.skip
        : undefined
      return backend.log(cwd, count, skip, repoRoot)
    },
    'git.commit-diff': async (payload) => {
      const { cwd, backend, repoRoot } = await gitCwdOf(payload)
      return { diff: await backend.commitDiff(cwd, requireString(payload, 'hash'), repoRoot) }
    },
    'git.discard': async (payload) => {
      const { cwd, backend, repoRoot, workspace } = await gitCwdOf(payload)
      await backend.discard(cwd, await resolveGitPath(cwd, requireString(payload, 'path'), repoRoot, workspace, backend), repoRoot)
      return { ok: true }
    },
    'git.revert': async (payload) => {
      const { cwd, backend, repoRoot } = await gitCwdOf(payload)
      await backend.revert(cwd, requireString(payload, 'hash'), repoRoot)
      return { ok: true }
    },
    'git.cherry-pick': async (payload) => {
      const { cwd, backend, repoRoot } = await gitCwdOf(payload)
      await backend.cherryPick(cwd, requireString(payload, 'hash'), repoRoot)
      return { ok: true }
    },
    'git.show': async (payload) => {
      const { cwd, backend, repoRoot } = await gitCwdOf(payload)
      // `git show <rev>:<path>` addresses the path inside the revision TREE:
      // repository-relative, exactly the unified diff's own path form (after
      // the a// b/ prefix). The absolute filesystem paths resolveGitPath
      // produces would break the rev:path syntax and fail every read, so the
      // path passes through as-is — it can only address blobs of this repo's
      // own revisions, the same surface git.diff/git.log already expose.
      const path = requireString(payload, 'path')
      const rev = requireString(payload, 'rev')
      return { content: await backend.show(cwd, rev, path, repoRoot) }
    },
    // The session's file-tool events for the changes tab's session lens
    // (and its badge): the CLIENT runtime's sessions face has no event-log
    // access, so the events cross the wire here — live session log first,
    // the persisted logical log for not-yet-hydrated sessions. Only the
    // two event types the lens folds are sent, narrowed to `seq > afterSeq`
    // so polling is a small delta, with the same recent-window cap the
    // client accumulator applies.
    'changes.ops': async (payload) => {
      const sessionId = requireString(payload, 'sessionId')
      const rawAfter = (payload as { afterSeq?: unknown } | null)?.afterSeq
      if (rawAfter !== undefined
        && (typeof rawAfter !== 'number' || !Number.isSafeInteger(rawAfter) || rawAfter < 0)) {
        throw new SidebarError('bad-request', 'afterSeq must be a non-negative integer')
      }
      // An absent cursor means "from the very first event" — a session whose
      // log opens on a tool event (subagent seeds do) carries seq 0, which a
      // literal `> 0` comparison would drop, so the absent case floors at -1.
      const afterSeq = rawAfter ?? -1
      let events: readonly SidebarSessionEvent[] | undefined = ctx.sessions.get(sessionId)?.snapshotEvents()
      if (events === undefined) {
        const persistence = ctx.get('sessionPersistence')
        if (persistence !== undefined) {
          try {
            events = (await readPersistedSession(persistence, sessionId)).events
          } catch {
            // Cold read unavailable (session never persisted): an empty
            // window is the honest answer, not a wire error.
          }
        }
      }
      if (events === undefined) return { events: [], lastSeq: Math.max(afterSeq, 0) }
      const CHANGES_EVENTS_CAP = 4000
      const filtered = events.filter(
        event => (event.type === 'tool/call' || event.type === 'tool/result') && event.seq > afterSeq,
      )
      const window = filtered.length > CHANGES_EVENTS_CAP ? filtered.slice(filtered.length - CHANGES_EVENTS_CAP) : filtered
      return { events: window, lastSeq: window.at(-1)?.seq ?? afterSeq }
    },
    // Release a terminal immediately. The WebSocket close frame already does
    // this while the socket is open; this route covers the tab-close that
    // happens while the socket is down (reconnect loop), so a closed tab can
    // never hold the per-session quota until the reconnect grace expires.
    'pty.close': async (payload) => {
      const sessionId = requireString(payload, 'sessionId')
      const tab = requireString(payload, 'tab')
      // Degraded mode (node-pty unavailable): no live pty can exist, so a
      // no-op ok is the honest answer — never an error the client must show.
      await remoteTerminals.close(JSON.stringify([sessionId, tab]))
      ptyManager?.close(`${sessionId}:${tab}`)
      return { ok: true }
    },
    // Release an agent terminal by uuid. The WS close frame already does
    // this while the socket is open; this route covers the tab-close that
    // happens while the socket is down (reconnect loop) so a closed agent
    // tab never leaves a zombie pty behind. Idempotent.
    'agent-pty.close': async (payload) => {
      const uuid = requireString(payload, 'uuid')
      const sessionId = requireString(payload, 'sessionId')
      if (agentPtyRegistry?.get(uuid)) agentPtyRegistry.assertOwned(uuid, sessionId)
      await agentPtyRegistry?.close(uuid)
      return { ok: true }
    },
    // The sidebar wait banner's skip button: abort every active
    // terminal_wait_for on one agent terminal. An unknown uuid (a terminal
    // already closed / reaped) goes through `expect` and surfaces as 404
    // not-found; the client tolerates that and lets the next push converge.
    // Nothing waiting on a live terminal is not an error: 0 skipped.
    // Degraded mode (node-pty unavailable) has no registry and no waits: an
    // honest ok.
    'agent-pty.skip-wait': async (payload) => {
      const uuid = requireString(payload, 'uuid')
      const sessionId = requireString(payload, 'sessionId')
      agentPtyRegistry?.assertOwned(uuid, sessionId)
      return { ok: true, skipped: agentPtyRegistry?.skipWait(uuid) ?? 0 }
    },
    // Terminal dependency status (issue #140): after a WS close 1011 with
    // reason `pty-deps-missing` the client fetches the full repair details
    // here — the close reason itself is capped at 123 bytes, too small for
    // the pasteable command.
    'terminal.deps': () => depsStatus(),
    // Background jobs: read one job's output (a REPLAY of what the model
    // has read so far, from the owner session's event log — the model's
    // job_output cursor is never touched, so the human pane can never steal
    // the agent's bytes), and kill one job. The job LIST itself arrives
    // through the harness's session/jobs push mirror, so no list route
    // exists. Kill is fenced to the owning session by the jobs registry.
    'jobs.output': (payload) => jobsApi.output(payload),
    'jobs.kill': (payload) => jobsApi.kill(payload),
    // Subagent live previews: one batch request per refresh; the route folds
    // the newest text/tool activity of every running child in the tree.
    'subagents.live': (payload) => subagentLiveApi.live(payload),
    // The effective terminal shell and its display name: the settings-page
    // override when set (quotes stripped), else the boot-time resolution.
    // The client titles terminal tabs with the name, so a changed setting is
    // visible on the next opened tab without a plugin restart.
    'shell.get': async payload => {
      if ((payload as { sessionId?: unknown } | null)?.sessionId !== undefined) {
        const { workspace } = await cwdOf(payload)
        if (workspace.kind === 'remote') return { shell: workspace.terminalExecutable, name: shellDisplayName(workspace.terminalExecutable) }
      }
      const effective = shellOverridesOf(getSettings).shell ?? terminalShell
      return { shell: effective, name: shellDisplayName(effective) }
    },
    // The side card preferences. The settings service is optional in the
    // composition; while absent the routes report undefined and the client
    // keeps the schema defaults. Writes are revision-guarded: a stale editor
    // is refused with settings-conflict so a concurrent change is never
    // silently overwritten (mirror of the settings seam's own guard).
    'settings.get': () => {
      const settings = getSettings()
      return settings === undefined
        ? { value: undefined, revision: undefined, externalDisable: false }
        : { ...settings.get(), externalDisable: settings.externalDisable() }
    },
    'settings.update': async (payload) => {
      const settings = getSettings()
      if (settings === undefined) {
        throw new SidebarError('settings-rejected', 'the settings service is not mounted in this deployment', 503)
      }
      const record = payload as { patch?: unknown; expectedRevision?: unknown } | null
      const patch = record?.patch
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new SidebarError('bad-request', 'patch must be a plain object')
      }
      const expectedRevision = typeof record?.expectedRevision === 'number' ? record.expectedRevision : undefined
      try {
        return await settings.update(patch as Record<string, unknown>, expectedRevision)
      } catch (error) {
        if (error instanceof SettingsConflictError) {
          throw new SidebarError('settings-conflict', error.message, 409)
        }
        throw new SidebarError('settings-rejected', error instanceof Error ? error.message : String(error), 400)
      }
    },
    // Probe a URL's RESPONSE HEADERS so the sidebar browser can explain an
    // iframe refusal: X-Frame-Options / CSP frame-ancestors are exactly the
    // signals the browser enforces when it refuses to embed a site. The
    // probe is display-only (headers back to the caller), restricted to
    // http(s) non-loopback URLs with a hard timeout, and gated by the same
    // trust fence as every other route — a cross-site page cannot reach it.
    'browser.probe': async (payload) => {
      const raw = requireString(payload, 'url')
      let parsed: URL
      try {
        parsed = new URL(raw)
      } catch {
        throw new SidebarError('bad-request', 'invalid url', 400)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new SidebarError('bad-request', 'only http/https urls can be probed', 400)
      }
      // Mirror the browser tab's address-bar policy: loopback stays unreachable
      // from the sidebar (unless the user allowlisted it), so probing it would
      // leak nothing the tab could use.
      if (isLoopbackHostname(parsed.hostname)) {
        const prefs = getSettings()?.get()?.value as SidebarPrefs | undefined
        const allowlist = typeof prefs?.browserAllowedLoopback === 'string' ? prefs.browserAllowedLoopback : ''
        const allowed = allowlist.trim() !== ''
          && parseLoopbackAllowlist(allowlist)(parsed.hostname, parsed.port)
        if (!allowed) {
          throw new SidebarError('bad-request', 'local addresses are not probed', 400)
        }
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      try {
        let response = await fetch(parsed, { method: 'HEAD', redirect: 'follow', signal: controller.signal })
        // Some servers answer HEAD with 405/501; retry once as GET (the
        // body is discarded — only the headers matter).
        let retriedFromHeadRejection = false
        if (response.status === 405 || response.status === 501) {
          response = await fetch(parsed, { method: 'GET', redirect: 'follow', signal: controller.signal })
          retriedFromHeadRejection = true
        }
        // Some servers (e.g. aliyun consoles) answer HEAD without the
        // X-Frame-Options / CSP headers that only their GET response
        // carries. Without those signals the embeddability check below
        // would wrongly report the site as embeddable and the plain iframe
        // would surface the browser's misleading "refused to connect".
        // Retry once as GET when both signals are absent (body discarded).
        // A 405/501 retry already fetched the GET response, so the signals
        // are either there or genuinely absent — another GET adds nothing.
        const hasEmbedSignals = response.headers.get('content-security-policy') !== null
          || response.headers.get('x-frame-options') !== null
        if (!hasEmbedSignals && !retriedFromHeadRejection && response.status !== 405 && response.status !== 501) {
          response = await fetch(parsed, { method: 'GET', redirect: 'follow', signal: controller.signal })
        }
        const csp = response.headers.get('content-security-policy')
        const frameAncestors = extractFrameAncestors(csp)
        const xFrameOptions = response.headers.get('x-frame-options')
        // The GET fallbacks stream a real body that nothing reads; "body
        // discarded" is not automatic with fetch, so cancel it explicitly to
        // release the socket (a large/streaming response would otherwise stay
        // pinned after the timer clears).
        void response.body?.cancel()
        return {
          reachable: true,
          url: response.url,
          status: response.status,
          ...(xFrameOptions !== null ? { xFrameOptions } : {}),
          ...(frameAncestors !== undefined ? { frameAncestors } : {}),
        }
      } catch {
        // DNS / TLS / connection / timeout: nothing to judge — the client
        // keeps the plain iframe.
        return { reachable: false }
      } finally {
        clearTimeout(timer)
      }
    },
    // External open for the file tree's "open with" menu: reveal a path in
    // the OS file manager, or hand a custom-scheme URL (vscode://,
    // cursor://, zed://, custom editors) to its registered handler. The
    // client is a browser renderer where raw scheme navigation is
    // unreliable, so the launch always goes through the host — the same
    // fence as every other route, argv-only (no shell interpolation).
    'open.external': (payload) => {
      const record = payload as { action?: unknown } | null
      const action = record?.action
      if (action === 'reveal') return launchExternal('reveal', requireString(payload, 'path'))
      if (action === 'url') return launchExternal('url', requireString(payload, 'url'))
      throw new SidebarError('bad-request', 'action must be "reveal" or "url"')
    },
    // Side Chat: create a side-thread child seeded with the parent's full
    // log up to now, deliver follow-ups (cold-resuming when the thread's
    // agent is gone), abort a running thread, and release a thread's agent.
    // Every operation runs through these routes because subagent-origin
    // identities are fenced from the generic session RPCs (agent-lookup
    // ownership), and the thread is created with a CUSTOM seed the stock
    // fork APIs cannot express.
    ...buildSidechatApi(ctx, assistantLive),
  }
}

/**
 * Plugin body: mount the fenced routes and the pty lifecycle.
 * @param ctx - host plugin context with Web routes, Sessions, tools and connection admission.
 * @param config - deployment-provided limits; the Loader validates against
 * {@link Config} and fills defaults, direct callers get them from
 * {@link resolveSidebarConfig}.
 */
export function apply(ctx: Context, config?: SidebarConfig | VolatileConfig): void {
  // pnpm strips the executable bit from node-pty's prebuilt spawn-helper;
  // restore it before any terminal can spawn (idempotent).
  ensureSpawnHelper()
  const resolved = resolveSidebarConfig(config)
  // One shell resolution feeds BOTH terminal surfaces: the UI tabs and the
  // model-facing terminal_* tools. They must stay in lockstep, otherwise a
  // configured shell fixes one surface and silently leaves the other on the
  // platform default.
  const terminalShell = defaultShell({ explicit: resolved.shell })
  const admission = browserAdmission(ctx)
  const workspaceProviders = new SidebarWorkspaceProviders(() => ctx.get('remoteSshManager') !== undefined)
  ctx.effect(() => ctx.provide('sidebarWorkspaceProviders', workspaceProviders), 'Sidebar workspace providers')
  ctx.inject(['remoteSshManager'], () => { workspaceProviders.requireRouter() })
  // node-pty is loaded lazily, never at module top level (issue #140): a
  // missing or broken install must degrade THIS plugin — terminal tab shows
  // a repair command, agent terminal tools stay unregistered — instead of
  // failing the plugin load and taking the whole `dsh web` server down.
  const nodePty = loadNodePty()
  if (nodePty === null) {
    const status = depsStatus()
    const detail = status.ok
      ? 'unknown cause'
      : `${status.cause}. Repair: ${status.command}`
    ctx.logger?.warn(`[dsh-better-sidebar] node-pty (${DSH_NODE_PTY_RANGE}) failed to load: ${detail}`)
  }
  const ptyManager = nodePty !== null
    ? new PtyManager(terminalShell, resolved.terminalsPerSession, resolved.shellArgs, nodePty)
    : null
  // The agent-owned terminal registry: parallel to the UI-tab ptyManager,
  // keyed by uuid (the model's opaque handle) instead of `${sessionId}:${tabId}`,
  // uncapped, and torn down with the plugin. The model creates terminals here
  // through the terminal_create tool; the sidebar view attaches through the
  // same /sidebar/ws/terminal upgrade with ?uuid=... instead of ?tab=...
  const agentPtyRegistry = new AgentPtyRegistry(terminalShell, resolved.shellArgs, nodePty)
  const remoteTerminals = new RemoteTerminalRegistry(resolved.terminalsPerSession)
  const sessionTerminalCleanup = new Set<Promise<void>>()
  ctx.on('session/disposed', session => {
    const cleanup = Promise.all([remoteTerminals.closeSession(session.id), agentPtyRegistry.closeSession(session.id)]).then(() => {})
    sessionTerminalCleanup.add(cleanup)
    void cleanup.catch(error => ctx.logger?.warn(String(error))).finally(() => sessionTerminalCleanup.delete(cleanup))
    return cleanup
  })
  // The model-facing open-request registry: queues `sidebar_open` requests
  // per session and pushes them to connected sidebar views over the
  // `/sidebar/ws/agent-opens` socket. Unlike the pty registry it has no
  // native dependencies — the tool works even in node-pty degraded mode.
  const agentOpenRegistry = new AgentOpenRegistry()

  // ── User-facing "Side card" preferences ──────────────────────────────────
  // The prefs are live (volatile) fields of this plugin's Config (config.ts),
  // so DSH 0.1.7's settings service serves and edits them as this plugin's
  // namespace. The DSH settings RPC domain (api-proxy) only serves allowlisted
  // namespaces to configuration clients, so the client reaches this namespace
  // through the plugin's own fenced routes below ('settings.get' /
  // 'settings.update'), which call the seam in-process. Deployments without a
  // settings service simply never fill the face and the client falls back to
  // the defaults.
  let settingsFace: SidebarSettingsFace | undefined
  // The model-facing terminal tools are gated on the side-card setting
  // `agentTerminalTools` (default off): nothing is injected until the user
  // turns the feature on, and turning it off mid-session unregisters the
  // tools and releases the agent terminals they created.
  let toolsDisposers: (() => void) | null = null
  // The model-facing `sidebar_open` tool is gated the same way (see
  // syncOpenToolsGate below); separate disposer (no native deps, and turning
  // the feature off must not release user terminals).
  let openToolsDisposers: (() => void) | null = null
  const syncToolsGate = (scope: { get(): SidebarPrefs }): void => {
    if (scope.get().agentTerminalTools) {
      if (toolsDisposers === null) {
        toolsDisposers = registerTools(ctx, agentPtyRegistry, (sessionId) => localWorkspaceCwdOf(ctx, workspaceProviders, sessionId), () => shellOverridesOf(() => settingsFace), async (sessionId, title, command, signal) => {
          const workspace = await sessionWorkspaceOf(ctx, workspaceProviders, sessionId)
          signal.throwIfAborted()
          if (!readPrefs(config).agentTerminalTools) throw new SidebarError('workspace-unavailable', 'Agent terminal tools are disabled', 503)
          if (workspace.kind === 'remote') return agentPtyRegistry.createRemote(sessionId, title, command, workspace, signal)
          const overrides = shellOverridesOf(() => settingsFace)
          return agentPtyRegistry.create(sessionId, title, command, workspace.cwd, 80, 24, overrides.shell, overrides.shellArgs)
        })
      }
    } else if (toolsDisposers !== null) {
      toolsDisposers()
      toolsDisposers = null
      // The feature is off: release every agent terminal the model created
      // while it was on (they are only reachable through the tools). The
      // registry change fires the push, so the sidebar reconciles them away.
      void agentPtyRegistry.disposeAll().catch(error => ctx.logger?.warn(String(error)))
    }
  }
  ctx.inject(['settings'], (injected) => {
    // DSH 0.1.7 serves a plugin's settings form from the volatile fields of
    // its Config: the side-card prefs are live Config fields now (config.ts),
    // and the namespace is the profile entry id. Match the declared constant
    // first, then the live form by a field only this plugin declares.
    const sctx = injected as unknown as Context
    ctx.effect(
      () => sctx.settings.configure({ auto: false }, ctx.fiber),
      'dsh-better-sidebar: custom settings page policy',
    )
    const ownNs = (): string => {
      const descriptors = sctx.settings.describe({ redactSecrets: true })
      const declared = descriptors.find(candidate => candidate.ns === SIDEBAR_PREFS_NS)
      if (declared !== undefined) return declared.ns
      const matched = descriptors.find((candidate) => {
        const value = candidate.value
        return typeof value === 'object' && value !== null && Object.hasOwn(value, 'autoOpenSubagent')
      })
      return matched?.ns ?? SIDEBAR_PREFS_NS
    }
    const readCurrent = (): SidebarPrefs => readPrefs(config)
    const scope = {
      get: readCurrent,
      watch: (callback: (next: SidebarPrefs, prev: SidebarPrefs) => void): (() => void) => {
        let previous = readCurrent()
        return (ctx.on as unknown as (event: string, listener: (ns: string) => void) => () => void)(
          'settings/document-updated',
          (updatedNs) => {
            if (updatedNs !== ownNs()) return
            const next = readCurrent()
            callback(next, previous)
            previous = next
          },
        )
      },
    }
    const viewOf = (): { value?: unknown; revision?: number } => {
      const descriptor = sctx.settings.describe({ redactSecrets: true }).find(candidate => candidate.ns === ownNs())
      return descriptor === undefined
        ? { value: undefined, revision: undefined }
        : { value: descriptor.value, revision: descriptor.revision }
    }
    // Mutual exclusion with the dsh-web-ui family right panel: the aionui
    // panel's provider choice (`aionui-panel.rightPanel`) is the authority.
    // While it resolves to 'aionui-panel', this sidebar must not mount. The
    // namespace is read through the settings seam like any other registered
    // section; absent namespace (no aionui installed) = not disabled.
    const externalDisable = (): boolean => {
      const descriptor = sctx.settings.describe({ redactSecrets: true })
        .find(candidate => candidate.ns === 'aionui-panel')
      const value = descriptor?.value as { rightPanel?: unknown } | undefined
      return value?.rightPanel === 'aionui-panel'
    }
    settingsFace = {
      get: viewOf,
      externalDisable,
      update: async (patch, expectedRevision) => {
        await sctx.settings.update(ownNs(), patch, expectedRevision)
        return viewOf()
      },
    }
    // Register (or unregister) the terminal tools from the current setting,
    // and keep them in sync with every settings commit.
    syncToolsGate(scope)
    // The model-facing open tool is gated the same way on `agentOpenTools`
    // (default off): nothing is injected until the user turns the feature
    // on, and turning it off mid-session unregisters the tool and drops the
    // queued (undelivered) open requests. Already-delivered opens keep their
    // tabs — the tools' only lever is the queue, not the rendered state.
    const syncOpenToolsGate = (): void => {
      if (scope.get().agentOpenTools) {
        if (openToolsDisposers === null) {
          openToolsDisposers = registerOpenTool(
            ctx,
            agentOpenRegistry,
            (sessionId) => localWorkspaceCwdOf(ctx, workspaceProviders, sessionId),
            () => {
              const view = settingsFace?.get()
              const value = view?.value
              return value !== null && typeof value === 'object'
                ? value as SidebarPrefs
                : SIDEBAR_PREFS_DEFAULTS
            },
          )
        }
      } else if (openToolsDisposers !== null) {
        openToolsDisposers()
        openToolsDisposers = null
        agentOpenRegistry.drainAll()
      }
    }
    syncOpenToolsGate()
    // ONE watch subscription drives both gates: settings commits re-evaluate
    // the terminal tools AND the open tool together (each gate is idempotent
    // and owns its own disposer). The loader's volatile HMR (a profile edit)
    // re-evaluates too, since it does not always update the settings document.
    scope.watch(() => { syncToolsGate(scope); syncOpenToolsGate() })
    ctx.on('loader/volatile-update', () => { syncToolsGate(scope); syncOpenToolsGate() })
  })

  // ── JSON API ────────────────────────────────────────────────────────────
  // The live assistant stream buffer: DSH 0.1.5 publishes in-flight model
  // deltas as process-local `agent/assistant-stream` frames instead of the
  // durable `assistant/chunk` events 0.1.2 logged, so the side-chat
  // transcript and the inherited in-progress snapshot read them here. The
  // effect releases the listener on fiber disposal.
  const assistantLive = createAssistantLiveBuffer(ctx)
  ctx.effect(() => () => { assistantLive.dispose() }, 'dsh-better-sidebar: live assistant stream buffer')
  const api = buildApi(ctx, ptyManager, agentPtyRegistry, resolved, terminalShell, () => settingsFace, assistantLive, workspaceProviders, remoteTerminals)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/sidebar/api',
    handler: async (req, res) => {
      if (rejectSidebarHttp(admission, req, res)) return
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/sidebar/api/') ? pathname.slice('/sidebar/api/'.length) : undefined
      if (method === undefined || method.includes('/')) {
        writeError(res, new SidebarError('not-found', 'unknown sidebar API method', 404))
        return
      }
      const searchRequest = method === 'fs.search' ? observeSearchRequest(req, res) : undefined
      try {
        const payload = await readJsonBody(req)
        searchRequest?.signal.throwIfAborted()
        const handler = api[method]
        if (handler === undefined) {
          throw new SidebarError('not-found', `unknown sidebar API method "${method}"`, 404)
        }
        const value = await handler(payload, searchRequest?.signal)
        if (!searchRequest?.signal.aborted) writeOk(res, value)
      } catch (error) {
        if (!searchRequest?.signal.aborted) writeError(res, error)
      } finally {
        searchRequest?.dispose()
      }
    },
  }), 'dsh-better-sidebar: /sidebar/api routes')

  // ── Raw upload route ───────────────────────────────────────────────────
  // One request writes one file without JSON/base64 inflation. Folder uploads
  // send each file with a relativePath, preserving the selected directory
  // tree. Bytes stream to a temp sibling and are renamed into place, so a
  // failed or oversized upload never leaves a partial file (see
  // fs-operations.ts for the containment and shape rules).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/sidebar/upload',
    handler: async (req, res) => {
      if (rejectSidebarHttp(admission, req, res)) return
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const sessionId = url.searchParams.get('sessionId')
        const dir = url.searchParams.get('dir')
        const relativePath = url.searchParams.get('relativePath')
        if (sessionId === null || dir === null || relativePath === null || relativePath.trim() === '') {
          throw new SidebarError('bad-request', 'sessionId, dir, and relativePath are required')
        }
        const workspace = await sessionWorkspaceOf(ctx, workspaceProviders, sessionId)
        const input = { dir, relativePath, chunks: req, limit: resolved.uploadLimit, fence: fenceEnabledOf(() => settingsFace) }
        const { path, size } = workspace.kind === 'remote'
          ? await workspace.fs.upload(input)
          : await writeWorkspaceUpload({ cwd: workspace.cwd, ...input })
        writeOk(res, { path, size })
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-better-sidebar: /sidebar/upload route')

  // ── Lazy chunk route (client bundle splits) ─────────────────────────────
  // Serves the client half's split bundles (lib/client-<name>.js) so the
  // heavy preview/terminal libraries load on first use, not at page start
  // (see bundle-route.ts / src/client/chunk-loader.ts).
  ctx.effect(() => registerBundleRoute(ctx, admission), 'dsh-better-sidebar: /sidebar/bundle chunk route')

  // ── Media route (images for the editor) ─────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/sidebar/file',
    handler: async (req, res) => {
      if (rejectSidebarHttp(admission, req, res)) return
      if (req.method !== 'GET') {
        res.writeHead(405)
        res.end()
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const sessionId = url.searchParams.get('sessionId')
        const raw = url.searchParams.get('path')
        if (sessionId === null || raw === null) throw new SidebarError('bad-request', 'sessionId and path are required')
        const workspace = await sessionWorkspaceOf(ctx, workspaceProviders, sessionId)
        const { path, body } = await readWorkspaceBytes(workspace, raw, resolved.mediaLimit, fenceEnabledOf(() => settingsFace))
        const type = mediaTypeForPath(path)
        // Raw bytes either way (binary-safe); ?download=1 switches the
        // disposition so the browser saves the file instead of showing it.
        const headers: Record<string, string> = { 'content-type': type, 'cache-control': 'no-cache' }
        if (url.searchParams.get('download') === '1') {
          headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(basename(path))}`
        }
        res.writeHead(200, headers)
        res.end(body)
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-better-sidebar: /sidebar/file media route')

  // ── HTML preview route (sandboxed HTML + its relative assets) ───────────
  // Serves files under the session cwd for the built-in HTML previewer. The
  // URL is path-encoded (see html-route.ts) so the previewed page's relative
  // assets (./style.css, img/x.png) resolve back into this route with the
  // session scope intact — a query-encoded URL would drop the scope when the
  // browser resolves relatives. Every response carries the CSP `sandbox`
  // directive: inside the editor's iframe the sandbox ATTRIBUTE is the
  // boundary, this header is defense-in-depth so even a top-level load of
  // the URL (e.g. a popup opened by a previewed page) stays in an opaque
  // origin with no same-origin access to the GUI.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/sidebar/html',
    handler: async (req, res) => {
      if (rejectSidebarHttp(admission, req, res)) return
      if (req.method !== 'GET') {
        res.writeHead(405)
        res.end()
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const decoded = decodeHtmlUrl(url.pathname)
        if (!decoded.ok) {
          writeError(res, new SidebarError('bad-request', decoded.message, decoded.status))
          return
        }
        const { sessionId, path } = decoded.ref
        const workspace = await sessionWorkspaceOf(ctx, workspaceProviders, sessionId)
        const { path: absolute, body } = await readWorkspaceBytes(workspace, path, resolved.mediaLimit, fenceEnabledOf(() => settingsFace))
        const type = mediaTypeForPath(absolute)
        res.writeHead(200, {
          'content-type': type === 'text/html' ? 'text/html; charset=utf-8' : type,
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          // The sandbox directive (no allow-same-origin → opaque origin) is
          // the previewer's security boundary even for top-level loads;
          // object-src 'none' blocks plugin embeds.
          'content-security-policy': "sandbox allow-scripts allow-popups allow-downloads allow-modals; object-src 'none'",
        })
        res.end(body)
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-better-sidebar: /sidebar/html preview route')

  // ── Terminal WebSocket ──────────────────────────────────────────────────
  // One upgrade endpoint serves both UI-tab terminals (?tab=...) and
  // agent-owned terminals (?uuid=...). The two paths attach to different
  // registries but share the wire protocol: input frames are raw text,
  // resize frames are JSON `{type:'resize',cols,rows}`, and a close frame
  // `{type:'close'}` releases the underlying pty (immediate for agent
  // terminals, scheduled-0 for UI tabs which keep the same reconnect grace
  // contract the host has always had).
  const wss = new WebSocketServer({ noServer: true })
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/sidebar/ws/terminal',
    handler: (req, socket, head) => {
      if (rejectSidebarUpgrade(admission, req, socket)) return
      // The structural request/socket/head faces satisfy the shared fence;
      // the `ws` package wants the real Node types — cast at this boundary.
      wss.handleUpgrade(req as unknown as IncomingMessage, socket as unknown as Duplex, head as Buffer, (ws) => {
        void attachTerminal(ctx, ptyManager, agentPtyRegistry, ws, req, resolved, () => settingsFace, workspaceProviders, remoteTerminals)
      })
    },
  }), 'dsh-better-sidebar: terminal WebSocket')

  // ── Agent terminals push WebSocket ──────────────────────────────────────
  // Pushes the live list of agent terminals for one session to the sidebar
  // view: the client mirrors the list into tabs (id `agent:<uuid>`,
  // title from the agent's `terminal_create` call). The host fires on every
  // create / close / exit; the client reconciles by adding tabs for new
  // uuids and dropping tabs whose uuids disappeared (the user closing a tab
  // sends `{type:'close'}` on the terminal WS, which kills the pty, which
  // fires a change here, which converges the view).
  const agentListWss = new WebSocketServer({ noServer: true })
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/sidebar/ws/agent-terminals',
    handler: (req, socket, head) => {
      if (rejectSidebarUpgrade(admission, req, socket)) return
      agentListWss.handleUpgrade(req as unknown as IncomingMessage, socket as unknown as Duplex, head as Buffer, (ws) => {
        void attachAgentList(agentPtyRegistry, ws, req)
      })
    },
  }), 'dsh-better-sidebar: agent-terminals push WebSocket')

  // ── Agent opens push WebSocket ─────────────────────────────────────────
  // Pushes `sidebar_open` requests for one session to the sidebar view: the
  // host queues each request in the registry (consume-on-send), so a
  // connected view applies it immediately and a disconnected one gets the
  // replay when it attaches. The client mirrors each request into an
  // editor / folder-window / browser tab open.
  const agentOpenWss = new WebSocketServer({ noServer: true })
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/sidebar/ws/agent-opens',
    handler: (req, socket, head) => {
      if (rejectSidebarUpgrade(admission, req, socket)) return
      agentOpenWss.handleUpgrade(req as unknown as IncomingMessage, socket as unknown as Duplex, head as Buffer, (ws) => {
        void attachAgentOpen(agentOpenRegistry, ws, req)
      })
    },
  }), 'dsh-better-sidebar: agent-opens push WebSocket')

  ctx.effect(() => async () => {
    toolsDisposers?.()
    openToolsDisposers?.()
    const socketCleanup = [wss, agentListWss, agentOpenWss].map(server => {
      for (const socket of server.clients) socket.terminate()
      return new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) })
    })
    ptyManager?.disposeAll()
    const cleanup = Promise.allSettled([agentPtyRegistry.dispose(), remoteTerminals.disposeAll(), ...sessionTerminalCleanup, ...socketCleanup])
    agentOpenRegistry.dispose()
    const outcomes = await cleanup
    const failures = outcomes.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Sidebar terminal teardown failed')
  }, 'dsh-better-sidebar: teardown')
}

/** Push queued `sidebar_open` requests for one session to a connected view. */
async function attachAgentOpen(
  registry: AgentOpenRegistry,
  ws: WebSocket,
  req: SidebarHttpRequest,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const sessionId = url.searchParams.get('sessionId')
    if (sessionId === null) {
      ws.close(1008, 'sessionId is required')
      return
    }
    const send = (request: AgentOpenRequest): void => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(request))
      }
    }
    // Attach replays the queued (undelivered) requests for this session; the
    // disposer detaches the view on socket close/error so later opens queue
    // instead of accumulating on a dead socket.
    const unsubscribe = registry.attach(sessionId, send)
    ws.on('close', () => { unsubscribe() })
    ws.on('error', () => { unsubscribe() })
  } catch (error) {
    ws.close(1011, error instanceof Error ? error.message : String(error))
  }
}

/** Push the live agent-terminal list for one session to a connected sidebar view. */
async function attachAgentList(
  registry: AgentPtyRegistry | null,
  ws: WebSocket,
  req: SidebarHttpRequest,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const sessionId = url.searchParams.get('sessionId')
    if (sessionId === null) {
      ws.close(1008, 'sessionId is required')
      return
    }
    const send = (): void => {
      if (ws.readyState === WebSocket.OPEN) {
        // Degraded mode (node-pty unavailable): no agent terminal can exist,
        // so the honest push is the empty list.
        ws.send(JSON.stringify(registry?.list(sessionId) ?? []))
      }
    }
    send()
    const unsubscribe = registry?.subscribe(send)
    ws.on('close', () => { unsubscribe?.() })
    ws.on('error', () => { unsubscribe?.() })
  } catch (error) {
    ws.close(1011, error instanceof Error ? error.message : String(error))
  }
}

/**
 * The WS close reason for a failed terminal attach. A missing configured
 * shell gets a SHORT machine-readable marker (`shell-not-found:<name>`,
 * capped by BYTES — a WS close reason allows at most 123 bytes, which `ws`
 * validates with `Buffer.byteLength`) that the client maps to a localized,
 * actionable banner; every other failure keeps the raw message (the
 * model-side tool errors read it verbatim).
 */
export function wsCloseReasonOf(error: unknown): string {
  if (error instanceof SidebarError && error.code === 'shell-not-found') {
    const name = truncateUtf8Bytes(shellDisplayName(String(error.meta?.shell ?? '')), 100)
    return `shell-not-found:${name}`
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point.
 * A character-count `slice` does not bound the WS close reason: `ws` measures
 * `Buffer.byteLength` against its 123-byte cap, and the resulting throw would
 * replace the very error the reason describes.
 */
function truncateUtf8Bytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value
  let truncated = ''
  for (const character of value) {
    if (Buffer.byteLength(truncated + character) > maxBytes) break
    truncated += character
  }
  return truncated
}

/**
 * Wire one terminal socket to its pty: replay transcript, pump both ways.
 * Two attach modes share the wire protocol:
 * - `?uuid=...` attaches to an agent-owned terminal (created by the
 *   `terminal_create` tool). The close frame kills the pty immediately
 *   (the agent's terminal closes when the user closes the sidebar tab); a
 *   bare socket drop (refresh, tab switch) leaves the pty alive for the
 *   reconnect grace, exactly like UI-tab terminals.
 * - `?tab=...&sessionId=...` attaches to a UI-tab terminal (the user
 *   created it from the + menu). The close frame schedules a 0-ms close
 *   (the host's reconnect grace keeps the shell alive across a refresh).
 *   The park frame (sent when the user switches to another conversation)
 *   marks the pty as parked so the upcoming bare socket drop does NOT start
 *   the grace countdown — the tab is still open in its session's state, so
 *   the shell must survive until the user switches back or closes the tab.
 */
async function attachTerminal(
  ctx: Context,
  ptyManager: PtyManager | null,
  agentPtyRegistry: AgentPtyRegistry | null,
  ws: WebSocket,
  req: SidebarHttpRequest,
  resolved: ResolvedSidebarConfig,
  getSettings: () => SidebarSettingsFace | undefined,
  workspaceProviders: SidebarWorkspaceProviders,
  remoteTerminals: RemoteTerminalRegistry,
): Promise<void> {
  const pending = captureTerminalInput(ws, resolved.terminalInputBufferBytes)
  try {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const uuid = url.searchParams.get('uuid')
    if (uuid !== null) {
      // Degraded mode (node-pty unavailable): no agent terminal can exist,
      // so the lookup behaves exactly like a missing uuid.
      if (agentPtyRegistry === null) {
        ws.close(1011, `agent terminal "${uuid}" not found`)
        return
      }
      const ownerSessionId = url.searchParams.get('sessionId')
      if (ownerSessionId === null) throw new SidebarError('bad-request', 'sessionId is required for agent terminal attachment')
      await sessionWorkspaceOf(ctx, workspaceProviders, ownerSessionId)
      const handle = agentPtyRegistry.assertOwned(uuid, ownerSessionId)
      if (handle === undefined) {
        ws.close(1011, `agent terminal "${uuid}" not found`)
        return
      }
      if (pending.closeRequested) { await agentPtyRegistry.close(uuid); return }
      if (pending.overflow || ws.readyState !== WebSocket.OPEN) return
      if (handle.pty instanceof RemoteTerminalHandle) {
        pumpRemoteTerminal(handle.pty, ws, () => agentPtyRegistry.close(uuid), pending.drain(), resolved.terminalInputBufferBytes, handle)
      } else pumpAgentTerminal(agentPtyRegistry, handle, ws, pending.drain())
      return
    }
    const sessionId = url.searchParams.get('sessionId')
    const tabId = url.searchParams.get('tab')
    if (sessionId === null || tabId === null) {
      ws.close(1008, 'either ?uuid or ?sessionId+?tab are required')
      return
    }
    const workspace = await sessionWorkspaceOf(ctx, workspaceProviders, sessionId)
    const key = JSON.stringify([sessionId, tabId])
    if (pending.closeRequested) { await remoteTerminals.close(key); ptyManager?.close(`${sessionId}:${tabId}`); return }
    if (pending.overflow || ws.readyState !== WebSocket.OPEN) return
    if (workspace.kind === 'remote') {
      ptyManager?.close(`${sessionId}:${tabId}`)
      const handle = await remoteTerminals.open(key, sessionId, workspace)
      if (pending.closeRequested) { await remoteTerminals.close(key); return }
      if (pending.overflow || ws.readyState !== WebSocket.OPEN) return
      pumpRemoteTerminal(handle, ws, () => remoteTerminals.close(key), pending.drain(), resolved.terminalInputBufferBytes)
      return
    }
    await remoteTerminals.close(key)
    if (pending.closeRequested) { ptyManager?.close(`${sessionId}:${tabId}`); return }
    if (pending.overflow || ws.readyState !== WebSocket.OPEN) return
    if (ptyManager === null) {
      // Degraded mode (issue #140): node-pty unavailable. The close reason
      // is a SHORT marker — a WS close reason is capped at 123 bytes, so the
      // client fetches the full repair command from /sidebar/api/terminal.deps.
      ws.close(1011, PTY_DEPS_MISSING)
      return
    }
    const cwd = workspace.cwd
    // Settings-page shell overrides win over the yaml/auto shell for
    // terminals opened from now on (existing pty handles keep their shell).
    const overrides = shellOverridesOf(getSettings)
    const handle = ptyManager.open(sessionId, tabId, cwd, 80, 24, overrides.shell, overrides.shellArgs)
    // Windows pre-ready gate for the resize frames this socket may deliver
    // (see armPtyResizeGate; inert on POSIX).
    armPtyResizeGate(handle.pty)
    // Replay the transcript, then follow live output.
    if (handle.transcript !== '') ws.send(handle.transcript)
    const onData = (data: string): void => {
      if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 4 * 1024 * 1024) {
        ws.send(data)
      }
    }
    const onExit = ({ exitCode }: { exitCode: number; signal?: number }): void => {
      onData(`\r\n[process exited with code ${String(exitCode)}]\r\n`)
    }
    const dataSub = handle.pty.onData(onData)
    const exitSub = handle.pty.onExit(onExit)
    const receiveInput = (text: string): void => {
      // Control frames are JSON with a known shape; anything else (including
      // JSON that is not a recognized control) is terminal input, verbatim.
      let control: { type?: unknown; cols?: unknown; rows?: unknown } | null = null
      try {
        const parsed: unknown = JSON.parse(text)
        if (parsed !== null && typeof parsed === 'object') {
          control = parsed as { type?: unknown; cols?: unknown; rows?: unknown }
        }
      } catch {
        // Not JSON: terminal input.
      }
      if (control !== null && control.type === 'close') {
        // The owning tab was closed: release the quota immediately.
        ptyManager.scheduleClose(handle.key, 0)
        return
      }
      if (control !== null && control.type === 'park') {
        // The user switched to another conversation: the tab is still open in
        // its session's persisted state, but its view unmounted. Park the pty
        // so the upcoming bare socket drop does NOT start the reconnect-grace
        // countdown — the pty stays alive until the user switches back (a
        // reconnecting view clears the parked state) or explicitly closes the
        // tab (a close frame's scheduleClose clears it).
        ptyManager.park(handle.key)
        return
      }
      if (handle.exited) return
      if (
        control !== null
        && control.type === 'resize'
        && typeof control.cols === 'number' && typeof control.rows === 'number'
      ) {
        tryResizePty(handle.pty, control.cols, control.rows)
      } else {
        handle.pty.write(text)
      }
    }
    ws.on('message', data => receiveInput(terminalInputText(data)))
    ws.on('close', () => {
      dataSub.dispose()
      exitSub.dispose()
      // A parked pty (the user switched conversations and sent `{type:'park'}`)
      // stays alive indefinitely — do NOT start the grace countdown. A bare
      // socket drop without a prior park (refresh, crash) starts the grace
      // period so a quick reconnect keeps the process; the reconnect's open()
      // cancels the pending close.
      if (!ptyManager.isParked(handle.key)) {
        ptyManager.scheduleClose(handle.key, resolved.reconnectGraceMs)
      }
    })
    for (const text of pending.drain()) receiveInput(text)
  } catch (error) {
    ws.close(1011, wsCloseReasonOf(error))
  } finally { pending.dispose() }
}

/**
 * Pump one agent terminal's pty to a connected view. The close frame kills
 * the pty immediately (the agent's terminal closes when the user closes the
 * sidebar tab); a bare socket drop leaves the pty alive — the agent owns
 * the lifetime, and only `terminal_close`, a `{type:'close'}` frame, or
 * plugin teardown kills it.
 */
/** A browser attachment never owns a remote backend; only explicit close releases it. */
function pumpRemoteTerminal(handle: RemoteTerminalHandle, ws: WebSocket, close: () => void | boolean | Promise<void | boolean>, initialInput: readonly string[], maxInputBytes: number, agent?: AgentTerminalHandle): void {
  const send = (data: string): void => {
    if (ws.readyState !== WebSocket.OPEN) return
    if (ws.bufferedAmount >= 4 * 1024 * 1024) { ws.close(1011, 'Terminal view cannot keep up; reconnect to replay'); return }
    ws.send(data)
  }
  const report = (error: unknown): void => { if (ws.readyState === WebSocket.OPEN) ws.close(1011, wsCloseReasonOf(error)) }
  const dataSub = handle.onData(send)
  const exitSub = handle.onExit(({ exitCode }) => {
    if (handle.failure) report(handle.failure)
    else send(`\r\n[process exited with code ${exitCode}]\r\n`)
  })
  // Subscription and replay execute synchronously, so no output can fall between them.
  send(handle.transcript)
  if (handle.failure) report(handle.failure)
  let input = Promise.resolve()
  let inputBytes = 0
  let detached = false
  const receiveInput = (text: string): void => {
    let control: { type?: unknown; cols?: unknown; rows?: unknown } | null = null
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object') control = parsed as { type?: unknown; cols?: unknown; rows?: unknown }
    } catch (_error) { /* Ordinary terminal text is not JSON. */ }
    if (control?.type === 'park') return
    if (control?.type === 'close') {
      detached = true
      void Promise.resolve(close()).catch(report)
      return
    }
    const bytes = Buffer.byteLength(text)
    if (bytes > maxInputBytes - inputBytes) { detached = true; ws.close(1009, 'Terminal input queue limit reached'); return }
    inputBytes += bytes
    input = input.then(async () => {
      if (detached || handle.exited) return
      if (control?.type === 'resize' && typeof control.cols === 'number' && typeof control.rows === 'number') {
        if (!Number.isFinite(control.cols) || !Number.isFinite(control.rows)) throw new SidebarError('bad-request', 'Invalid terminal geometry')
        const dims = clampDims(control.cols, control.rows)
        await handle.resize(dims.cols, dims.rows)
      } else await handle.write(text)
    }).catch(error => { detached = true; report(error) }).finally(() => { inputBytes -= bytes })
  }
  ws.on('message', data => receiveInput(terminalInputText(data)))
  ws.on('close', () => { detached = true; dataSub.dispose(); exitSub.dispose() })
  for (const text of initialInput) receiveInput(text)
  if (agent) agent.transcript = handle.transcript
}

function pumpAgentTerminal(
  registry: AgentPtyRegistry,
  handle: AgentTerminalHandle,
  ws: WebSocket,
  initialInput: readonly string[],
): void {
  if (handle.pty instanceof RemoteTerminalHandle) throw new Error('Remote terminal requires its acknowledged pump')
  const nativePty = handle.pty
  if (handle.transcript !== '') ws.send(handle.transcript)
  const onData = (data: string): void => {
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 4 * 1024 * 1024) {
      ws.send(data)
    }
  }
  const onExit = ({ exitCode }: { exitCode: number; signal?: number }): void => {
    onData(`\r\n[process exited with code ${String(exitCode)}]\r\n`)
  }
  const dataSub = nativePty.onData(onData)
  const exitSub = nativePty.onExit(onExit)
  const receiveInput = (text: string): void => {
    if (handle.exited) return
    let control: { type?: unknown; cols?: unknown; rows?: unknown } | null = null
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object') {
        control = parsed as { type?: unknown; cols?: unknown; rows?: unknown }
      }
    } catch {
      // Not JSON: terminal input.
    }
    if (control !== null && control.type === 'close') {
      // The user closed the sidebar tab: kill the pty immediately. The
      // agent's next terminal_list / terminal_send will see it gone.
      registry.close(handle.uuid)
      return
    }
    if (
      control !== null
      && control.type === 'resize'
      && typeof control.cols === 'number' && typeof control.rows === 'number'
    ) {
      tryResizePty(nativePty, control.cols, control.rows)
    } else if (control === null) {
      // Raw text input (a JSON-looking string the pty would have received
      // verbatim is reachable in theory but is exotic for an agent terminal;
      // preserve the UI-tab semantics and forward as input).
      nativePty.write(text)
    }
    // An unrecognized JSON control frame is dropped (the UI-tab path also
    // treats non-resize JSON controls as input, but for an agent terminal
    // there is no realistic input that is also valid JSON).
  }
  ws.on('message', data => receiveInput(terminalInputText(data)))
  ws.on('close', () => {
    dataSub.dispose()
    exitSub.dispose()
    // A bare socket drop (refresh, tab switch) leaves the agent's pty alive.
    // The agent owns the lifetime: only `terminal_close`, a `{type:'close'}`
    // frame, or plugin teardown kills it. A reconnecting view reattaches the
    // same shell and gets the full transcript replayed.
  })
  for (const text of initialInput) receiveInput(text)
}
