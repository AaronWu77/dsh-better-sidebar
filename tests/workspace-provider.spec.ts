import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SidebarWorkspaceProviders, type SidebarWorkspaceRouter } from '../src/workspace-provider.ts'

const scope = { sessionId: SessionId('provider-session'), cwd: '/srv/project' }

describe('sidebar execution-world selection', () => {
  it('preserves authoritative POSIX spelling in an explicitly standalone host', async () => {
    const providers = new SidebarWorkspaceProviders(() => false)
    await expect(providers.resolve(scope)).resolves.toEqual({ kind: 'local', cwd: '/srv/project' })
  })

  it('refuses missing remote integration before returning a local route', async () => {
    const providers = new SidebarWorkspaceProviders(() => true)
    await expect(providers.resolve(scope)).rejects.toMatchObject({ code: 'workspace-unavailable', status: 503 })
  })

  it('propagates a remote routing failure instead of interpreting it as local', async () => {
    const remoteConfigured = vi.fn(() => true)
    const providers = new SidebarWorkspaceProviders(remoteConfigured)
    const failure = new Error('Remote workspace was removed')
    const router = vi.fn(async () => { throw failure })
    providers.registerRouter(router)
    await expect(providers.resolve(scope)).rejects.toBe(failure)
    expect(router).toHaveBeenCalledExactlyOnceWith(scope)
    expect(remoteConfigured).toHaveBeenCalledTimes(1)
  })

  it('requires a positive local result from a configured remote router', async () => {
    const providers = new SidebarWorkspaceProviders(() => true)
    const router: SidebarWorkspaceRouter = async input => ({ kind: 'local', cwd: input.cwd })
    providers.registerRouter(router)
    await expect(providers.resolve(scope)).resolves.toEqual({ kind: 'local', cwd: scope.cwd })
  })

  it('retains remote-required classification after the manager disappears', async () => {
    let configured = true
    const providers = new SidebarWorkspaceProviders(() => configured)
    configured = false
    await expect(providers.resolve(scope)).rejects.toMatchObject({ status: 503 })
    providers.registerRouter(async input => ({ kind: 'local', cwd: input.cwd }))
    await expect(providers.resolve(scope)).resolves.toMatchObject({ kind: 'local' })
  })

  it('retains a late-observed manager even before any Session request', async () => {
    const providers = new SidebarWorkspaceProviders(() => false)
    providers.requireRouter()
    await expect(providers.resolve(scope)).rejects.toMatchObject({ status: 503 })
  })

  it('refuses ambiguous concurrent router contributions', () => {
    const providers = new SidebarWorkspaceProviders(() => true)
    const router: SidebarWorkspaceRouter = async input => ({ kind: 'local', cwd: input.cwd })
    providers.registerRouter(router)
    expect(() => providers.registerRouter(router)).toThrow('already registered')
  })

  it('removes only the owning contribution and refuses fallback after remote bridge disposal', async () => {
    const providers = new SidebarWorkspaceProviders(() => true)
    const routerA: SidebarWorkspaceRouter = async input => ({ kind: 'local', cwd: input.cwd })
    const routerB = vi.fn<SidebarWorkspaceRouter>(async input => ({ kind: 'local', cwd: input.cwd }))
    const disposeA = providers.registerRouter(routerA)
    disposeA()
    await expect(providers.resolve(scope)).rejects.toMatchObject({ status: 503 })
    const disposeB = providers.registerRouter(routerB)
    disposeA()
    await expect(providers.resolve(scope)).resolves.toEqual({ kind: 'local', cwd: scope.cwd })
    expect(routerB).toHaveBeenCalledOnce()
    disposeB()
    await expect(providers.resolve(scope)).rejects.toMatchObject({ status: 503 })
  })
})
