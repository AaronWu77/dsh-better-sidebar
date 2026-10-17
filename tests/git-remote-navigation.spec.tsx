/** Git editor navigation uses the Session's authoritative cwd, not its remote alias. */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { GitLens } from '../src/client/changes/GitLens.tsx'
import { api, type SessionScope } from '../src/client/api.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { t } from '../src/client/locales.ts'
import { setupReactAct } from './test-utils.ts'

setupReactAct()

type Metadata = Awaited<ReturnType<typeof api.sessionCwd>>
type MenuProps = ComponentProps<typeof import('@deepseek-ai/dsh-client-ui-primitives').Menu>
const menuAction = vi.hoisted(() => ({ select: undefined as MenuProps['onSelect'] }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-client-ui-primitives')>()
  return {
    ...actual,
    Menu: (props: MenuProps) => {
      // Keep the real menu while exposing the executor for hidden-action regressions.
      if (props.open && props.items?.some(item => item.id === 'absolute')) menuAction.select = props.onSelect
      return createElement(actual.Menu, props)
    },
  }
})

const ALIAS = 'D:/remote-alias/project'
const CWD = '/srv/project/main'
const REMOTE: SessionScope = { sessionId: 'remote-session', cwd: ALIAS }
const disposers: Array<() => Promise<void>> = []

function metadata(scope: SessionScope, cwd = CWD): Metadata {
  return { sessionId: scope.sessionId, cwd, root: '/srv', parent: '/srv/project' }
}

function pendingMetadata(scope: SessionScope) {
  let resolve!: (value: Metadata) => void
  const promise = new Promise<Metadata>((done) => { resolve = done })
  disposers.push(async () => {
    await act(async () => { resolve(metadata(scope)); await promise })
  })
  return { promise, resolve }
}

function mockCheckout(checkout = CWD, external?: string): void {
  vi.spyOn(api, 'gitWorktrees').mockResolvedValue([
    { path: checkout, branch: 'main', current: true, changes: external === undefined ? 1 : 0 },
    ...(external === undefined ? [] : [{ path: external, branch: 'linked', current: false, changes: 1 }]),
  ])
  vi.spyOn(api, 'gitStatus').mockImplementation(async (_scope, target) => ({
    isRepo: true, root: target ?? checkout, branch: 'main', entries: [{ path: 'README.md', xy: ' M' }],
  }))
  vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
  vi.spyOn(api, 'gitLog').mockResolvedValue([])
}

async function mountLens(scope = REMOTE, fence = true) {
  const container = document.createElement('div')
  document.body.append(container)
  disposers.push(async () => { container.remove() })
  const root = createRoot(container)
  let mounted = true
  const unmount = async (): Promise<void> => {
    if (!mounted) return
    mounted = false
    await act(async () => { root.unmount() })
  }
  disposers.push(unmount)
  const store = createSidebarStore()
  store.setPrefs({ ...store.getPrefs(), workspaceFence: fence })
  const onOpenFile = vi.fn()
  const render = async (next: SessionScope): Promise<void> => {
    await act(async () => {
      root.render(createElement(GitLens, {
        scope: next, store, onOpenFile, onPreview: () => {}, selectedRef: null, visible: false,
      }))
    })
  }
  await render(scope)
  return { container, onOpenFile, render, unmount }
}

async function openMenu(container: HTMLDivElement): Promise<void> {
  const row = container.querySelector<HTMLButtonElement>('button[title="README.md"]')
  expect(row).not.toBeNull()
  await act(async () => {
    row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
  })
}

function editorItem(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find(item => item.textContent === t('openEditor'))
}

async function assertDenied(container: HTMLDivElement, onOpenFile: ReturnType<typeof vi.fn>): Promise<void> {
  await openMenu(container)
  expect(editorItem()).toBeUndefined()
  expect(menuAction.select).toBeDefined()
  await act(async () => { menuAction.select!('open') })
  expect(onOpenFile).not.toHaveBeenCalled()
}

beforeEach(() => { menuAction.select = undefined })
afterEach(async () => {
  try {
    while (disposers.length > 0) await disposers.pop()!()
  } finally {
    menuAction.select = undefined
    vi.restoreAllMocks()
  }
})

