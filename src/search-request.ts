/** Browser disconnects cancel traversal without releasing ownership of an unfinished remote request. */
import type { SidebarHttpRequest, SidebarHttpResponse } from './context-types.ts'

/** Observe one search request until its handler settles.
 * @param req Incoming HTTP body and cancellation events.
 * @param res Outgoing HTTP response and connection-close events.
 * @returns Caller signal and listener cleanup; cleanup does not cancel completed work.
 */
export function observeSearchRequest(req: SidebarHttpRequest, res: SidebarHttpResponse): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const cancel = () => { controller.abort() }
  const close = () => { if (!res.writableEnded) cancel() }
  req.on?.('aborted', cancel)
  res.on?.('close', close)
  if (req.aborted || res.destroyed) cancel()
  return {
    signal: controller.signal,
    dispose() { req.off?.('aborted', cancel); res.off?.('close', close) },
  }
}
