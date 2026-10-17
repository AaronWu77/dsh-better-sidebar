// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { createElement, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { Context, SidebarSlotRegisterOptions } from '../src/context-types.ts'
import { api } from '../src/client/api.ts'
import { EditorHost } from '../src/client/EditorHost.tsx'
import { openSidebarFile, revealInExplorer } from '../src/client/intercept.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { registerNativeSurface } from '../src/client/native/index.ts'
import { createNativeSurface } from '../src/client/native/surface.ts'
import { createNativeTabRecords, type NativeBodyInjected, type NativeBodyFrameworkProps, type NativeTabInfo, type NativeTabParams } from '../src/client/native/tab-adapter.tsx'
import type { NativeTabMemory } from '../src/client/native/tab-state.ts'
import { fileAddressFor, parseFileAddress } from '../src/client/resource-address.ts'
import { t } from '../src/client/locales.ts'
import { setupReactAct } from './test-utils.ts'

const locations = [
  ['local POSIX', '/work', '/work'],
  ['local Windows', 'C:/work', 'C:/work'],
  ['remote POSIX with Windows session alias', 'C:/Users/test/.dsh/remote-ssh/workspaces/id/workspace', '/mnt/data/workspace'],
] as const

setupReactAct()
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  } finally {
    vi.restoreAllMocks()
  }
})

