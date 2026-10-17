// @vitest-environment jsdom
/** Real sidebar state changes fence shell-label requests to the selected Session. */
import { describe, expect, it, vi } from 'vitest'
import { subscribeTerminalTitle } from '../src/client/terminal-title.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { allLeaves, createSidebarStore } from '../src/client/state.ts'

function fixture() {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  service.registerTab({ id: 'terminal', title: 'Terminal', component: () => null })
  const pending = new Map<string, { promise: Promise<{ name: string }>; resolve(name: string): void; reject(error: Error): void }>()
  const read = vi.fn((sessionId: string) => {
    let resolve!: (value: { name: string }) => void
    let reject!: (error: Error) => void
    const promise = new Promise<{ name: string }>((yes, no) => { resolve = yes; reject = no })
    pending.set(sessionId, { promise, resolve: name => resolve({ name }), reject })
    return promise
  })
  let title = 'Terminal'
  const dispose = subscribeTerminalTitle(service, 'Terminal', read, name => { title = name })
  return { store, service, read, pending, dispose, title: () => title }
}

describe('Session terminal shell labels', () => {
  it('uses state subscription, rejects stale host results, and preserves user/agent titles', async () => {
    const f = fixture()
    try {
      expect(f.read).not.toHaveBeenCalled()
      f.store.setSession('local')
      const local = f.pending.get('local')!
      f.store.setSession('remote')
      f.service.openTab({ type: 'terminal', id: 'ui', title: 'Terminal' })
      f.service.openTab({ type: 'terminal', id: 'custom', title: 'My shell' })
      expect(f.read.mock.calls).toEqual([['local'], ['remote']])
      const remote = f.pending.get('remote')!
      remote.resolve('bash'); await remote.promise
      expect(f.title()).toBe('bash')
      local.resolve('pwsh'); await local.promise
      expect(f.title()).toBe('bash')
      const tabs = allLeaves(f.store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
      expect(tabs.find(tab => tab.id === 'ui')?.title).toBe('bash')
      expect(tabs.find(tab => tab.id === 'custom')?.title).toBe('My shell')
    } finally { f.dispose() }
  })
  it('retains localized fallback after failure and invalidates pending results on disposal', async () => {
    const f = fixture()
    f.store.setSession('remote-fails')
    const failed = f.pending.get('remote-fails')!
    failed.reject(new Error('provider missing')); await failed.promise.catch(() => undefined)
    expect(f.title()).toBe('Terminal')
    f.store.setSession('remote-late')
    const late = f.pending.get('remote-late')!
    f.dispose()
    late.resolve('bash'); await late.promise
    expect(f.title()).toBe('Terminal')
    f.store.setSession('next')
    expect(f.read.mock.calls).toEqual([['remote-fails'], ['remote-late']])
  })
})
