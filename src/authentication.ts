/** Browser admission shared by every sidebar HTTP route and WebSocket handshake. */
import type { Context, SidebarHttpRequest, SidebarHttpResponse, SidebarUpgradeSocket } from './context-types.ts'
import { writeJson } from './wire.ts'

/** A host rejection preserves the distinction between missing login and an untrusted request. */
export type SidebarRequestRejection = (request: SidebarHttpRequest) => 401 | 403 | undefined

interface BrowserAuthentication {
  requestRejection: SidebarRequestRejection
}

/** Require the host's authenticated browser admission service before registering routes.
 * @param ctx Host context with the required connection injection.
 * @returns A per-request admission check using the host's current authentication policy.
 */
export function browserAdmission(ctx: Context): SidebarRequestRejection {
  const connection = ctx.get('connection') as BrowserAuthentication | undefined
  if (connection === undefined || typeof connection.requestRejection !== 'function') {
    throw new Error('dsh-better-sidebar requires connection.requestRejection for authenticated browser access')
  }
  return request => connection.requestRejection(request)
}

/** Refuse an HTTP request before reading its body or resolving any session or file.
 * @param admission Host admission check.
 * @param request Incoming request.
 * @param response Response that receives the rejection.
 * @returns Whether the request was rejected and the response completed.
 */
export function rejectSidebarHttp(admission: SidebarRequestRejection, request: SidebarHttpRequest, response: SidebarHttpResponse): boolean {
  const status = admission(request)
  if (status === undefined) return false
  const code = status === 401 ? 'unauthorized' : 'forbidden'
  writeJson(response, status, { ok: false, error: { code, message: code } })
  return true
}

/** Refuse a WebSocket handshake before allocating a terminal or consuming a subscription.
 * @param admission Host admission check.
 * @param request Upgrade request.
 * @param socket Socket closed without performing the upgrade.
 * @returns Whether the handshake was rejected.
 */
export function rejectSidebarUpgrade(admission: SidebarRequestRejection, request: SidebarHttpRequest, socket: SidebarUpgradeSocket): boolean {
  const status = admission(request)
  if (status === undefined) return false
  socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  return true
}