/** Host lifecycle and transport are controlled; plugin registrations, records and click handlers are real. */
async function fixture(cwd: string, treeRoot = cwd, inPlace = true, bottomSession: 'same' | 'absent' | 'other' = 'same') {
  const sessionId = crypto.randomUUID()
  const ctx = new CordisContext() as Context
  cleanups.push(() => ctx.fiber.dispose())
  const store = createSidebarStore()
  if (bottomSession !== 'absent') store.setSession(bottomSession === 'same' ? sessionId : 'bottom-other-session')
  store.setPrefs({ ...store.getPrefs(), editorExplorer: inPlace })
  const service = createBetterSidebarService(store)
  const memories = new Map<string, NativeTabMemory>()
  const records = createNativeTabRecords({
    recall: (_session, id) => memories.get(id),
    remember: (_session, id, memory) => { memories.set(id, memory) },
    forget: (_session, id) => { memories.delete(id) },
  })
  const sessionsSnapshot = { current: sessionId, byId: { [sessionId]: { id: sessionId, cwd, displayTitle: 'test' } } }
  ctx.provide('sessions', { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } })
  const definitions = new Map<string, { id: string; kind: string; title: (address: string) => string }>()
  const slots = new Map<string, { options: SidebarSlotRegisterOptions; component: ComponentType<NativeBodyInjected & NativeBodyFrameworkProps> }>()
  ctx.provide('sidebarRightTabs', {
    register: (definition: { id: string; kind: string; title: (address: string) => string }) => {
      definitions.set(definition.kind, definition)
      return () => { definitions.delete(definition.kind) }
    },
  })
  ctx.provide('slots', {
    inject: (_name: string, callback: () => () => void) => callback(),
    register: (options: SidebarSlotRegisterOptions, component: ComponentType<NativeBodyInjected & NativeBodyFrameworkProps>) => {
      const key = `${options.name}:${options.key}`
      slots.set(key, { options, component })
      return () => { slots.delete(key) }
    },
  })
  const host = document.createElement('div')
  document.body.append(host)
  cleanups.push(() => { host.remove() })
  let root: Root | undefined
  let sequence = 0
  const tabs = new Map<string, NativeTabInfo>()
  const calls: Array<{ address: string; options: { params?: NativeTabParams; revealIfOpened?: boolean; replaceTab?: string; preferNewPane?: boolean } }> = []
  const render = () => {
    root?.render(createElement('div', {}, [...tabs.values()].map(info => {
      const definition = definitions.get(info.tab.kind)!
      const entry = slots.get(`sidebar.right.pane.tab:${definition.id}`)!
      return createElement('section', { key: info.tab.id, 'data-tab-id': info.tab.id },
        createElement(entry.component, { ...entry.options.inject!(sessionId), useTabInfo: () => info } as NativeBodyInjected & NativeBodyFrameworkProps))
    })))
  }
  const open = (kind: string, address: string, params?: NativeTabParams, replaceTab?: string, revealIfOpened = true) => {
    if (revealIfOpened && [...tabs.values()].some(info => info.tab.contentId === address)) return
    if (replaceTab !== undefined) tabs.delete(replaceTab)
    const id = `native-${++sequence}`
    tabs.set(id, { tab: {
      id, kind, title: definitions.get(kind)!.title(address), contentId: address, visible: true,
      navigation: { address, params, revision: 0 }, signal: new AbortController().signal,
    } })
    render()
    return id
  }
  const controller = {
    openTab: (kind: string, options?: { params?: NativeTabParams }) => { open(kind, `page:${kind}`, options?.params) },
    openResource: (address: string, options: typeof calls[number]['options'] = {}) => {
      calls.push({ address, options })
      open('editor', address, options.params, options.replaceTab, options.revealIfOpened)
    },
    close: (id: string) => { tabs.delete(id); render() },
  }
  ctx.provide('sidebarRight', controller)
  const surface = createNativeSurface(ctx, records)
  cleanups.push(() => surface.dispose())
  service.setSurface(surface)
  service.registerTab({ id: 'editor', title: 'Files', dedupeKey: tab => tab.path, component: props => createElement(EditorHost, {
    ...props, expanded: props.expanded ?? [], revealed: props.revealed ?? [],
    onToggleDir: props.onToggleDir ?? (() => {}), onReferenceFile: props.onReferenceFile ?? (() => {}),
  }) })
  service.registerFileViewer({ id: 'text', exts: [], fetchStrategy: 'fsRead', component: props => createElement('article', { 'data-loaded-path': props.path }, props.content) })
  const fiber = ctx.plugin((provider) => {
    provider.provide('betterSidebar', service)
    provider.effect(() => registerNativeSurface({ ctx: provider as Context, store, service, records }))
  })
  cleanups.push(() => fiber.dispose())
  await vi.waitFor(() => { expect(definitions.has('files')).toBe(true); expect(ctx.get('betterSidebar')).toBe(service) })
  const tree = vi.spyOn(api, 'fsTree').mockImplementation(async () => ({ path: treeRoot, truncated: false, entries: ['README.md', 'next.ts'].map(name => ({ name, path: `${treeRoot}/${name}`, isDir: false, hidden: false, isSymlink: false, broken: false })) }))
  const read = vi.spyOn(api, 'fsRead').mockImplementation(async (_scope, path) => ({ kind: 'text', path, content: `bytes:${path}`, truncated: false }))
  act(() => { root = createRoot(host) })
  cleanups.push(() => { act(() => { root?.unmount() }); host.remove() })
  let homeId = ''
  await act(async () => { homeId = open('files', 'page:files')! })
  const row = (name: string, id = homeId): HTMLElement => {
    const section = host.querySelector(`[data-tab-id="${id}"]`)!
    const found = [...section.querySelectorAll<HTMLElement>('[role="button"]')].find(element => element.getAttribute('title') === `${treeRoot}/${name}`)
    expect(found, `tree row ${name}`).toBeDefined()
    return found!
  }
  const waitRow = async (name: string, id = homeId) => {
    await act(async () => { await vi.waitFor(() => { row(name, id) }) })
  }
  await waitRow('README.md')
  const click = async (name: string, id = homeId) => { await act(async () => { row(name, id).dispatchEvent(new MouseEvent('click', { bubbles: true })) }) }
  const waitLoaded = async (path: string) => {
    await act(async () => { await vi.waitFor(() => {
      expect([...host.querySelectorAll('[data-loaded-path]')].some(node => node.getAttribute('data-loaded-path') === path)).toBe(true)
    }) })
  }
  return { host, store, ctx, service, records, surface, memories, tabs, calls, tree, read, sessionId, homeId, row, click, waitRow, waitLoaded, controller }
}

