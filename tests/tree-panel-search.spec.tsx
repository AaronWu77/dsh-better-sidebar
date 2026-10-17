// @vitest-environment jsdom
/** Filename results belong only to the current query and Session, including after an uncancellable late reply. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TreePanel } from '../src/client/TreePanel.tsx'
import { api } from '../src/client/api.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { setupReactAct } from './test-utils.ts'
import { t } from '../src/client/locales.ts'
import { deferred } from './deferred.ts'
setupReactAct()
const cleanups: Array<() => void> = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(api, 'fsTree').mockResolvedValue({ path: '/workspace', entries: [], truncated: false })
  vi.spyOn(api, 'sessionCwd').mockResolvedValue({ sessionId: 'search-session', cwd: '/workspace', root: '/', parent: '/' })
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
function mount(cwd = '/workspace', sessionRoot = cwd) {
  vi.mocked(api.sessionCwd).mockResolvedValue({ sessionId: 'search-session', cwd: sessionRoot, root: '/', parent: '/' })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let mounted = true
  const unmount = () => { if (mounted) { act(() => { root.unmount() }); mounted = false; host.remove() } }
  cleanups.push(unmount)
  const store = createSidebarStore(), onOpenFile = vi.fn()
  const render = (sessionId = 'search-session') => root.render(createElement(TreePanel, {
    sessionId, cwd, store, expanded: [], revealed: [], onToggle: () => {}, onReferenceFile: () => {}, onOpenFile,
  }))
  act(() => { render() })
  const input = host.querySelector('input')!
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const debounce = () => act(async () => { await vi.advanceTimersByTimeAsync(300) })
  return { host, type, debounce, onOpenFile, render, unmount }
}
const result = (path: string, truncated = false) => ({ matches: [path], truncated })
describe('TreePanel current-query search', () => {
  it('renders partial relative matches and opens them through the mapped Windows Session root', async () => {
    const search = vi.spyOn(api, 'fsSearch').mockResolvedValue(result('docs/README.md', true))
    const f = mount('C:\\Users\\test\\.dsh\\remote-ssh\\workspaces\\id\\workspace')
    f.type('README'); await f.debounce()
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'search-session' }), 'README', expect.any(AbortSignal))
    const row = f.host.querySelector<HTMLButtonElement>('button[title="docs/README.md"]')!
    expect(row).not.toBeNull()
    expect(f.host.textContent).toContain(t('editorSearchTruncated'))
    expect(f.host.textContent).toMatchInlineSnapshot('"docs/README.mdSearch limits reached — showing partial matches"')
    act(() => { row.click() })
    expect(f.onOpenFile).toHaveBeenCalledWith('C:\\Users\\test\\.dsh\\remote-ssh\\workspaces\\id\\workspace\\docs/README.md')
  })
  it.each([
    ['POSIX folder', '/srv/project/docs', '/srv/project', '/srv/project/docs/README.md'],
    ['Windows folder', 'C:\\project\\docs', 'C:\\project', 'C:\\project\\docs/README.md'],
  ])('%s: opens Session-relative matches once from the authoritative root, not the tree folder', async (_name, folder, root, expected) => {
    vi.spyOn(api, 'fsSearch').mockResolvedValue(result('docs/README.md'))
    const f = mount(folder, root); f.type('README'); await f.debounce()
    const row = f.host.querySelector<HTMLButtonElement>('button[title="docs/README.md"]')!
    act(() => { row.click() })
    expect(f.onOpenFile).toHaveBeenCalledWith(expected)
    expect(api.sessionCwd).toHaveBeenCalledWith({ sessionId: 'search-session', cwd: folder }, expect.any(AbortSignal))
  })

  it('clears old rows on a new query and ignores a superseded success even if the transport resolves after abort', async () => {
    const first = deferred<ReturnType<typeof result>>()
    const second = deferred<ReturnType<typeof result>>()
    const search = vi.spyOn(api, 'fsSearch').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const f = mount()
    f.type('old'); await f.debounce()
    const oldSignal = search.mock.calls[0]![2]!
    f.type('new'); expect(oldSignal.aborted).toBe(true)
    await f.debounce()
    await act(async () => { second.resolve(result('new.md')) })
    expect(f.host.querySelector('button[title="new.md"]')).not.toBeNull()
    await act(async () => { first.resolve(result('old.md')) })
    expect(f.host.querySelector('button[title="old.md"]')).toBeNull()
    expect(f.host.querySelector('button[title="new.md"]')).not.toBeNull()
    f.type('third')
    expect(f.host.querySelector('button[title="new.md"]')).toBeNull()
  })
  it('does not let an old success replace the current query error', async () => {
    const old = deferred<ReturnType<typeof result>>()
    vi.spyOn(api, 'fsSearch').mockReturnValueOnce(old.promise).mockRejectedValueOnce(new Error('Remote connection unavailable'))
    const f = mount()
    f.type('old'); await f.debounce(); f.type('new'); await f.debounce()
    expect(f.host.textContent).toContain('Remote connection unavailable')
    await act(async () => { old.resolve(result('old.md')) })
    expect(f.host.textContent).toContain('Remote connection unavailable')
    expect(f.host.querySelector('button[title="old.md"]')).toBeNull()
  })
  it('cancels obsolete debounce work and restores the tree when the query is cleared', async () => {
    const search = vi.spyOn(api, 'fsSearch').mockResolvedValue(result('obsolete.md'))
    const f = mount()
    f.type('obsolete'); f.type(''); await f.debounce()
    expect(search).not.toHaveBeenCalled()
    expect(f.host.querySelector('button[title="obsolete.md"]')).toBeNull()
  })
  it('cancels the previous Session search and ignores its late results after scope changes', async () => {
    const old = deferred<ReturnType<typeof result>>()
    const search = vi.spyOn(api, 'fsSearch').mockReturnValueOnce(old.promise).mockResolvedValueOnce(result('other.md'))
    const f = mount()
    f.type('readme'); await f.debounce()
    const signal = search.mock.calls[0]![2]!
    act(() => { f.render('other-session') })
    expect(signal.aborted).toBe(true)
    await f.debounce()
    await act(async () => { old.resolve(result('old.md')) })
    expect(f.host.querySelector('button[title="old.md"]')).toBeNull()
    expect(f.host.querySelector('button[title="other.md"]')).not.toBeNull()
  })
  it('keeps root metadata paired with the current Session when old metadata settles late', async () => {
    const oldRoot = deferred<Awaited<ReturnType<typeof api.sessionCwd>>>()
    vi.mocked(api.sessionCwd).mockReturnValueOnce(oldRoot.promise).mockResolvedValueOnce({ sessionId: 'other-session', cwd: '/other-root', root: '/', parent: '/' })
    vi.spyOn(api, 'fsSearch').mockResolvedValueOnce(result('old.md')).mockResolvedValueOnce(result('new.md'))
    const f = mount(); f.type('same-query'); await f.debounce()
    const signal = vi.mocked(api.sessionCwd).mock.calls[0]![1]!
    act(() => { f.render('other-session') }); expect(signal.aborted).toBe(true)
    await f.debounce()
    await act(async () => { oldRoot.resolve({ sessionId: 'search-session', cwd: '/old-root', root: '/', parent: '/' }) })
    expect(f.host.querySelector('button[title="old.md"]')).toBeNull()
    const row = f.host.querySelector<HTMLButtonElement>('button[title="new.md"]')!
    act(() => { row.click() })
    expect(f.onOpenFile).toHaveBeenCalledWith('/other-root/new.md')
  })

  it('aborts active work on unmount and ignores its late reply', async () => {
    const reply = deferred<ReturnType<typeof result>>()
    const search = vi.spyOn(api, 'fsSearch').mockReturnValue(reply.promise)
    const f = mount(); f.type('pending'); await f.debounce()
    const signal = search.mock.calls[0]![2]!
    f.unmount(); expect(signal.aborted).toBe(true)
    await act(async () => { reply.resolve(result('late.md')) })
    expect(f.onOpenFile).not.toHaveBeenCalled()
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('shows an empty completed result without a truncation hint', async () => {
    vi.spyOn(api, 'fsSearch').mockResolvedValue({ matches: [], truncated: false })
    const f = mount(); f.type('absent'); await f.debounce()
    expect(f.host.textContent).toContain(t('editorSearchNoResults'))
    expect(f.host.textContent).not.toContain(t('editorSearchTruncated'))
  })
})