describe('GitLens Session-scoped editor navigation', () => {
  it('waits for POSIX Session cwd before opening a remote file from a Windows alias', async () => {
    const pending = pendingMetadata(REMOTE)
    const sessionCwd = vi.spyOn(api, 'sessionCwd').mockReturnValue(pending.promise)
    mockCheckout()
    const lens = await mountLens()
    expect(sessionCwd).toHaveBeenCalledWith(REMOTE, expect.any(AbortSignal))
    await assertDenied(lens.container, lens.onOpenFile)

    await act(async () => { pending.resolve(metadata(REMOTE)); await pending.promise })
    await openMenu(lens.container)
    expect(editorItem()).toBeDefined()
    await act(async () => { editorItem()!.click() })
    expect(lens.onOpenFile).toHaveBeenCalledExactlyOnceWith(`${CWD}/README.md`)
  })

  it('hides and refuses a selected external checkout even inside the metadata root', async () => {
    vi.spyOn(api, 'sessionCwd').mockResolvedValue(metadata(REMOTE))
    mockCheckout(CWD, '/srv/project/linked')
    const lens = await mountLens()
    expect(lens.container.querySelector<HTMLSelectElement>('select')!.value).toBe('/srv/project/linked')
    await assertDenied(lens.container, lens.onOpenFile)
  })

  it.each(['pending', 'error'] as const)('preserves fence=false editor navigation with %s metadata', async (state) => {
    const pending = pendingMetadata(REMOTE)
    vi.spyOn(api, 'sessionCwd').mockImplementation(() => state === 'pending'
      ? pending.promise : Promise.reject(new Error('metadata unavailable')))
    mockCheckout(CWD, '/srv/project/linked')
    const lens = await mountLens(REMOTE, false)
    await openMenu(lens.container)
    expect(editorItem()).toBeDefined()
    await act(async () => { editorItem()!.click() })
    expect(lens.onOpenFile).toHaveBeenCalledExactlyOnceWith('/srv/project/linked/README.md')
  })

  it.each(['C:/local/project', '/local/project'])('keeps contained local navigation for %s', async (cwd) => {
    const scope = { sessionId: 'local-session', cwd }
    vi.spyOn(api, 'sessionCwd').mockResolvedValue(metadata(scope, cwd))
    mockCheckout(cwd)
    const lens = await mountLens(scope)
    await openMenu(lens.container)
    expect(editorItem()).toBeDefined()
    await act(async () => { editorItem()!.click() })
    expect(lens.onOpenFile).toHaveBeenCalledExactlyOnceWith(`${cwd}/README.md`)
  })

  it.each(['pending', 'error'] as const)('fails closed on %s metadata even when the summary cwd would allow the path', async (state) => {
    const scope = { sessionId: 'local-session', cwd: CWD }
    const pending = pendingMetadata(scope)
    vi.spyOn(api, 'sessionCwd').mockImplementation(() => state === 'pending'
      ? pending.promise : Promise.reject(new Error('metadata unavailable')))
    mockCheckout()
    const lens = await mountLens(scope)
    await assertDenied(lens.container, lens.onOpenFile)
  })

  it('refuses metadata naming another Session', async () => {
    vi.spyOn(api, 'sessionCwd').mockResolvedValue({ ...metadata(REMOTE), sessionId: 'different-session' })
    mockCheckout()
    const lens = await mountLens()
    await assertDenied(lens.container, lens.onOpenFile)
  })

  it.each([
    { sessionId: 'other-session', cwd: ALIAS },
    { sessionId: REMOTE.sessionId, cwd: 'D:/remote-alias/other' },
  ])('aborts old metadata and ignores late replies after scope changes to $sessionId / $cwd', async (next) => {
    const old = pendingMetadata(REMOTE)
    const current = pendingMetadata(next)
    const requests: Array<{ scope: SessionScope; signal?: AbortSignal }> = []
    vi.spyOn(api, 'sessionCwd').mockImplementation((scope, signal) => {
      requests.push({ scope, signal })
      return requests.length === 1 ? old.promise : current.promise
    })
    mockCheckout()
    const lens = await mountLens()
    await lens.render(next)
    expect(requests).toHaveLength(2)
    expect(requests[0]!.signal?.aborted).toBe(true)
    expect(requests[1]!.scope).toEqual(next)
    expect(requests[1]!.signal?.aborted).toBe(false)
    await assertDenied(lens.container, lens.onOpenFile)
    await act(async () => { current.resolve(metadata(next, '/srv/other')); await current.promise })
    await act(async () => { old.resolve(metadata(REMOTE)); await old.promise })
    await assertDenied(lens.container, lens.onOpenFile)
  })

  it('invalidates already loaded metadata immediately when the summary cwd changes', async () => {
    const next = { ...REMOTE, cwd: 'D:/remote-alias/other' }
    const pending = pendingMetadata(next)
    vi.spyOn(api, 'sessionCwd').mockResolvedValueOnce(metadata(REMOTE)).mockReturnValue(pending.promise)
    mockCheckout()
    const lens = await mountLens()
    await openMenu(lens.container)
    expect(editorItem()).toBeDefined()
    await lens.render(next)
    await assertDenied(lens.container, lens.onOpenFile)
  })

  it.each(['scope change', 'unmount'] as const)('refuses a retained editor action after %s', async (change) => {
    const next = { ...REMOTE, cwd: 'D:/remote-alias/other' }
    const pending = pendingMetadata(next)
    vi.spyOn(api, 'sessionCwd').mockResolvedValueOnce(metadata(REMOTE)).mockReturnValue(pending.promise)
    mockCheckout()
    const lens = await mountLens()
    await openMenu(lens.container)
    expect(editorItem()).toBeDefined()
    const retainedAction = menuAction.select
    expect(retainedAction).toBeDefined()
    if (change === 'scope change') await lens.render(next)
    else await lens.unmount()
    await act(async () => { retainedAction!('open') })
    expect(lens.onOpenFile).not.toHaveBeenCalled()
  })

  it('aborts metadata on unmount and contains a late reply before a new mount', async () => {
    const pending = pendingMetadata(REMOTE)
    const sessionCwd = vi.spyOn(api, 'sessionCwd').mockReturnValueOnce(pending.promise)
      .mockRejectedValue(new Error('metadata unavailable'))
    mockCheckout()
    const lens = await mountLens()
    const signal = sessionCwd.mock.calls[0]![1]
    expect(signal?.aborted).toBe(false)
    await lens.unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => { pending.resolve(metadata(REMOTE)); await pending.promise })
    const nextLens = await mountLens()
    await assertDenied(nextLens.container, nextLens.onOpenFile)
    expect(lens.onOpenFile).not.toHaveBeenCalled()
  })
})
