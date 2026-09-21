/**
 * The plugin's write face over DSH's native right Sidebar (`ctx.sidebarRight`).
 *
 * The service speaks in the plugin's own vocabulary (tab type, seed, session
 * scope); this module turns those into the native surface's vocabulary
 * (kind + navigation params, or a `dsh-resource://` address) and forwards
 * tab-record operations to the plugin's native record registry.
 *
 * Two native limits shape the implementation:
 *
 * - the surface exists only while a session's panel is mounted, and the
 *   service's public face (`ISidebarRight`) writes only into THAT session.
 *   The controller also carries `openTabIn` / `openResourceIn` /
 *   `closeIn`, which act on any session whose store the runtime has minted;
 *   both are probed at call time, and an open for a session that has no
 *   store yet is QUEUED and replayed when that session comes on screen;
 * - layout state is memory-only, so a queued open is not durable either.
 */
import type { Context } from '../../context-types.ts'
import { fileAddressFor, parseFileAddress } from '../resource-address.ts'
import type { NativeTabParams, SidebarSurface } from '../service.ts'
import type { NativeTabRecords } from './tab-adapter.tsx'

/** One open the surface could not place yet. */
type Pending =
  | { kind: 'tab'; sessionId: string; tabKind: string; params: NativeTabParams; revealIfOpened: boolean; preferNewPane: boolean }
  | { kind: 'resource'; sessionId: string; address: string; line: number | undefined; params: NativeTabParams | undefined; revealIfOpened: boolean; preferNewPane: boolean; replaceTab?: string }

/** The controller face this module uses (a structural slice of `ISidebarRight`). */
interface NativeController {
  openTab(kind: string, options?: { params?: unknown; revealIfOpened?: boolean; preferNewPane?: boolean }): void
  openResource(address: string, options?: { params?: unknown; revealIfOpened?: boolean; preferNewPane?: boolean; replaceTab?: string }): void
  close(tabId: string): void
  /** Not part of `ISidebarRight`: the concrete controller's per-session writes. */
  openTabIn?(sessionId: string, kind: string, options?: { params?: unknown; revealIfOpened?: boolean; preferNewPane?: boolean }): void
  openResourceIn?(sessionId: string, address: string, options?: { params?: unknown; revealIfOpened?: boolean; preferNewPane?: boolean; replaceTab?: string }): void
  closeIn?(sessionId: string, tabId: string): void
}

/** The plugin's write face over the native surface. */
export interface NativeSurface extends SidebarSurface {
  /** Replay opens that were queued for a session that had no mounted surface. */
  flushPending(): void
  /** Stop observing the session list. */
  dispose(): void
}

/** The active session id, as the client list reports it. */
function activeSessionId(ctx: Context): string | undefined {
  try {
    return ctx.sessions.list.getSnapshot().current
  } catch {
    return undefined
  }
}

/**
 * Bind the plugin's write face to the native controller.
 * @param ctx - the client context (session list + `ctx.sidebarRight`).
 * @param records - the plugin's native tab record registry.
 * @returns the surface, plus a disposer unbinding its session subscription.
 */