describe('native Files guide file opens', () => {
  it.each(['absent', 'other'] as const)('produced file opens retain their owner when the bottom store is %s', async bottomSession => {
    const f = await fixture('/work', '/work', false, bottomSession)
    await act(async () => { openSidebarFile(f.ctx, f.store, f.sessionId, 'README.md') })
    expect(f.calls).toHaveLength(1)
    expect(parseFileAddress(f.calls[0]!.address)).toEqual({ scope: 'session', sessionId: f.sessionId, path: 'README.md' })
    await f.waitLoaded('README.md')
    expect(f.read).toHaveBeenCalledWith({ sessionId: f.sessionId, cwd: '/work' }, 'README.md')
    await act(async () => { openSidebarFile(f.ctx, f.store, f.sessionId, '/work/README.md') })
    expect(f.tabs.size).toBe(2)
    expect(f.calls.at(-1)?.address).toBe(f.calls[0]!.address)
  })

  it('produced-files reveal targets the source Session with an unseeded bottom store', async () => {
    const f = await fixture('/work', '/work', false, 'absent')
    const open = vi.spyOn(f.controller, 'openTab')
    await act(async () => { revealInExplorer(f.ctx, f.store, f.sessionId, ['README.md']) })
    expect(open).toHaveBeenCalledWith('files', expect.objectContaining({ revealIfOpened: true }))
  })

  it('native Git file actions open the editor in their source Session', async () => {
    const f = await fixture('/work', '/work', false, 'absent')
    await act(async () => {
      f.service.registerTab({ id: 'git', title: 'Changes', component: props => createElement('button', {
        onClick: () => { props.onOpenFile?.('/work/README.md') },
      }, 'Open changed file') })
      f.controller.openTab('git')
    })
    const button = [...f.host.querySelectorAll('button')].find(node => node.textContent === 'Open changed file')
    expect(button).toBeDefined()
    await act(async () => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(f.calls).toHaveLength(1)
    expect(parseFileAddress(f.calls[0]!.address)).toEqual({ scope: 'session', sessionId: f.sessionId, path: 'README.md' })
    await f.waitLoaded('README.md')
    expect(f.read).toHaveBeenCalledWith({ sessionId: f.sessionId, cwd: '/work' }, 'README.md')
  })

  it('folder resource opens preserve directory intent instead of reading the directory as a file', async () => {
    const f = await fixture('/work')
    f.tree.mockClear(); f.read.mockClear()
    await act(async () => { f.service.openTab({ type: 'editor', path: '/work/sub', title: 'Subfolder', meta: { dir: true } }, { sessionId: f.sessionId, cwd: '/work' }) })
    expect(f.calls.at(-1)?.options.params).toMatchObject({ title: 'Subfolder', meta: { dir: true } })
    await act(async () => { await vi.waitFor(() => {
      expect(f.tree).toHaveBeenCalledWith({ sessionId: f.sessionId, cwd: 'sub' }, 'sub')
    }) })
    expect(f.read).not.toHaveBeenCalled()
  })

  it.each(['absent', 'other'] as const)('split guide click targets its session when bottom store is %s', async bottomSession => {
    const cwd = 'C:/Users/test/.dsh/remote-ssh/workspaces/id/workspace'
    const treeRoot = '/mnt/data/workspace'
    const f = await fixture(cwd, treeRoot, false, bottomSession)
    await f.click('README.md')
    expect(f.calls).toHaveLength(1)
    expect(parseFileAddress(f.calls[0]!.address)).toEqual({ scope: 'session', sessionId: f.sessionId, path: `${treeRoot}/README.md` })
    await f.waitLoaded(`${treeRoot}/README.md`)
    expect(f.read).toHaveBeenCalledWith({ sessionId: f.sessionId, cwd }, `${treeRoot}/README.md`)
    expect(f.tabs.size).toBe(2)
    expect(f.records.get(f.homeId)?.tab.path).toBeUndefined()
    await f.click('README.md')
    expect(f.tabs.size).toBe(2)
    await f.click('next.ts')
    await f.waitLoaded(`${treeRoot}/next.ts`)
    expect(f.tabs.size).toBe(3)
    expect(f.store.getSnapshot().sessionId).toBe(bottomSession === 'absent' ? undefined : 'bottom-other-session')
  })

  it('explicit new-tab and side opens keep their escapes with an unseeded bottom store', async () => {
    const f = await fixture('/work', '/work', true, 'absent')
    const pick = async (label: string) => {
      await act(async () => { f.row('README.md').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })) })
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === label)
      expect(item).toBeDefined()
      await act(async () => { item!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    }
    await pick(t('openFileNewTab'))
    await f.waitLoaded('README.md')
    expect(f.tabs.size).toBe(2)
    await pick(t('openFileNewTab'))
    expect(f.tabs.size).toBe(3)
    expect(f.calls.at(-1)?.options.revealIfOpened).toBe(false)
    await pick(t('openFileSide'))
    expect(f.tabs.size).toBe(4)
    expect(f.calls.at(-1)?.options).toMatchObject({ preferNewPane: true, revealIfOpened: false })
    expect(f.records.get(f.homeId)?.tab.path).toBeUndefined()
    expect(f.read.mock.calls.every(([scope]) => scope.sessionId === f.sessionId)).toBe(true)
  })

  it.each(locations)('%s: resource switches readdress, retain meta, and close/reopen without stale memory', async (_name, cwd, treeRoot) => {
    const f = await fixture(cwd, treeRoot)
    const scope = { sessionId: f.sessionId, cwd }
    const readPath = (path: string) => parseFileAddress(fileAddressFor(f.sessionId, cwd, path))!.path
    await act(async () => { f.service.openFile(scope, `${treeRoot}/README.md`) })
    await f.waitLoaded(readPath(`${treeRoot}/README.md`))
    const firstId = [...f.tabs.keys()].find(id => id !== f.homeId)!
    await act(async () => { f.service.updateTab(firstId, { meta: { treeOpen: true, treeWidth: 320, custom: 'keep' } }) })
    await f.waitRow('next.ts', firstId)
    await f.click('next.ts', firstId)
    await f.waitLoaded(readPath(`${treeRoot}/next.ts`))
    expect(f.calls.at(-1)).toEqual({
      address: fileAddressFor(f.sessionId, cwd, `${treeRoot}/next.ts`),
      options: { replaceTab: firstId, revealIfOpened: false, params: { title: 'next.ts', meta: { treeOpen: true, treeWidth: 320, custom: 'keep' } } },
    })
    expect(f.records.has(firstId)).toBe(false)
    expect(f.memories.has(firstId)).toBe(false)
    expect(f.tabs.size).toBe(2)
    const nextId = [...f.tabs.keys()].find(id => id !== f.homeId)!
    expect(f.records.get(nextId)?.tab.meta).toEqual({ treeOpen: true, treeWidth: 320, custom: 'keep' })
    await act(async () => { f.service.closeTab(nextId, scope) })
    expect(f.records.has(nextId)).toBe(false)
    expect(f.memories.has(nextId)).toBe(false)
    expect(f.tabs.size).toBe(1)
    await act(async () => { f.service.openFile(scope, `${treeRoot}/next.ts`) })
    await f.waitLoaded(readPath(`${treeRoot}/next.ts`))
    const reopenedId = [...f.tabs.keys()].find(id => id !== f.homeId)!
    expect(reopenedId).not.toBe(nextId)
    expect(f.records.get(reopenedId)?.tab.meta).toBeUndefined()
    expect(f.read.mock.calls.every(([readScope]) => readScope.sessionId === f.sessionId && readScope.cwd === cwd)).toBe(true)
  })

  it.each(locations)('%s: plain guide click reads the file and consecutive in-place switches retain dock meta', async (_name, cwd, treeRoot) => {
    const f = await fixture(cwd, treeRoot)
    await act(async () => { f.service.updateTab(f.homeId, { meta: { treeOpen: true, treeWidth: 310 } }) })
    await f.click('README.md')
    await f.waitLoaded(`${treeRoot}/README.md`)
    expect(f.read).toHaveBeenCalledWith(expect.objectContaining({ sessionId: f.sessionId, cwd }), expect.stringContaining('README.md'))
    expect(f.tabs.size).toBe(1)
    const currentId = [...f.tabs.keys()][0]!
    expect(f.records.get(currentId)?.tab.meta).toEqual({ treeOpen: true, treeWidth: 310 })
    await f.waitRow('next.ts', currentId)
    await f.click('next.ts', currentId)
    await f.waitLoaded(`${treeRoot}/next.ts`)
    expect(f.tabs.size).toBe(1)
    expect(f.records.get([...f.tabs.keys()][0]!)?.tab.meta).toEqual({ treeOpen: true, treeWidth: 310 })
  })
})
