import { beforeEach, describe, expect, it, vi } from 'vitest'
import { win32 } from 'node:path'
import { ensureWorkspacePath, ensureWorkspaceWritePath } from '../src/path-security.ts'

const mocks = vi.hoisted(() => ({ realpath: vi.fn<(value: string) => Promise<string>>() }))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), realpath: mocks.realpath }))
const project = "\\\\wsl.localhost\\Ubuntu-22.04\\home\\aaronwu\\SuperPlus"
const file = win32.join(project, 'README.md')
const address = '/wsl.localhost/Ubuntu-22.04/home/aaronwu/SuperPlus/README.md'
const hostRoot = win32.resolve('D:/deepseek-harness')

describe.skipIf(process.platform !== 'win32')('WSL paths at the realpath and fence boundary', () => {
  beforeEach(() => {
    mocks.realpath.mockReset()
    mocks.realpath.mockImplementation(async path => path)
  })

  it('reads the UNC target, never a drive-rooted lookalike, when the fence is disabled', async () => {
    await expect(ensureWorkspacePath(hostRoot, address, false)).resolves.toBe(file)
    expect(mocks.realpath).toHaveBeenCalledWith(file)
    expect(mocks.realpath.mock.calls.flat()).not.toContain(win32.resolve(hostRoot, address))
  })

  it('still refuses a WSL target outside an ordinary Windows workspace when fenced', async () => {
    await expect(ensureWorkspacePath(hostRoot, address)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('accepts the named target in its WSL workspace', async () => {
    await expect(ensureWorkspacePath(project, address)).resolves.toBe(file)
  })

  it('enforces the canonical symlink target rather than the requested spelling', async () => {
    mocks.realpath.mockImplementation(async path => path === file ? win32.join(project, '..', 'private', 'secret.md') : path)
    await expect(ensureWorkspacePath(project, address)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('keeps missing write destinations under their canonical UNC ancestor', async () => {
    const destination = win32.join(project, 'new', 'note.md')
    mocks.realpath.mockImplementation(async path => {
      if (path === project) return project
      throw Object.assign(new Error('missing fixture destination'), { code: 'ENOENT' })
    })
    await expect(ensureWorkspaceWritePath(project, '/wsl.localhost/Ubuntu-22.04/home/aaronwu/SuperPlus/new/note.md')).resolves.toBe(destination)
    expect(mocks.realpath).toHaveBeenCalledWith(destination)
  })
})
