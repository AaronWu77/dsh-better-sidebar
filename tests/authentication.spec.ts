import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/index.ts'
import { browserAdmission } from '../src/authentication.ts'
import type { SidebarHttpRequest, SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'

function mount(principal?: string) {
  const routes: SidebarWebRoute[] = []
  const upgrades: SidebarWebUpgradeRoute[] = []
  const effects: (() => void)[] = []
  const sessionRead = vi.fn(() => undefined)
  const connection = {
    ...(principal === undefined ? {} : { admit: () => ({ peer: { principal: { kind: principal } } }) }),
    requestRejection: vi.fn((request: SidebarHttpRequest): 401 | 403 | undefined => {
      if (request.headers['sec-fetch-site'] === 'cross-site') return 403
      return request.headers.cookie === 'session=valid' ? undefined : 401
    }),
  }
  const ctx = {
    webServer: {
      register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
      registerUpgrade: (route: SidebarWebUpgradeRoute) => { upgrades.push(route); return () => {} },
    },
    sessions: { get: sessionRead },
    tools: { register: () => () => {} },
    effect: (setup: () => void | (() => void)) => { const dispose = setup(); if (typeof dispose === 'function') effects.push(dispose) },
    inject: () => () => {},
    on: () => () => {},
    get: (key: string) => key === 'connection' ? connection : undefined,
  }
  apply({ ...ctx, provide: () => () => {} } as never)
  return { routes, upgrades, sessionRead, connection, dispose: () => { for (const effect of effects.reverse()) effect() } }
}

function request(url: string, cookie?: string, crossSite = false) {
  const consume = vi.fn()
  const req: SidebarHttpRequest = {
    method: 'POST', url,
    headers: { host: '127.0.0.1:3080', cookie, 'sec-fetch-site': crossSite ? 'cross-site' : 'same-origin' },
    async *[Symbol.asyncIterator]() { consume(); yield '{}' },
  }
  return { req, consume }
}

function response() {
  const result = { status: 0, body: '' }
  return {
    result,
    res: {
      statusCode: 0,
      writeHead(status: number) { result.status = status },
      end(body?: string | Uint8Array) { if (body !== undefined) result.body = Buffer.from(body).toString() },
    },
  }
}

describe('sidebar browser authentication', () => {
  it('requires only services supplied by the alpha2 Web profile', () => {
    expect(inject).toEqual(['webServer', 'sessions', 'tools', 'connection'])
  })
  it.each([undefined, 'session=invalid', 'session=expired'])('refuses every HTTP entry before reading the request or resolving a session (%s)', async cookie => {
    const f = mount()
    try {
      expect(f.routes.map(route => route.path).sort()).toEqual(['/sidebar/api', '/sidebar/bundle', '/sidebar/file', '/sidebar/html', '/sidebar/upload'])
      for (const route of f.routes) {
        const r = request(route.path, cookie)
        const reply = response()
        await route.handler(r.req, reply.res)
        expect(reply.result.status, route.path).toBe(401)
        expect(r.consume, route.path).not.toHaveBeenCalled()
      }
      expect(f.sessionRead).not.toHaveBeenCalled()
    } finally { f.dispose() }
  })

  it('preserves the host cross-site refusal even with a valid login', async () => {
    const f = mount()
    try {
      for (const route of f.routes) {
        const r = request(route.path, 'session=valid', true)
        const reply = response()
        await route.handler(r.req, reply.res)
        expect(reply.result.status, route.path).toBe(403)
        expect(r.consume).not.toHaveBeenCalled()
      }
      expect(f.sessionRead).not.toHaveBeenCalled()
    } finally { f.dispose() }
  })

  it.each([undefined, 'session=invalid', 'session=expired'])('refuses all three WebSocket handshakes before allocating resources (%s)', cookie => {
    const f = mount()
    try {
      expect(f.upgrades).toHaveLength(3)
      for (const route of f.upgrades) {
        const r = request(route.path, cookie)
        const socket = { end: vi.fn(), destroy: vi.fn() }
        route.handler(r.req, socket, new Uint8Array())
        expect(socket.end).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 401 Unauthorized'))
      }
      expect(f.sessionRead).not.toHaveBeenCalled()
    } finally { f.dispose() }
  })

  it('keeps authenticated diagnostic requests usable', async () => {
    const f = mount()
    try {
      const route = f.routes.find(row => row.path === '/sidebar/api')!
      const r = request('/sidebar/api/terminal.deps', 'session=valid')
      const reply = response()
      await route.handler(r.req, reply.res)
      expect(reply.result.status).toBe(200)
      expect(JSON.parse(reply.result.body).ok).toBe(true)
      expect(f.connection.requestRejection).toHaveBeenCalledWith(r.req)
    } finally { f.dispose() }
  })

  it('rejects a future non-owner Peer on every raw HTTP and WS entry before effects', async () => {
    const f = mount('future-non-owner')
    try {
      for (const route of f.routes) {
        const r = request(route.path, 'session=valid')
        const reply = response()
        await route.handler(r.req, reply.res)
        expect(reply.result.status, route.path).toBe(403)
        expect(r.consume).not.toHaveBeenCalled()
      }
      for (const route of f.upgrades) {
        const socket = { end: vi.fn(), destroy: vi.fn() }
        route.handler(request(route.path, 'session=valid').req, socket, new Uint8Array())
        expect(socket.end).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 403 Forbidden'))
      }
      expect(f.sessionRead).not.toHaveBeenCalled()
    } finally { f.dispose() }
  })

  it('admits an owner Peer without weakening the existing trust fence', () => {
    const connection = { requestRejection: () => undefined, admit: () => ({ peer: { principal: { kind: 'owner' } } }) }
    expect(browserAdmission({ get: () => connection } as never)(request('/sidebar/api').req)).toBeUndefined()
  })

  it('requires host authentication rather than falling back to a trust-only fence', () => {
    expect(() => browserAdmission({ get: () => undefined } as never)).toThrow('requires connection.requestRejection')
    expect(() => browserAdmission({ get: () => ({}) } as never)).toThrow('requires connection.requestRejection')
  })
})
