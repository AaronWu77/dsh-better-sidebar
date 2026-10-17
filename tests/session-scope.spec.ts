import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { resolveSidebarSessionScope } from '../src/session-scope.ts'
import type { SidebarSessionPersistenceService } from '../src/context-types.ts'

const id = SessionId('sidebar-scope-test')
const detached = { get: () => undefined }

function persistence(cwd?: string) {
  const read = vi.fn(async () => ({ events: [] }))
  const close = vi.fn(async () => {})
  const open = vi.fn(async () => ({ header: { cwd }, read, close }))
  const service: SidebarSessionPersistenceService = { open }
  return { service, open, read, close }
}

describe('authoritative sidebar session routing', () => {
  it('selects the live header without touching persistence', async () => {
    const p = persistence('/remote/persisted')
    const live = { get: () => ({ header: { cwd: '/remote/live' }, snapshotEvents: () => [] }) }
    expect(await resolveSidebarSessionScope(live, p.service, id)).toEqual({ sessionId: id, cwd: '/remote/live' })
    expect(p.open).not.toHaveBeenCalled()
  })

  it.each(['/srv/远端 repo', 'C:\\Users\\Fixture\\remote-ssh\\workspaces\\remote', '\\\\server\\share\\workspace'])('reads only the persisted header and preserves its path spelling (%s)', async cwd => {
    const p = persistence(cwd)
    expect(await resolveSidebarSessionScope(detached, p.service, id)).toEqual({ sessionId: id, cwd })
    expect(p.open).toHaveBeenCalledExactlyOnceWith(id, 'read')
    expect(p.read).not.toHaveBeenCalled()
    expect(p.close).toHaveBeenCalledOnce()
  })

  it.each([undefined, '', 'relative/path', 'C:drive-relative', '/remote/\0bad'])('refuses a malformed persisted cwd and closes the handle (%s)', async cwd => {
    const p = persistence(cwd)
    await expect(resolveSidebarSessionScope(detached, p.service, id)).rejects.toMatchObject({ code: 'bad-request' })
    expect(p.close).toHaveBeenCalledOnce()
    expect(p.read).not.toHaveBeenCalled()
  })

  it('rejects an unknown session rather than using the process cwd', async () => {
    await expect(resolveSidebarSessionScope(detached, undefined, id)).rejects.toMatchObject({ code: 'not-found' })
  })

  it('maps the public persistence missing-session error to HTTP 404 without a local fallback', async () => {
    const p: SidebarSessionPersistenceService = { open: vi.fn(async () => { throw new SessionPersistenceNotFoundError(id) }) }
    await expect(resolveSidebarSessionScope(detached, p, id)).rejects.toMatchObject({ code: 'not-found', status: 404 })
  })

  it('propagates persistence failure without selecting a local working directory', async () => {
    const failure = new Error('session unavailable')
    const p: SidebarSessionPersistenceService = { open: vi.fn(async () => { throw failure }) }
    await expect(resolveSidebarSessionScope(detached, p, id)).rejects.toBe(failure)
  })

  it('rejects a live session with no valid header instead of using a different persisted scope', async () => {
    const p = persistence('/srv/other-session')
    await expect(resolveSidebarSessionScope({ get: () => ({ header: {}, snapshotEvents: () => [] }) }, p.service, id)).rejects.toMatchObject({ code: 'bad-request' })
    expect(p.open).not.toHaveBeenCalled()
  })
})
