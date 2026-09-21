// @vitest-environment jsdom
/**
 * Native tab memory and the re-address path: a reload restores the plugin's
 * per-tab state (browser URL, side-chat thread, diff reference) through the
 * native tab id, and a path change on an ADDRESS-BACKED record takes the tab's
 * place instead of being overwritten by the address on the next render.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '../src/context-types.ts'
import { createNativeTabRecords } from '../src/client/native/tab-adapter.tsx'
import { createNativeSurface } from '../src/client/native/surface.ts'
import { createNativeTabStateStore } from '../src/client/native/tab-state.ts'

const scope = { sessionId: 's1', cwd: '/work' }

describe('native tab memory', () => {
  it('remembers and recalls one tab\'s state, and forgets it on close', () => {
    const memory = createNativeTabStateStore()
    memory.remember('s1', 'tab1', { path: 'https://example.com/a', meta: { threadId: 'th1' } })
    expect(memory.recall('s1', 'tab1')).toEqual({ path: 'https://example.com/a', meta: { threadId: 'th1' } })
    expect(memory.recall('s2', 'tab1')).toBeUndefined()
    memory.forget('s1', 'tab1')
    expect(memory.recall('s1', 'tab1')).toBeUndefined()
  })

  it('re-seeds a record that arrives without navigation params', () => {
    const memory = createNativeTabStateStore()
    memory.remember('s1', 'tab1', { path: 'https://example.com/a', title: 'example.com' })
    const records = createNativeTabRecords(memory)
    records.ensure({ id: 'tab1', kind: 'browser', title: 'Browser', params: undefined, scope, address: 'page:browser/tab1' })
    expect(records.get('tab1')?.tab.path).toBe('https://example.com/a')
    expect(records.get('tab1')?.tab.title).toBe('example.com')
  })

  it('skips the descriptor factory when the memory already holds the meta', () => {
    const memory = createNativeTabStateStore()
    memory.remember('s1', 'tab1', { meta: { threadId: 'th1' } })
    const records = createNativeTabRecords(memory)
    let minted = 0
    records.ensure({
      id: 'tab1',
      kind: 'sidechat',
      title: 'Side chat',
      params: undefined,
      scope,
      address: 'page:sidechat/tab1',
      mint: () => { minted += 1; return { meta: { autoCreate: true }, title: 'Untitled' } },
    })
    // A restored side chat reattaches to its thread instead of minting a new one.
    expect(minted).toBe(0)
    expect(records.get('tab1')?.tab.meta).toEqual({ threadId: 'th1' })
  })
})

/** A surface over a fake controller; records the resource opens it produces. */
function mountSurface(): {
  records: ReturnType<typeof createNativeTabRecords>
  surface: ReturnType<typeof createNativeSurface>
  opened: Array<{ address: string; options: Record<string, unknown> }>
} {
  // The memory document lives in the shared jsdom localStorage: start clean.
  localStorage.clear()
  const opened: Array<{ address: string; options: Record<string, unknown> }> = []
  const controller = {
    openTab: () => {},
    openResource: (address: string, options: Record<string, unknown>) => { opened.push({ address, options }) },
    close: () => {},
  }
  const ctx = {
    get: (name: string) => (name === 'sidebarRight' ? controller : undefined),
    sessions: {
      list: {
        subscribe: () => () => {},
        getSnapshot: () => ({ current: 's1' }),
      },
    },
  } as unknown as Context
  const records = createNativeTabRecords(createNativeTabStateStore())
  return { records, surface: createNativeSurface(ctx, records), opened }
}

describe('re-addressing an address-backed tab', () => {
  it('takes the tab\'s place on a path change instead of rewriting the record', () => {
    const { records, surface, opened } = mountSurface()
    const address = surface.fileAddress('s1', '/work', '/work/a.ts')
    // A live resource record is seeded from its address (paramsOf) plus the seed.
    records.ensure({ id: 'tab1', kind: 'editor', title: 'a.ts', params: { path: '/work/a.ts' }, scope, address })
    expect(surface.update('tab1', { path: '/work/sub/b.ts', title: 'b.ts' })).toBe(true)
    expect(opened).toEqual([{
      address: surface.fileAddress('s1', '/work', '/work/sub/b.ts'),
      options: { revealIfOpened: false, replaceTab: 'tab1', params: { title: 'b.ts' } },
    }])
    // The record keeps the OLD path: the address owns it until the new tab lands.
    expect(records.get('tab1')?.tab.path).toBe('/work/a.ts')
  })

  it('keeps writing the record for a page tab whose address carries no path', () => {
    const { records, surface, opened } = mountSurface()
    records.ensure({ id: 'tab2', kind: 'browser', title: 'Browser', params: undefined, scope, address: 'page:browser/tab2' })
    expect(surface.update('tab2', { path: 'https://example.com/x', title: 'example.com' })).toBe(true)
    expect(opened).toEqual([])
    expect(records.get('tab2')?.tab.path).toBe('https://example.com/x')
  })
})
