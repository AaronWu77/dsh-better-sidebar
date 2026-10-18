import { describe, expect, it, vi } from 'vitest'
import { browserAdmission, rejectSidebarHttp, rejectSidebarUpgrade } from '../src/authentication.ts'
import { connectionFixture, hostRoot } from './rc2-connection-fixture.ts'
import type { SidebarHttpRequest } from '../src/context-types.ts'

// Opt-in only: no production profile, listener, SSH or provider is touched.
describe.skipIf(!hostRoot)('rc.2 built Connection with Sidebar raw admission', () => {
  const request = (headers: SidebarHttpRequest['headers']): SidebarHttpRequest => ({ headers, async *[Symbol.asyncIterator]() {} })
  it('admits browser and live owner API credentials, including API HTTP before socket attachment', async () => {
    const f = await connectionFixture()
    try {
      const admission = browserAdmission({ get: () => f.connection } as never)
      for (const headers of [f.browser(), f.api()]) {
        const req = request(headers)
        expect(f.connection.requestRejection(req)).toBeUndefined()
        expect(f.connection.admit(req)).toMatchObject({ peer: { principal: { kind: 'owner' } } })
        expect(admission(req)).toBeUndefined()
      }
    } finally { await f.dispose() }
  })
  it('rejects anonymous, bad Origin and bad authority before resource/upgrade effects', async () => {
    const f = await connectionFixture()
    try {
      const admission = browserAdmission({ get: () => f.connection } as never)
      const cookie = f.browser()
      for (const [headers, status] of [[f.headers(), 401], [{ ...cookie, origin: 'http://evil.invalid' }, 403], [{ ...cookie, host: 'evil.invalid' }, 403]] as const) {
        const req = request(headers)
        const res = { writeHead: vi.fn(), end: vi.fn() }
        expect(rejectSidebarHttp(admission, req, res as never)).toBe(true)
        expect(res.writeHead).toHaveBeenCalledWith(status, expect.anything())
        const socket = { end: vi.fn(), destroy: vi.fn() }
        expect(rejectSidebarUpgrade(admission, req, socket)).toBe(true)
        expect(socket.end).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 ' + status))
      }
    } finally { await f.dispose() }
  })
  it('does not revive a released API Peer using its still-signed credential', async () => {
    const f = await connectionFixture()
    try {
      const req = request(f.api())
      const admission = browserAdmission({ get: () => f.connection } as never)
      const socket = f.connection.admitConnection(req)
      if ('rejection' in socket) throw new Error('fixture API socket rejected')
      expect(admission(req)).toBeUndefined()
      await socket.release()
      expect(f.connection.requestRejection(req)).toBe(401)
      expect(admission(req)).toBe(401)
    } finally { await f.dispose() }
  })
  it('rejects retained browser and API credentials after Connection disposal', async () => {
    const f = await connectionFixture()
    const admission = browserAdmission({ get: () => f.connection } as never)
    const requests = [request(f.browser()), request(f.api())]
    await f.dispose()
    for (const req of requests) expect(admission(req)).toBe(401)
  })
})
