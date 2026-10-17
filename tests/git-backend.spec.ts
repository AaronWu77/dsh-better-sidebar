import { posix } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createGitClient, GitCommandError, type GitBackend } from '../src/git.ts'

function backend(branch: string, root = '/srv/same-repo') {
  const run = vi.fn(async (cwd: string, args: readonly string[], _timeoutMs: number): Promise<string> => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return root + '\n'
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n'
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return branch + '\n'
    if (args[0] === 'status') return `?? ${branch}-文件.txt\0`
    if (args[0] === 'worktree') return `worktree ${root}\0HEAD abc\0branch refs/heads/${branch}\0\0`
    if (args[0] === 'show') return branch
    throw new Error(`unexpected backend command: ${cwd} ${args.join(' ')}`)
  })
  const listDirectories = vi.fn(async (_cwd: string): Promise<string[]> => [])
  const implementation: GitBackend = { run, listDirectories, joinPath: posix.join, pathIdentity: posix.normalize }
  return { run, listDirectories, implementation, client: createGitClient(implementation) }
}

const nonRepo = () => new GitCommandError('fatal: not a git repository (or any of the parent directories): .git', 'git-error', 'rev-parse', 128)

describe('host-scoped sidebar Git', () => {
  it('keeps identical POSIX cwd discovery and status separate across hosts', async () => {
    const a = backend('host-a')
    const b = backend('host-b')
    const [left, right] = await Promise.all([a.client.status('/srv/same-repo'), b.client.status('/srv/same-repo')])
    expect(left).toMatchObject({ root: '/srv/same-repo', branch: 'host-a', entries: [{ path: 'host-a-文件.txt', xy: '??' }] })
    expect(right).toMatchObject({ root: '/srv/same-repo', branch: 'host-b', entries: [{ path: 'host-b-文件.txt', xy: '??' }] })
    expect(a.run.mock.calls.filter(call => call[1][1] === '--show-toplevel')).toHaveLength(1)
    expect(b.run.mock.calls.filter(call => call[1][1] === '--show-toplevel')).toHaveLength(1)
  })

  it('discovers child repositories through the selected backend, not the local filesystem', async () => {
    const f = backend('remote', '/remote/does-not-exist-on-host/repo')
    f.listDirectories.mockResolvedValue(['repo', '.ignored', 'ordinary', 'node_modules'])
    f.run.mockImplementation(async (cwd, args) => {
      if (args[1] === '--show-toplevel' && cwd.endsWith('/repo')) return cwd + '\n'
      throw nonRepo()
    })
    await expect(f.client.repoRoots('/remote/does-not-exist-on-host')).resolves.toEqual(['/remote/does-not-exist-on-host/repo'])
    expect(f.listDirectories).toHaveBeenCalledExactlyOnceWith('/remote/does-not-exist-on-host')
    expect(f.run.mock.calls.map(call => call[0])).not.toContain('/remote/does-not-exist-on-host/node_modules')
  })

  it.each(['SSH disconnected', 'git command timed out', 'output truncated', 'permission denied'])('does not report a failed host as a clean or non-repository workspace (%s)', async message => {
    const f = backend('remote')
    const error = new Error(message)
    f.run.mockRejectedValue(error)
    await expect(f.client.status('/srv/same-repo')).rejects.toBe(error)
    await expect(f.client.isGitRepo('/srv/same-repo')).rejects.toBe(error)
    expect(f.listDirectories).not.toHaveBeenCalled()
  })

  it('rejects an unknown repository selector rather than operating on the first repo', async () => {
    const f = backend('remote')
    await expect(f.client.stage('/srv/same-repo', 'file.txt', '/srv/unrelated')).rejects.toMatchObject({ code: 'git-repo' })
    expect(f.run.mock.calls.some(call => call[1][0] === 'add')).toBe(false)
  })

  it.each(['--help', '-b', '', '\0bad'])('refuses option-like revision and branch operands before dispatch (%s)', async operand => {
    const f = backend('remote')
    await expect(f.client.checkout('/srv/same-repo', operand)).rejects.toThrow('invalid checkout operand')
    await expect(f.client.revert('/srv/same-repo', operand)).rejects.toThrow('invalid revert operand')
    await expect(f.client.cherryPick('/srv/same-repo', operand)).rejects.toThrow('invalid cherry-pick operand')
    await expect(f.client.show('/srv/same-repo', operand, 'file.txt')).rejects.toThrow('invalid show operand')
    await expect(f.client.commitDiff('/srv/same-repo', operand)).rejects.toThrow('invalid show operand')
    expect(f.run).not.toHaveBeenCalled()
  })

  it('waits for both branch and status operations before reporting a failure', async () => {
    const f = backend('remote')
    let enter!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    let release!: (value: string) => void
    const released = new Promise<string>(resolve => { release = resolve })
    const original = f.run.getMockImplementation()!
    const error = new Error('branch query disconnected')
    f.run.mockImplementation(async (cwd, args, budget) => {
      if (args[1] === '--abbrev-ref') throw error
      if (args[0] === 'status') { enter(); return released }
      return original(cwd, args, budget)
    })
    let finished = false
    const result = f.client.status('/srv/same-repo').catch(failure => { finished = true; return failure })
    await entered
    expect(finished).toBe(false)
    release('')
    expect(await result).toBe(error)
    expect(finished).toBe(true)
  })

  it('retains NUL-framed Unicode/newline rename paths', async () => {
    const f = backend('remote')
    const original = f.run.getMockImplementation()!
    f.run.mockImplementation(async (cwd, args, budget) => args[0] === 'status' ? 'R  新\n名称.txt\0old name.txt\0?? second.txt\0' : original(cwd, args, budget))
    expect((await f.client.status('/srv/same-repo')).entries).toEqual([{ path: '新\n名称.txt', xy: 'R ' }, { path: 'second.txt', xy: '??' }])
  })

  it('does not turn a branch-query transport failure into detached HEAD', async () => {
    const f = backend('remote')
    const original = f.run.getMockImplementation()!
    const error = new Error('AHP lost')
    f.run.mockImplementation(async (cwd, args, budget) => { if (args[1] === '--abbrev-ref') throw error; return original(cwd, args, budget) })
    await expect(f.client.status('/srv/same-repo')).rejects.toBe(error)
  })

  it('does not return null for a revision-read transport failure', async () => {
    const f = backend('remote')
    const original = f.run.getMockImplementation()!
    const error = new Error('AHP lost')
    f.run.mockImplementation(async (cwd, args, budget) => { if (args[0] === 'show') throw error; return original(cwd, args, budget) })
    await expect(f.client.show('/srv/same-repo', 'HEAD', 'file.txt')).rejects.toBe(error)
  })

  it('does not disable NUL worktree framing on a transport failure or retry the query', async () => {
    const f = backend('remote')
    const original = f.run.getMockImplementation()!
    const error = new Error('AHP lost')
    f.run.mockImplementation(async (cwd, args, budget) => { if (args[0] === 'worktree') throw error; return original(cwd, args, budget) })
    await expect(f.client.resolveWorktree('/srv/same-repo', '/srv/linked')).rejects.toBe(error)
    expect(f.run.mock.calls.filter(call => call[1][0] === 'worktree')).toHaveLength(1)
  })

  it('limits old-Git worktree fallback to an explicit unsupported -z result per backend', async () => {
    const old = backend('old')
    const modern = backend('modern')
    const original = old.run.getMockImplementation()!
    old.run.mockImplementation(async (cwd, args, budget) => {
      if (args[0] === 'worktree' && args.includes('-z')) throw new GitCommandError("error: unknown switch `z'", 'git-error', 'worktree list', 129)
      if (args[0] === 'worktree') return 'worktree /srv/same-repo\nbranch refs/heads/old\n\n'
      return original(cwd, args, budget)
    })
    await old.client.worktrees('/srv/same-repo')
    await old.client.worktrees('/srv/same-repo')
    await modern.client.worktrees('/srv/same-repo')
    expect(old.run.mock.calls.filter(call => call[1][0] === 'worktree' && call[1].includes('-z'))).toHaveLength(1)
    expect(modern.run.mock.calls.filter(call => call[1][0] === 'worktree' && call[1].includes('-z'))).toHaveLength(1)
  })
})
