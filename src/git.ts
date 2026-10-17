/**
 * Git operations for the sidebar source-control panel. Everything goes
 * through the system `git` binary spawned per request (no library, no state),
 * with porcelain-parseable output formats (`-z` NUL framing, unit separators)
 * so parsing never depends on locale or color config. All commands run with
 * `-C <cwd>` on the session's working directory and `--no-pager` /
 * `-c color.ui=false` so output stays machine-readable.
 *
 * Commits use the user's git global identity untouched (never sets
 * user.name/user.email).
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/** A parsed `git status --porcelain=v1 -z` entry. */
export interface GitStatusEntry {
  path: string
  /** Two-letter index/worktree status (X Y), e.g. 'M ', ' M', 'A ', '??'. */
  xy: string
}

/** The source-control panel snapshot. */
export interface GitStatusResult {
  isRepo: boolean
  branch?: string
  entries: GitStatusEntry[]
  /** True when the working tree had more rows than `GIT_STATUS_LIMIT`; the
   *  panel shows a truncation notice instead of freezing on a huge untracked
   *  set (issue #369). */
  truncated?: boolean
  /** Selected repository root, or the discovered roots when the cwd is a container. */
  root?: string
  repositories?: string[]
}

/** One linked checkout returned by `git worktree list --porcelain`. */
export interface GitWorktree {
  /** Absolute checkout root. */
  path: string
  /** Branch name without `refs/heads/`, or `HEAD` when detached. */
  branch: string
  /** Whether this checkout contains the session cwd. */
  current: boolean
  /** Number of staged + unstaged status rows (a file changed on both sides counts once). */
  changes: number
}

/** One `git log` row. */
export interface GitLogEntry {
  /** Short hash (7+ chars, display). */
  hash: string
  /** Full 40-char hash (advanced operations: revert / cherry-pick). */
  hashFull: string
  subject: string
  author: string
  /** ISO 8601 author date (`%ai`), e.g. `2024-01-01 10:00:00 +0800`. */
  date: string
  /** Ref decorations (`%D` with --decorate=short), e.g. `HEAD -> main, origin/main`; '' when none. */
  refs: string
}

/** One git failure (stderr text as the message). */
export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly code = 'git-error',
    readonly command: string,
    readonly exitCode?: number,
  ) {
    super(message)
  }
}

/** Only a completed Git diagnostic can justify an expected absence or compatibility fallback. */
function gitDiagnostic(error: unknown, pattern: RegExp): error is GitCommandError {
  return error instanceof GitCommandError && pattern.test(error.message)
}

function repositoryAbsent(error: unknown): boolean {
  return gitDiagnostic(error, /^fatal: not a git repository(?:\b|\s)/)
}

/** Refuse option-like revisions and branch names before any Git side effect. */
function requireGitOperand(value: string, command: string): void {
  if (value === '' || value.startsWith('-') || value.includes('\0')) {
    throw new GitCommandError(`invalid ${command} operand`, 'git-error', command)
  }
}

/** Parse porcelain v1 -z output into entries (rename/copy pairs collapse to one row). */
export function parsePorcelainZ(output: string): GitStatusEntry[] {
  const tokens = output.split('\0')
  const entries: GitStatusEntry[] = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    index += 1
    if (token === '') continue
    const xy = token.slice(0, 2)
    const rest = token.slice(3)
    entries.push({ path: rest, xy })
    // Rename/copy entries carry the ORIGIN path as the next NUL field; the
    // new path (the file as it exists now) is the display path.
    if ((xy[0] === 'R' || xy[0] === 'C') && tokens[index] !== undefined && tokens[index] !== '') {
      index += 1
    }
  }
  return entries
}

/** One raw porcelain worktree record. Prunable checkouts are retained by
 * Git's administrative metadata after their directory disappears and must not
 * become selectable command targets. Locked checkouts remain usable. */
export interface GitWorktreeRecord {
  path: string
  branch: string
  locked: boolean
  prunable: boolean
}

/** Parse `git worktree list --porcelain` records. Production requests use
 * `-z` so even newlines and non-ASCII bytes in checkout paths stay lossless;
 * newline framing remains accepted for small fixtures and older Git output. */