export function createNativeSurface(ctx: Context, records: NativeTabRecords): NativeSurface {
  const pending: Pending[] = []
  const controller = (): NativeController | undefined =>
    ctx.get('sidebarRight') as unknown as NativeController | undefined

  const place = (entry: Pending): boolean => {
    const api = controller()
    if (api === undefined) return false
    const active = activeSessionId(ctx)
    const onScreen = active !== undefined && active === entry.sessionId
    if (entry.kind === 'tab') {
      const options = {
        params: entry.params,
        revealIfOpened: entry.revealIfOpened,
        ...entry.preferNewPane ? { preferNewPane: true } : {},
      }
      if (onScreen) {
        api.openTab(entry.tabKind, options)
        return true
      }
      if (api.openTabIn !== undefined) {
        api.openTabIn(entry.sessionId, entry.tabKind, options)
        return true
      }
      return false
    }
    const options = {
      ...(entry.line === undefined && entry.params === undefined
        ? {}
        : { params: { ...(entry.line === undefined ? {} : { line: entry.line }), ...entry.params } }),
      revealIfOpened: entry.revealIfOpened,
      ...entry.preferNewPane ? { preferNewPane: true } : {},
      ...entry.replaceTab === undefined ? {} : { replaceTab: entry.replaceTab },
    }
    if (onScreen) {
      api.openResource(entry.address, options)
      return true
    }
    if (api.openResourceIn !== undefined) {
      api.openResourceIn(entry.sessionId, entry.address, options)
      return true
    }
    return false
  }

  const flushPending = (): void => {
    if (pending.length === 0) return
    for (let index = pending.length - 1; index >= 0; index--) {
      const entry = pending[index]
      if (entry !== undefined && place(entry)) pending.splice(index, 1)
    }
  }

  const enqueue = (entry: Pending): void => {
    if (!place(entry)) pending.push(entry)
  }

  const unsubscribe = ctx.sessions.list.subscribe(flushPending)
  const openTab: NativeSurface['openTab'] = ({ sessionId, kind, params, revealIfOpened, preferNewPane = false }) => {
    enqueue({ kind: 'tab', sessionId, tabKind: kind, params, revealIfOpened, preferNewPane })
  }
  const openResource: NativeSurface['openResource'] = ({ sessionId, address, line, params, revealIfOpened, preferNewPane = false, replaceTab }) => {
    enqueue({
      kind: 'resource',
      sessionId,
      address,
      line,
      params,
      revealIfOpened,
      preferNewPane,
      ...(replaceTab === undefined ? {} : { replaceTab }),
    })
  }

  return {
    openTab,
    openResource,
    fileAddress(sessionId, cwd, path) {
      return fileAddressFor(sessionId, cwd, path)
    },
    close(sessionId, tabId) {
      const record = records.get(tabId)
      if (record === undefined) return undefined
      records.drop(tabId)
      const api = controller()
      if (api !== undefined) {
        if (sessionId === activeSessionId(ctx)) api.close(tabId)
        else if (api.closeIn !== undefined) api.closeIn(sessionId, tabId)
      }
      return { type: record.tab.type, title: record.tab.title }
    },
    update(tabId, patch) {
      if (!records.has(tabId)) return false
      // A path change on an ADDRESS-BACKED tab (a file resource) cannot be
      // written into the record: the address re-seeds `path` on every
      // render, so the write would snap straight back (rename retarget,
      // merged-mode file switch). Take the tab's place instead — the
      // native panel closes the old tab and opens the new address in the
      // same pane and strip slot — carrying the record's meta so the
      // editor keeps its dock state.
      if (patch.path !== undefined && records.get(tabId)?.tab.path !== patch.path) {
        const address = records.addressOf(tabId)
        const scope = records.scopeOf(tabId)
        if (address !== undefined && scope !== undefined && parseFileAddress(address) !== undefined) {
          const next = fileAddressFor(scope.sessionId, scope.cwd, patch.path)
          if (next !== address) {
            const meta = records.get(tabId)?.tab.meta
            openResource({
              sessionId: scope.sessionId,
              address: next,
              revealIfOpened: false,
              replaceTab: tabId,
              ...(patch.title === undefined && meta === undefined
                ? {}
                : { params: { ...patch.title === undefined ? {} : { title: patch.title }, ...meta === undefined ? {} : { meta } } }),
            })
            return true
          }
        }
      }
      records.update(tabId, patch)
      return true
    },
    activate(tabId) {
      // The native surface has no cross-pane activation face the plugin needs:
      // a tab is focused by opening its (kind, address) again, which the
      // native open already de-duplicates.
      return records.has(tabId)
    },
    has: tabId => records.has(tabId),
    openTabs: () => records.openTabs(),
    flushPending,
    dispose: () => { unsubscribe() },
  }
}
