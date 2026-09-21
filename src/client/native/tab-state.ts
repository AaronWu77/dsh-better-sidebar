/**
 * Cross-reload memory for native right-Sidebar tabs.
 *
 * DSH's native panel persists one record per tab as {id, kind, contentId,
 * title} and nothing else (see @deepseek-ai/dsh-client-ui-sidebar-right's
 * persistence): after a page reload or a host restart the plugin's synthetic
 * record is re-minted from the ADDRESS alone, so a browser tab loses its URL,
 * a side chat loses its thread (and mints a fresh empty one), and a diff tab
 * loses its reference. The native tab id IS part of the persisted layout, so a
 * small plugin-owned document keyed by session + tab id restores those views.
 *
 * The document lives in localStorage under its own namespace; storage failures
 * (unavailable, quota, malformed JSON) degrade to "no memory" rather than
 * throwing into the render path.
 */
import type { SidebarTab } from '../state.ts'

/** The record fields worth restoring, mirrored from the native tab id. */
export interface NativeTabMemory {
  path?: string
  title?: string
  meta?: unknown
  diff?: SidebarTab['diff']
}

/** The plugin's durable memory of native tab state. */
export interface NativeTabStateStore {
  /** The remembered state for one native tab, if any. */
  recall(sessionId: string, tabId: string): NativeTabMemory | undefined
  /** Remember (or refresh) one native tab's state. */
  remember(sessionId: string, tabId: string, memory: NativeTabMemory): void
  /** Forget one native tab (it closed). */
  forget(sessionId: string, tabId: string): void
}

/** localStorage namespace of the native-tab memory. */
export const NATIVE_TAB_STATE_KEY = 'dsh-better-sidebar.native-tabs.v1'

/** One entry larger than this is not remembered (a huge diff stays transient). */
const MAX_ENTRY_BYTES = 65_536

/** The whole document stops growing here; other sessions' entries are dropped first. */
const MAX_DOCUMENT_BYTES = 1_048_576

type Document = Record<string, Record<string, NativeTabMemory>>

/** Strip undefined fields so an empty memory never shadows a later seed. */
function compact(memory: NativeTabMemory): NativeTabMemory {
  return {
    ...(memory.path === undefined ? {} : { path: memory.path }),
    ...(memory.title === undefined ? {} : { title: memory.title }),
    ...(memory.meta === undefined ? {} : { meta: memory.meta }),
    ...(memory.diff === undefined ? {} : { diff: memory.diff }),
  }
}

/**
 * Create the memory store over localStorage.
 * @returns the store; every operation is a safe no-op when storage is unavailable.
 */
export function createNativeTabStateStore(): NativeTabStateStore {
  let document: Document | undefined
  const read = (): Document => {
    if (document !== undefined) return document
    document = {}
    if (typeof localStorage === 'undefined') return document
    try {
      const raw = localStorage.getItem(NATIVE_TAB_STATE_KEY)
      const parsed: unknown = raw === null ? undefined : JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [sessionId, entries] of Object.entries(parsed as Document)) {
          if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) continue
          const kept: Record<string, NativeTabMemory> = {}
          for (const [tabId, memory] of Object.entries(entries)) {
            if (memory === null || typeof memory !== 'object' || Array.isArray(memory)) continue
            kept[tabId] = compact(memory)
          }
          document[sessionId] = kept
        }
      }
    } catch (_unreadable) {
      // A malformed or unreadable document is simply forgotten.
    }
    return document
  }
  const write = (sessionId: string): void => {
    if (typeof localStorage === 'undefined') return
    const entries = read()
    let payload = entries
    let serialized = JSON.stringify(payload)
    if (serialized.length > MAX_DOCUMENT_BYTES) {
      // Keep the session being written; drop the other sessions' memory first.
      payload = { [sessionId]: entries[sessionId] ?? {} }
      serialized = JSON.stringify(payload)
      document = payload
      if (serialized.length > MAX_DOCUMENT_BYTES) return
    }
    try {
      localStorage.setItem(NATIVE_TAB_STATE_KEY, serialized)
    } catch (_unwritable) {
      // Quota or a storage-blocked context: memory is best-effort.
    }
  }
  return {
    recall(sessionId, tabId) {
      return read()[sessionId]?.[tabId]
    },
    remember(sessionId, tabId, memory) {
      const entries = read()
      const kept = compact(memory)
      const encoded = JSON.stringify(kept)
      if (encoded.length > MAX_ENTRY_BYTES) {
        delete entries[sessionId]?.[tabId]
        return
      }
      entries[sessionId] = { ...entries[sessionId], [tabId]: kept }
      write(sessionId)
    },
    forget(sessionId, tabId) {
      const entries = read()
      const session = entries[sessionId]
      if (session === undefined || session[tabId] === undefined) return
      delete session[tabId]
      if (Object.keys(session).length === 0) delete entries[sessionId]
      write(sessionId)
    },
  }
}