export function parseWorktreeList(output: string): GitWorktreeRecord[] {
  const rows: GitWorktreeRecord[] = []
  let path: string | undefined
  let branch = 'HEAD'
  let locked = false
  let prunable = false
  const flush = (): void => {
    if (path !== undefined) rows.push({ path, branch, locked, prunable })
    path = undefined
    branch = 'HEAD'
    locked = false
    prunable = false
  }
  const sep = output.includes('\0') ? '\0' : '\n'
  const framed = output.endsWith(sep) ? output : `${output}${sep}`
  for (const line of framed.split(sep)) {
    if (line === '') {
      flush()
    } else if (line.startsWith('worktree ')) {
      path = line.slice('worktree '.length)
    } else if (line.startsWith('branch refs/heads/')) {
      branch = line.slice('branch refs/heads/'.length)
    } else if (line === 'locked' || line.startsWith('locked ')) {
      locked = true
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      prunable = true
    }
  }
  return rows
}

/** Parse `git log --pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D` rows. */
export function parseLogLines(output: string): GitLogEntry[] {
  const rows: GitLogEntry[] = []
  for (const line of output.split('\n')) {
    if (line === '') continue
    const [hash, subject, author, date, hashFull, refs] = line.split('\x1f')
    if (hash === undefined || subject === undefined) continue
    rows.push({
      hash,
      subject,
      author: author ?? '',
      date: date ?? '',
      hashFull: hashFull ?? hash,
      refs: refs ?? '',
    })
  }
  return rows
}

/** Run one git command; resolves with stdout, rejects with GitCommandError. */
function runLocalGit(cwd: string, args: readonly string[], timeoutMs: number): Promise<string> {
  const full = ['-C', cwd, '--no-pager', '-c', 'color.ui=false', ...args]
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn('git', full, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LANG: 'C', LC_ALL: 'C' },
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { stdout += stdoutDecoder.write(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr += stderrDecoder.write(chunk) })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new GitCommandError(`cannot run git: ${error.message}`, 'git-error', args.join(' ')))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      stdout += stdoutDecoder.end()
      stderr += stderrDecoder.end()
      if (timedOut) {
        reject(new GitCommandError(`git ${args[0] ?? ''} timed out after ${timeoutMs}ms`, 'git-error', args.join(' ')))
      } else if (code === 0) {
        resolvePromise(stdout)
      } else {
        reject(new GitCommandError(stderr.trim() || `git exited with ${String(code)}`, 'git-error', args.join(' '), code ?? undefined))
      }
    })
  })
}

/** Execution and path operations belonging to one selected filesystem host. */
export interface GitBackend {
  /** Execute fixed Git argv and return complete UTF-8 stdout; reject timeout or truncated transport output.
   * @param cwd Authorized command directory on this host.
   * @param args Git arguments without an executable or shell fragments.
   * @param timeoutMs Complete command budget.
   * @returns Complete stdout with NUL framing preserved.
   */
  run(cwd: string, args: readonly string[], timeoutMs: number): Promise<string>
  /** List lexical child-directory names on this host.
   * @param cwd Authorized directory.
   * @returns Child names, not paths on a different host.
   */
  listDirectories(cwd: string): Promise<string[]>
  /** Join paths with this host's filesystem semantics.
   * @param base Absolute directory.
   * @param name Child path.
   * @returns Absolute path on the same host.
   */
  joinPath(base: string, name: string): string
  /** Compare roots using this host's case and path semantics.
   * @param path Absolute path.
   * @returns Normalized identity on this host only.
   */
  pathIdentity(path: string): string
}

