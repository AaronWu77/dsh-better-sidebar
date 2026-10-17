/** Terminal tab labels follow the selected Session rather than the host process shell. */
import type { BetterSidebarService } from './service.ts'
import { allLeaves, isAgentTabId } from './state.ts'

/** Observe Session changes with stale-result suppression and owned unsubscription.
 * @param service Sidebar state and tab operations.
 * @param fallback Localized generic terminal label while metadata is unavailable.
 * @param readShell Session-specific host metadata request.
 * @param setTitle Default title used by newly created tabs.
 * @returns Disposer that also invalidates pending responses.
 */
export function subscribeTerminalTitle(service: BetterSidebarService, fallback: string, readShell: (sessionId: string) => Promise<{ name: string }>, setTitle: (name: string) => void): () => void {
  let initialized = false
  let selectedSessionId: string | undefined
  let revision = 0
  let disposed = false
  const refresh = (): void => {
    const sessionId = service.getSnapshot().sessionId
    if (initialized && sessionId === selectedSessionId) return
    initialized = true
    selectedSessionId = sessionId
    const current = ++revision
    setTitle(fallback)
    if (sessionId === undefined) return
    void readShell(sessionId).then(({ name }) => {
      if (disposed || current !== revision || service.getSnapshot().sessionId !== sessionId) return
      setTitle(name)
      const snapshot = service.getSnapshot()
      if (snapshot.state === undefined) return
      const tabs = allLeaves(snapshot.state.bottomSplits).flatMap(leaf => leaf.tabs)
      for (const tab of tabs) {
        if (tab.type === 'terminal' && !isAgentTabId(tab.id) && tab.title === fallback) service.updateTab(tab.id, { title: name })
      }
    }).catch((_error) => { /* Metadata failure retains the localized title, not another host's shell. */ })
  }
  const unsubscribe = service.subscribeState(refresh)
  refresh()
  return () => { disposed = true; revision++; unsubscribe() }
}
