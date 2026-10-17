import { posix } from 'node:path'
import { EventEmitter } from 'node:events'
import { deferred } from './deferred.ts'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import type { SidebarHttpRequest, SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'
import type { SidebarRemoteWorkspace } from '../src/workspace-provider.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).reverse().map(dispose => dispose()))
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length) throw new AggregateError(failures, 'workspace route fixture cleanup')
})

async function fixture() {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const routes: SidebarWebRoute[] = []
  ctx.provide('webServer', {
    register: (route: SidebarWebRoute) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } },
    registerUpgrade: (_route: SidebarWebUpgradeRoute) => () => {},
  })
  ctx.provide('webRuntime', { trustedHosts: [] })
  ctx.provide('connection', { requestRejection: () => undefined })
  ctx.provide('sessions', { get: () => ({ header: { cwd: '/authoritative' }, snapshotEvents: () => [] }) })
  ctx.provide('tools', { register: () => () => {} })
  const removeManager = ctx.provide('remoteSshManager', {})
  const fork = ctx.plugin({ name: 'sidebar-route-consumer', apply: pluginCtx => apply(pluginCtx as never) })
  await fork.await()
  const fs: SidebarRemoteWorkspace['fs'] = {
    resolve: vi.fn(async path => path),
    exists: vi.fn(async () => true),
    list: vi.fn(async path => ({ path, entries: [], truncated: false })),
    read: vi.fn(async () => ({ content: 'remote editor', binary: false, truncated: false, size: 13 })),
    readBytes: vi.fn(async () => new Uint8Array([0, 255, 80, 68, 70])),
    write: vi.fn(async () => {}),
    upload: vi.fn(async input => ({ path: posix.join(input.dir, input.relativePath), size: 3 })),
    rename: vi.fn(async (path, name) => ({ path: posix.join(posix.dirname(path), name) })),
    remove: vi.fn(async path => ({ path })),
    search: vi.fn(async (_query: string, _signal?: AbortSignal) => ({ matches: ['remote.txt'], truncated: false })),
  }
  const run = vi.fn(async (_cwd: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/srv/remote\n'
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'remote-main\n'
    if (args[0] === 'status') return '?? remote.txt\0'
    return ''
  })
  const workspace: SidebarRemoteWorkspace = {
    kind: 'remote', cwd: '/srv/remote', fs, terminalExecutable: '/bin/bash',
    paths: { absolute: posix.normalize, join: posix.join, dirname: posix.dirname, basename: posix.basename, isAbsolute: posix.isAbsolute },
    git: { run, listDirectories: async () => [], joinPath: posix.join, pathIdentity: posix.normalize },
    createTerminal: async () => { throw new Error('terminal allocation must not be requested by filesystem routes') },
  }
  const router = vi.fn(async () => workspace)
  const disposeRouter = ctx.sidebarWorkspaceProviders.registerRouter(router)
  return { ctx, fork, routes, fs, run, router, disposeRouter, removeManager }
}

async function request(routes: SidebarWebRoute[], url: string, payload?: unknown) {
  const reply = { status: 0, headers: {} as Record<string, string | number>, body: new Uint8Array(0) }
  const route = routes.find(candidate => url.startsWith(candidate.path))
  if (!route) throw new Error('route not mounted: ' + url)
  const req: SidebarHttpRequest = {
    url, method: payload === undefined && !url.startsWith('/sidebar/upload') ? 'GET' : 'POST', headers: {},
    async *[Symbol.asyncIterator]() { yield payload === undefined ? 'abc' : JSON.stringify(payload) },
  }
  await route.handler(req, {
    statusCode: 200,
    writeHead(status, headers) { reply.status = status; reply.headers = headers ?? {} },
    end(body) { reply.body = typeof body === 'string' ? new TextEncoder().encode(body) : body === undefined ? new Uint8Array(0) : Uint8Array.from(body) },
  })
  return reply
}

async function api(routes: SidebarWebRoute[], method: string, payload: Record<string, unknown> = {}) {
  const result = await request(routes, '/sidebar/api/' + method, { sessionId: 'scope', cwd: 'C:\\not-authority', ...payload })
  return { status: result.status, ...JSON.parse(new TextDecoder().decode(result.body)) as { ok: boolean; value?: unknown; error?: { code: string } } }
}