const localGitBackend: GitBackend = {
  run: runLocalGit,
  listDirectories: async cwd => (await readdir(cwd, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name),
  joinPath: join,
  pathIdentity: path => {
    const absolute = resolve(path).replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute
  },
}

/** Build Git operations whose discovery caches and capabilities belong to one backend instance.
 * @param backend Positively selected host executor and filesystem operations.
 * @returns Git operations that never select another execution host on failure.
 */
export function createGitClient(backend: GitBackend) {
  const runGit = (cwd: string, args: string[], timeoutMs = 30_000): Promise<string> => backend.run(cwd, args, timeoutMs)
  /** Cap on child directories probed by the workspace-container fallback scan.
   *  A home-directory cwd can hold hundreds of visible folders (Library, iCloud
   *  mounts…); probing them all serially is what froze the panel in #369. */
  const DISCOVERY_LIMIT = 200
  /** Per-probe and direct-discovery budget. `rev-parse` is millisecond-scale on
   *  a healthy checkout; a probe that needs longer is a stalled mount and is
   *  better abandoned than waited on. */
  const DISCOVERY_TIMEOUT_MS = 5_000
  /** Discovery results are cheap to recompute but expensive to storm: the panel
   *  polls every 2s and each poll fans out into several git.* calls that all
   *  resolve the same roots. A short TTL keeps fan-out at one scan per cwd. */
  const DISCOVERY_CACHE_TTL_MS = 60_000

  const repoRootsCache = new Map<string, { roots: string[]; expires: number }>()
  const repoRootsInFlight = new Map<string, Promise<string[]>>()

  /** Whether the directory is inside a git work tree (exit-0 `git rev-parse`).
   *  Probe timeout is short: a cwd on a stalled mount must not hold the panel
   *  hostage for the full command budget (issue #369). */
  async function isGitRepo(cwd: string): Promise<boolean> {
    try {
      const out = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'], DISCOVERY_TIMEOUT_MS)
      return out.trim() === 'true'
    } catch (error) {
      if (repositoryAbsent(error)) return false
      throw error
    }
  }

  /** The repository top level containing `cwd` (`git rev-parse --show-toplevel`). */
  async function directRepoRoot(cwd: string): Promise<string> {
    const out = await runGit(cwd, ['rev-parse', '--show-toplevel'], DISCOVERY_TIMEOUT_MS)
    return out.trim()
  }

  /** Discover the current repository or direct child repositories. Results are
   *  cached per cwd and concurrent callers share one in-flight scan, so opening
   *  the panel (three parallel git.* requests) costs a single discovery pass. */
  function repoRoots(cwd: string): Promise<string[]> {
    const cached = repoRootsCache.get(cwd)
    if (cached !== undefined && cached.expires > Date.now()) return Promise.resolve(cached.roots)
    const pending = repoRootsInFlight.get(cwd)
    if (pending !== undefined) return pending
    const promise = discoverRepoRoots(cwd).then(
      (roots) => {
        repoRootsCache.set(cwd, { roots, expires: Date.now() + DISCOVERY_CACHE_TTL_MS })
        repoRootsInFlight.delete(cwd)
        return roots
      },
      (error: unknown) => {
        repoRootsInFlight.delete(cwd)
        throw error
      },
    )
    repoRootsInFlight.set(cwd, promise)
    return promise
  }

  async function discoverRepoRoots(cwd: string): Promise<string[]> {
    try {
      return [await directRepoRoot(cwd)]
    } catch (error) {
      if (!repositoryAbsent(error)) throw error
    }
    const entries = await backend.listDirectories(cwd)
    const roots: string[] = []
    for (const name of entries
      .filter(name => !name.startsWith('.') && name !== 'node_modules')
      .sort((left, right) => left.localeCompare(right))
      .slice(0, DISCOVERY_LIMIT)) {
      try {
        const root = await directRepoRoot(backend.joinPath(cwd, name))
        if (!roots.some(existing => pathIdentity(existing) === pathIdentity(root))) roots.push(root)
      } catch (error) {
        if (!repositoryAbsent(error)) throw error
      }
    }
    return roots
  }

  /** Resolve the selected repository, defaulting to the first discovered root. */
  async function repoRoot(cwd: string, selected?: string): Promise<string> {
    const roots = await repoRoots(cwd)
    if (roots.length === 0) throw new GitCommandError('not a git repository', 'not-repo', 'rev-parse')
    // Git for Windows may return forward-slash roots while callers pass
    // backslashes (or vice-versa); compare via the platform-aware identity.
    if (selected !== undefined) {
      const identity = pathIdentity(selected)
      const match = roots.find(root => pathIdentity(root) === identity)
      if (match !== undefined) return match
      throw new GitCommandError(`unknown repository: ${selected}`, 'git-repo', 'rev-parse')
    }
    return roots[0]!
  }

  /** The current branch name (`git rev-parse --abbrev-ref HEAD`; 'HEAD' when detached). */
  async function currentBranch(cwd: string): Promise<string> {
    try {
      const out = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
      return out.trim()
    } catch (error) {
      if (gitDiagnostic(error, /^fatal: ambiguous argument 'HEAD': unknown revision/)) return 'HEAD'
      throw error
    }
  }

  /** Upper bound on status rows shipped to the client. Beyond this the result
   *  is truncated (with `truncated: true`) so a pathological untracked set —
   *  e.g. the working tree discovered under a home-directory cwd — cannot
   *  freeze the browser main thread on JSON parse or list render (#369). */
  const GIT_STATUS_LIMIT = 2_000

  /**
   * Working-tree status (untracked included). `--untracked-files=all` lists
   * the contents of new directories as individual entries, while preserving
   * repository discovery and explicit repository selection for workspace roots.
   */
  async function status(cwd: string, selected?: string): Promise<GitStatusResult> {
    const repositories = await repoRoots(cwd)
    if (repositories.length === 0) return { isRepo: false, entries: [], repositories: [] }
    const root = await repoRoot(cwd, selected)
    const [branchResult, statusResult] = await Promise.allSettled([
      currentBranch(root),
      runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    ])
    if (branchResult.status === 'rejected') throw branchResult.reason
    if (statusResult.status === 'rejected') throw statusResult.reason
    const branch = branchResult.value
    const parsed = parsePorcelainZ(statusResult.value)
    const truncated = parsed.length > GIT_STATUS_LIMIT
    return {
      isRepo: true,
      branch,
      entries: truncated ? parsed.slice(0, GIT_STATUS_LIMIT) : parsed,
      truncated,
      root,
      repositories,
    }
  }

  /** Platform-aware identity used only for comparing absolute checkout roots. */
  function pathIdentity(path: string): string {
    return backend.pathIdentity(path)
  }

  /** Whether the current Git binary supports NUL-framed `worktree list` output.
   * Git < 2.36 rejects `-z`; cache the capability after the first attempt so
   * the SCM panel's polling does not repeatedly spawn a command known to fail. */
  let worktreeListSupportsZ: boolean | undefined

  /** Raw usable checkout records, shared by inventory and target validation.
   * Prunable records point at missing paths and are deliberately excluded from
   * both the selector and the command-target allowlist. */
  async function listedWorktrees(cwd: string): Promise<GitWorktreeRecord[]> {
    let raw: string
    if (worktreeListSupportsZ === false) {
      raw = await runGit(cwd, ['worktree', 'list', '--porcelain'])
    } else {
      try {
        raw = await runGit(cwd, ['worktree', 'list', '--porcelain', '-z'])
        worktreeListSupportsZ = true
      } catch (error) {
        if (!gitDiagnostic(error, /(?:unknown|unrecognized) (?:switch|option).*z/)) throw error
        worktreeListSupportsZ = false
        raw = await runGit(cwd, ['worktree', 'list', '--porcelain'])
      }
    }
    return parseWorktreeList(raw).filter(entry => !entry.prunable)
  }

  /** All linked checkouts of the repository containing `cwd`, enriched with a
   * live change count. The current checkout is first so a single-worktree repo
   * preserves the old UI ordering. */
  async function worktrees(cwd: string): Promise<GitWorktree[]> {
    if (!await isGitRepo(cwd)) return []
    const currentRoot = await repoRoot(cwd)
    const listed = await listedWorktrees(cwd)
    const settled = await Promise.allSettled(listed.map(async (entry): Promise<GitWorktree> => ({
      path: entry.path,
      branch: entry.branch,
      current: pathIdentity(entry.path) === pathIdentity(currentRoot),
      changes: (await status(entry.path)).entries.length,
    })))
    const rows = settled.map(result => {
      if (result.status === 'rejected') throw result.reason
      return result.value
    })
    return rows.sort((left, right) => Number(right.current) - Number(left.current))
  }

  /** Resolve an optional client-selected linked checkout. A caller may never use
   * this seam to point Git operations at an unrelated repository: the target
   * must occur in the authoritative session repository's worktree list. */
  async function resolveWorktree(cwd: string, requested?: string): Promise<string> {
    if (requested === undefined || requested === '') return cwd
    const identity = pathIdentity(requested)
    const match = (await listedWorktrees(cwd)).find(entry => pathIdentity(entry.path) === identity)
    if (match === undefined) {
      throw new GitCommandError(`unknown linked worktree: ${requested}`, 'git-worktree', 'worktree list')
    }
    return match.path
  }

  /** Diff text of the worktree (unstaged) or the index (staged). */
  async function diff(cwd: string, path: string | undefined, staged: boolean, selected?: string): Promise<string> {
    const root = await repoRoot(cwd, selected)
    const args = ['diff', '--no-ext-diff', '--no-color', '-U3']
    if (staged) args.push('--cached')
    if (path !== undefined) args.push('--', path)
    return runGit(root, args)
  }

  /** Stage paths (all when path is undefined). */
  async function stage(cwd: string, path: string | undefined, selected?: string): Promise<void> {
    await runGit(await repoRoot(cwd, selected), ['add', '-A', ...(path !== undefined ? ['--', path] : [])])
  }

  /** Unstage paths (all when path is undefined). */
  async function unstage(cwd: string, path: string | undefined, selected?: string): Promise<void> {
    await runGit(await repoRoot(cwd, selected), ['reset', '-q', ...(path !== undefined ? ['--', path] : [])])
  }

  /** Commit the staged changes with a message (global identity untouched). */
  async function commit(cwd: string, message: string, selected?: string): Promise<void> {
    await runGit(await repoRoot(cwd, selected), ['commit', '-m', message])
  }

  /** Branch names (current first). */
  async function branches(cwd: string, selected?: string): Promise<{ current: string; names: string[] }> {
    const root = await repoRoot(cwd, selected)
    const [branchResult, refsResult] = await Promise.allSettled([
      currentBranch(root),
      runGit(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    ])
    if (branchResult.status === 'rejected') throw branchResult.reason
    if (refsResult.status === 'rejected') throw refsResult.reason
    const current = branchResult.value
    const names = refsResult.value.split('\n').filter(line => line !== '')
    return { current, names: names.includes(current) ? names : [current, ...names] }
  }

  /** Switch to an existing branch. */
  async function checkout(cwd: string, branch: string, selected?: string): Promise<void> {
    requireGitOperand(branch, 'checkout')
    await runGit(await repoRoot(cwd, selected), ['checkout', branch])
  }

  /** Recent commit history (newest first), lazily pageable via skip/count. */
  async function log(cwd: string, count = 30, skip = 0, selected?: string): Promise<GitLogEntry[]> {
    const raw = await runGit(await repoRoot(cwd, selected), [
      'log', '-n', String(count), '--skip', String(skip), '--decorate=short',
      '--pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D',
    ])
    return parseLogLines(raw)
  }

  /**
   * Content of a file at a revision (`git show <rev>:<path>`), or null when the
   * revision has no such path (a new/untracked file has no HEAD side).
   */
  async function show(cwd: string, rev: string, path: string, selected?: string): Promise<string | null> {
    requireGitOperand(rev, 'show')
    try {
      return await runGit(await repoRoot(cwd, selected), ['show', `${rev}:${path}`])
    } catch (error) {
      if (gitDiagnostic(error, /^fatal: (?:path .* (?:does not exist|exists on disk, but not)|invalid object name |bad revision |ambiguous argument .*unknown revision)/)) return null
      throw error
    }
  }

  /** Full patch text of one commit (`git show` with the commit header suppressed).
   *  Merge commits show their diff against the first parent (`-m --first-parent`
   *  is a no-op for regular commits), so a history click always has content. */
  async function commitDiff(cwd: string, hash: string, selected?: string): Promise<string> {
    requireGitOperand(hash, 'show')
    return runGit(await repoRoot(cwd, selected), ['show', '--no-ext-diff', '--no-color', '--format=', '-m', '--first-parent', hash])
  }

  /** Discard the worktree changes of one path (`git checkout -- <path>`; the index is untouched). */
  async function discard(cwd: string, path: string, selected?: string): Promise<void> {
    await runGit(await repoRoot(cwd, selected), ['checkout', '--', path])
  }

  /** Revert one commit onto the current branch with an auto-generated message. */
  async function revert(cwd: string, hash: string, selected?: string): Promise<void> {
    requireGitOperand(hash, 'revert')
    await runGit(await repoRoot(cwd, selected), ['revert', '--no-edit', hash])
  }

  /** Cherry-pick one commit onto the current branch. */
  async function cherryPick(cwd: string, hash: string, selected?: string): Promise<void> {
    requireGitOperand(hash, 'cherry-pick')
    await runGit(await repoRoot(cwd, selected), ['cherry-pick', hash])
  }

  return { isGitRepo, repoRoots, repoRoot, currentBranch, status, worktrees, resolveWorktree, diff, stage, unstage, commit, branches, checkout, log, show, commitDiff, discard, revert, cherryPick }
}

/** Backend-scoped Git operations. */
export type GitClient = ReturnType<typeof createGitClient>

/** Local Git operations retained for existing consumers. */
export const { isGitRepo, repoRoots, repoRoot, currentBranch, status, worktrees, resolveWorktree, diff, stage, unstage, commit, branches, checkout, log, show, commitDiff, discard, revert, cherryPick } = createGitClient(localGitBackend)