describe('sidebar workspace provider consumers', () => {
  it('selects authority before provider routing and preserves POSIX cwd fields', async () => {
    const f = await fixture()
    expect(await api(f.routes, 'session.cwd')).toMatchObject({ ok: true, value: { cwd: '/srv/remote', root: 'remote', parent: '/srv' } })
    expect(f.router).toHaveBeenCalledWith({ sessionId: 'scope', cwd: '/authoritative' })
  })

  it('returns the configured remote shell for Session metadata without allocating a terminal', async () => {
    const f = await fixture()
    expect(await api(f.routes, 'shell.get')).toMatchObject({ status: 200, ok: true, value: { shell: '/bin/bash', name: 'bash' } })
    expect(f.router).toHaveBeenCalledWith({ sessionId: 'scope', cwd: '/authoritative' })
    f.disposeRouter()
    expect(await api(f.routes, 'shell.get')).toMatchObject({ status: 503, ok: false })
  })

  it('routes all filesystem APIs through the remote provider without touching local paths', async () => {
    const f = await fixture()
    expect((await api(f.routes, 'fs.tree')).ok).toBe(true)
    expect(await api(f.routes, 'fs.search', { query: 'remote' })).toMatchObject({ status: 200, ok: true, value: { matches: ['remote.txt'], truncated: false } })
    expect(f.fs.search).toHaveBeenCalledWith('remote', expect.any(AbortSignal))
    expect(await api(f.routes, 'fs.read', { path: 'remote.txt' })).toMatchObject({ ok: true, value: { kind: 'text', content: 'remote editor' } })
    expect((await api(f.routes, 'fs.write', { path: '/srv/remote/new.txt', content: 'value' })).ok).toBe(true)
    expect((await api(f.routes, 'fs.rename', { path: '/srv/remote/new.txt', name: 'renamed.txt' })).ok).toBe(true)
    expect((await api(f.routes, 'fs.remove', { path: '/srv/remote/renamed.txt' })).ok).toBe(true)
    expect(f.fs.list).toHaveBeenCalledWith('/srv/remote', expect.any(Number), true)
    expect(f.fs.read).toHaveBeenCalledWith('/srv/remote/remote.txt', expect.any(Number), true)
    expect(f.fs.write).toHaveBeenCalledWith('/srv/remote/new.txt', 'value', true)
    expect(f.fs.rename).toHaveBeenCalledWith('/srv/remote/new.txt', 'renamed.txt', true)
    expect(f.fs.remove).toHaveBeenCalledWith('/srv/remote/renamed.txt', true)
  })

  it('forwards browser cancellation to search, awaits provider settlement and never writes a late reply', async () => {
    const f = await fixture(), entered = deferred<void>(), release = deferred<void>()
    let signal: AbortSignal | undefined
    vi.mocked(f.fs.search).mockImplementation(async (_query, caller) => {
      signal = caller; entered.resolve(); await release.promise
      caller?.throwIfAborted()
      return { matches: [], truncated: false }
    })
    const req = Object.assign(new EventEmitter(), {
      url: '/sidebar/api/fs.search', method: 'POST', headers: {},
      async *[Symbol.asyncIterator]() { yield JSON.stringify({ sessionId: 'scope', query: 'remote' }) },
    })
    const res = Object.assign(new EventEmitter(), { statusCode: 200, writableEnded: false, writeHead: vi.fn(), end: vi.fn() })
    let settled = false
    const handling = f.routes.find(route => route.path === '/sidebar/api')!.handler(req, res)
    const done = Promise.resolve(handling).then(() => { settled = true })
    cleanups.push(async () => { release.resolve(); await done })
    await entered.promise; res.emit('close')
    expect(signal?.aborted).toBe(true); expect(settled).toBe(false)
    release.resolve(); await done
    expect(res.end).not.toHaveBeenCalled()
    expect(req.listenerCount('aborted')).toBe(0); expect(res.listenerCount('close')).toBe(0)
  })

  it('uses remote bytes for media, downloads, HTML assets and remote uploads', async () => {
    const f = await fixture()
    const media = await request(f.routes, '/sidebar/file?sessionId=scope&path=photo.png&download=1')
    expect(media.status).toBe(200)
    expect(media.body).toEqual(new Uint8Array([0, 255, 80, 68, 70]))
    expect(media.headers['content-type']).toBe('image/png')
    const html = await request(f.routes, '/sidebar/html/scope/' + encodeURIComponent('/srv/remote/index.html'))
    expect(html.status).toBe(200)
    expect(html.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(html.headers['content-security-policy']).toContain('sandbox')
    const upload = await request(f.routes, '/sidebar/upload?sessionId=scope&dir=%2Fsrv%2Fremote&relativePath=new.txt')
    expect(upload.status).toBe(200)
    expect(f.fs.upload).toHaveBeenCalledWith(expect.objectContaining({ dir: '/srv/remote', relativePath: 'new.txt', fence: true }))
  })

  it('uses the selected host for Git status and mutations', async () => {
    const f = await fixture()
    expect(await api(f.routes, 'git.status', { repoRoot: '/srv/remote' })).toMatchObject({ ok: true, value: { branch: 'remote-main', root: '/srv/remote', entries: [{ path: 'remote.txt' }] } })
    expect((await api(f.routes, 'git.stage', { repoRoot: '/srv/remote', path: 'remote.txt' })).ok).toBe(true)
    expect(f.run).toHaveBeenCalledWith('/srv/remote', ['add', '-A', '--', 'remote.txt'], expect.any(Number))
  })

  it('rejects unknown repository selection without dispatching mutation', async () => {
    const f = await fixture()
    expect(await api(f.routes, 'git.stage', { repoRoot: '/other-host-root', path: 'remote.txt' })).toMatchObject({ ok: false })
    expect(f.run.mock.calls.some(call => call[1][0] === 'add')).toBe(false)
  })

  it('refuses missing remote integration after contribution removal rather than reading locally', async () => {
    const f = await fixture()
    f.disposeRouter()
    expect(await api(f.routes, 'fs.tree')).toMatchObject({ status: 503, ok: false, error: { code: 'workspace-unavailable' } })
    expect(f.fs.list).not.toHaveBeenCalled()
  })

  it('refuses remote filesystem and shell metadata after manager and router unload', async () => {
    const f = await fixture()
    f.disposeRouter()
    await f.removeManager()
    expect(f.ctx.get('remoteSshManager')).toBeUndefined()
    expect(await api(f.routes, 'fs.write', { path: '/authoritative/file', content: 'must not reach local' })).toMatchObject({ status: 503, ok: false, error: { code: 'workspace-unavailable' } })
    expect(await api(f.routes, 'shell.get')).toMatchObject({ status: 503, ok: false })
    expect(f.fs.write).not.toHaveBeenCalled()
  })

  it('removes the provided workspace service and routes when its real fiber is disposed', async () => {
    const f = await fixture()
    expect(f.ctx.get('sidebarWorkspaceProviders')).toBeDefined()
    await f.fork.dispose()
    expect(f.ctx.get('sidebarWorkspaceProviders')).toBeUndefined()
    expect(f.routes).toEqual([])
  })
})
