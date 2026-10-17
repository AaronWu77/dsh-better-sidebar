/** Persistent remote output, allocation ownership, acknowledged tools and browser attachments. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { WebSocket, WebSocketServer } from 'ws'
import { validateJsonSchemaValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteTerminalRegistry, TERMINAL_TRANSCRIPT_LIMIT } from '../src/remote-terminal-registry.ts'
import { AgentPtyRegistry } from '../src/agent-pty.ts'
import { registerTools } from '../src/tools.ts'
import { apply } from '../src/index.ts'
import * as dependencies from '../src/pty-deps.ts'
import type { SidebarBackendTerminal, SidebarRemoteWorkspace } from '../src/workspace-provider.ts'
import type { SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  const results = await Promise.allSettled(cleanups.splice(0).reverse().map(cleanup => cleanup()))
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, 'remote terminal fixture cleanup failed')
})

function backend() {
  const queue: Uint8Array[] = []
  let ready = deferred<void>()
  let ended = false
  const done = deferred<{ exitCode: number | null; signal?: string | null }>()
  const quiescent = deferred<void>()
  const consumed = deferred<void>()
  const emit = (text: string | Uint8Array) => { queue.push(typeof text === 'string' ? Buffer.from(text) : text); ready.resolve() }
  const finish = () => { ended = true; ready.resolve(); done.resolve({ exitCode: 0 }); quiescent.resolve() }
  const terminal: SidebarBackendTerminal = {
    output: { async *[Symbol.asyncIterator]() {
      while (!ended || queue.length) {
        if (queue.length) { yield queue.shift()!; consumed.resolve(); continue }
        await ready.promise
        ready = deferred<void>()
      }
    } },
    done: done.promise, quiescent: quiescent.promise,
    write: vi.fn(async () => {}), resize: vi.fn(async () => {}), terminate: vi.fn(async () => { finish() }),
  }
  return { terminal, emit, finish, consumed, done, quiescent }
}
function workspace(create: SidebarRemoteWorkspace['createTerminal']): SidebarRemoteWorkspace {
  return {
    kind: 'remote', cwd: '/srv/session', terminalExecutable: '/bin/bash',
    paths: { absolute: posix.normalize, join: posix.join, dirname: posix.dirname, basename: posix.basename, isAbsolute: posix.isAbsolute },
    fs: { resolve: async path => path, exists: async () => true, list: async path => ({ path, entries: [], truncated: false }), read: async () => ({ content: '', size: 0, binary: false, truncated: false }), readBytes: async () => new Uint8Array(), write: async () => {}, upload: async () => ({ path: '', size: 0 }), rename: async () => ({ path: '' }), remove: async () => ({ path: '' }), search: async () => ({ matches: [], truncated: false }) },
    git: { run: async () => '', listDirectories: async () => [], joinPath: posix.join, pathIdentity: posix.normalize },
    createTerminal: create,
  }
}
function registry(max = 8) {
  const value = new RemoteTerminalRegistry(max)
  cleanups.push(() => value.disposeAll())
  return value
}

function toolContext(sessionId: string): ToolRunContext {
  return { agent: { session: { id: sessionId } }, signal: new AbortController().signal } as never
}
function toolSet(value: AgentPtyRegistry, target: SidebarRemoteWorkspace) {
  const captured = new Map<string, ToolDefinition>()
  const ctx = { tools: { register: (tool: ToolDefinition) => { captured.set(tool.name, tool); return () => { captured.delete(tool.name) } } } }
  const dispose = registerTools(ctx as never, value, async () => { throw new Error('Remote creation must not resolve local cwd') }, () => { throw new Error('Remote shell must not read native overrides') }, (sessionId, title, command, signal) => value.createRemote(sessionId, title, command, target, signal))
  cleanups.push(async () => { dispose(); await value.dispose() })
  const call = async (name: string, args: Record<string, unknown>, sessionId = 'owner') => {
    const definition = captured.get(name)
    if (!definition?.execute) throw new Error('Missing tool ' + name)
    return definition.execute(args, toolContext(sessionId))
  }
  return Object.assign(call, { render(name: string, args: Record<string, unknown>, value: unknown) {
    const output = captured.get(name)?.output
    if (!output) throw new Error('Missing tool output ' + name)
    const violations = validateJsonSchemaValue(output.schema, value, 'value')
    if (violations.length) throw new Error(violations.join('\n'))
    return output.render(args, value as Parameters<typeof output.render>[1])
  } })
}

describe('remote terminal registry', () => {
  it('serializes concurrent creation before effects and preserves one prompt and split Unicode', async () => {
    const value = registry()
    const b = backend()
    const entered = deferred<void>()
    const release = deferred<void>()
    const create = vi.fn(async () => { entered.resolve(); await release.promise; return b.terminal })
    cleanups.push(async () => { release.resolve(); b.finish() })
    const target = workspace(create)
    const one = value.open('tab', 'owner', target)
    const two = value.open('tab', 'owner', target)
    expect(create).not.toHaveBeenCalled()
    await entered.promise
    release.resolve()
    const [first, second] = await Promise.all([one, two])
    expect(first).toBe(second)
    expect(create).toHaveBeenCalledTimes(1)
    const seen: string[] = []
    first.onData(data => seen.push(data))
    const bytes = Buffer.from('\x1b[32m你好🙂$ \x1b[0m')
    for (let index = 0; index < bytes.length; index++) b.emit(bytes.subarray(index, index + 1))
    b.finish()
    await first.settled
    expect(first.transcript).toBe('\x1b[32m你好🙂$ \x1b[0m')
    expect(seen.join('')).toBe(first.transcript)
    expect(first.transcript).not.toContain('�')
    expect(b.terminal.terminate).not.toHaveBeenCalled()
  })

  it('drains the previous host before opening another capability with the same POSIX cwd', async () => {
    const value = registry()
    const a = backend(); const b = backend()
    const entered = deferred<void>(); const ack = deferred<void>()
    cleanups.push(async () => { ack.resolve(); a.finish(); b.finish() })
    a.terminal.terminate = vi.fn(async () => { entered.resolve(); await ack.promise; a.finish() })
    const hostA = workspace(async () => a.terminal)
    const createB = vi.fn(async () => b.terminal)
    const hostB = workspace(createB)
    expect(hostA.cwd).toBe(hostB.cwd)
    const first = await value.open('tab', 'owner', hostA)
    const openingB = value.open('tab', 'owner', hostB)
    await entered.promise
    expect(createB).not.toHaveBeenCalled()
    await expect(first.write('must not reach retired host')).rejects.toThrow()
    ack.resolve()
    const second = await openingB
    expect(second).not.toBe(first)
    await second.write('new host')
    expect(a.terminal.write).not.toHaveBeenCalled()
    expect(b.terminal.write).toHaveBeenCalledWith('new host')
    expect(await value.open('tab', 'owner', hostB)).toBe(second)
    expect(createB).toHaveBeenCalledTimes(1)
  })

  it('retains the backend across detaches, bounds replay bytes and explicitly closes to quiescence', async () => {
    const value = registry()
    const b = backend()
    const create = vi.fn(async () => b.terminal)
    const target = workspace(create)
    const handle = await value.open('tab', 'owner', target)
    const unsubscribe = handle.onData(() => {})
    unsubscribe.dispose()
    b.emit('中'.repeat(TERMINAL_TRANSCRIPT_LIMIT))
    await b.consumed.promise
    await Promise.resolve()
    expect(Buffer.byteLength(handle.transcript)).toBeLessThanOrEqual(TERMINAL_TRANSCRIPT_LIMIT)
    expect(handle.transcript).not.toContain('�')
    expect(await value.open('tab', 'owner', target)).toBe(handle)
    expect(create).toHaveBeenCalledTimes(1)
    expect(b.terminal.terminate).not.toHaveBeenCalled()
    await value.close('tab')
    expect(b.terminal.terminate).toHaveBeenCalledTimes(1)
    expect(value.has('tab')).toBe(false)
  })

  it('does not release a pending allocation before create and teardown ACKs settle', async () => {
    const value = registry()
    const b = backend()
    const entered = deferred<void>()
    const created = deferred<SidebarBackendTerminal>()
    const ack = deferred<void>()
    b.terminal.terminate = vi.fn(async () => { await ack.promise; b.finish() })
    const target = workspace(async spec => { entered.resolve(); await created.promise; expect(spec.signal?.aborted).toBe(true); return b.terminal })
    const opening = value.open('tab', 'owner', target)
    const rejected = expect(opening).rejects.toThrow('Remote terminal closed')
    cleanups.push(async () => { created.resolve(b.terminal); ack.resolve(); b.finish(); await Promise.allSettled([opening]) })
    await entered.promise
    let cleaned = false
    const disposal = value.disposeAll().then(() => { cleaned = true })
    expect(value.has('tab')).toBe(true)
    expect(cleaned).toBe(false)
    created.resolve(b.terminal)
    await rejected
    expect(value.has('tab')).toBe(true)
    expect(cleaned).toBe(false)
    ack.resolve()
    await disposal
    expect(value.has('tab')).toBe(false)
    expect(b.terminal.terminate).toHaveBeenCalledTimes(1)
    await expect(value.open('tab', 'owner', target)).rejects.toThrow('disposed')
  })

  it('bounds pending session quota and drains session removal independently from other sessions', async () => {
    const value = registry(1)
    const one = backend()
    const two = backend()
    await value.open('one', 'a', workspace(async () => one.terminal))
    await expect(value.open('two', 'a', workspace(async () => two.terminal))).rejects.toThrow('limit')
    await value.open('other', 'b', workspace(async () => two.terminal))
    await value.closeSession('a')
    expect(one.terminal.terminate).toHaveBeenCalledTimes(1)
    expect(two.terminal.terminate).not.toHaveBeenCalled()
    expect(value.has('other')).toBe(true)
  })

  it('uncertain input is rejected once and never replayed after reconnection', async () => {
    const value = registry()
    const b = backend()
    b.terminal.write = vi.fn(async () => { throw new Error('delivery unknown') })
    const target = workspace(async () => b.terminal)
    const handle = await value.open('tab', 'owner', target)
    await expect(handle.write('dangerous command\r')).rejects.toThrow('delivery unknown')
    expect(await value.open('tab', 'owner', target)).toBe(handle)
    await expect(handle.write('retry')).rejects.toThrow('delivery unknown')
    expect(b.terminal.write).toHaveBeenCalledTimes(1)
  })

  it('does not dispatch queued input after an earlier operation becomes uncertain', async () => {
    const value = registry()
    const b = backend()
    const entered = deferred<void>()
    const acknowledgement = deferred<void>()
    b.terminal.write = vi.fn(async () => { entered.resolve(); await acknowledgement.promise })
    cleanups.push(async () => { acknowledgement.reject(new Error('fixture disposal')); b.finish() })
    const handle = await value.open('tab', 'owner', workspace(async () => b.terminal))
    const first = handle.write('first mutation\r')
    const second = handle.write('queued mutation\r')
    const firstRejected = expect(first).rejects.toThrow('dispatch uncertain')
    const secondRejected = expect(second).rejects.toThrow('dispatch uncertain')
    await entered.promise
    expect(b.terminal.write).toHaveBeenCalledTimes(1)
    acknowledgement.reject(new Error('dispatch uncertain'))
    await Promise.all([firstRejected, secondRejected])
    expect(b.terminal.write).toHaveBeenCalledTimes(1)
  })

  it('retains failed cleanup ownership and reports it again during plugin disposal', async () => {
    const value = new RemoteTerminalRegistry(8)
    cleanups.push(async () => { await expect(value.disposeAll()).rejects.toThrow('cleanup failed') })
    const b = backend()
    const handle = await value.open('tab', 'owner', workspace(async () => b.terminal))
    b.quiescent.reject(new Error('unsubscribe ACK missing'))
    b.done.resolve({ exitCode: 0 })
    b.finish()
    await expect(handle.settled).rejects.toThrow('transport failed')
    await expect(value.close('tab')).rejects.toThrow('cleanup failed')
    expect(value.has('tab')).toBe(true)
  })
})

describe('remote model terminal tools', () => {
  it('does not publish a UUID when cancellation arrives during initial command acknowledgement', async () => {
    const value = new AgentPtyRegistry('must-not-spawn', [], null)
    cleanups.push(() => value.dispose())
    const b = backend()
    const entered = deferred<void>()
    const ack = deferred<void>()
    b.terminal.write = vi.fn(async () => { entered.resolve(); await ack.promise })
    cleanups.push(async () => { ack.resolve(); b.finish() })
    const controller = new AbortController()
    const creating = value.createRemote('owner', 'Remote', 'initial', workspace(async () => b.terminal), controller.signal)
    const rejected = expect(creating).rejects.toThrow('cancelled during initial input')
    await entered.promise
    controller.abort(new Error('cancelled during initial input'))
    ack.resolve()
    await rejected
    expect(value.list('owner')).toEqual([])
    expect(b.terminal.write).toHaveBeenCalledTimes(1)
    expect(b.terminal.terminate).toHaveBeenCalledTimes(1)
  })

  it('awaits initial input settlement during model registry disposal even after backend exit', async () => {
    const value = new AgentPtyRegistry('must-not-spawn', [], null)
    cleanups.push(() => value.dispose())
    const b = backend()
    const entered = deferred<void>()
    const ack = deferred<void>()
    b.terminal.write = vi.fn(async () => { entered.resolve(); await ack.promise })
    cleanups.push(async () => { ack.resolve(); b.finish() })
    const creating = value.createRemote('owner', 'Remote', 'initial', workspace(async () => b.terminal))
    const rejected = expect(creating).rejects.toThrow('Agent terminal allocation closed')
    await entered.promise
    let disposed = false
    const disposal = value.dispose().then(() => { disposed = true })
    await b.terminal.done
    await b.terminal.quiescent
    expect(disposed).toBe(false)
    ack.resolve()
    await rejected
    await disposal
    expect(disposed).toBe(true)
    expect(value.list('owner')).toEqual([])
  })

  it('works without node-pty and shares read wait send resize signal list and close behavior', async () => {
    const value = new AgentPtyRegistry('must-not-spawn', [], null)
    const b = backend()
    const target = workspace(async () => b.terminal)
    const call = toolSet(value, target)
    const created = await call('terminal_create', { title: 'Remote', command: 'echo hello' }) as { uuid: string }
    expect(b.terminal.write).toHaveBeenCalledWith('echo hello\r')
    expect(value.get(created.uuid)?.cwd).toBe('/srv/session')
    b.emit('\x1b[1mREMOTE_OK\x1b[0m\n$ ')
    await b.consumed.promise
    await Promise.resolve()
    const reading = await call('terminal_read', { uuid: created.uuid })
    expect({ value: reading, rendered: call.render('terminal_read', { uuid: created.uuid }, reading) }).toMatchInlineSnapshot(`
      {
        "rendered": [
          {
            "text": "[lines 0..2 of 2]
      [1mREMOTE_OK[0m
      $ ",
            "type": "text",
          },
        ],
        "value": {
          "lineBegin": 0,
          "lineEnd": 2,
          "text": "[1mREMOTE_OK[0m
      $ ",
          "totalLines": 2,
          "truncated": false,
        },
      }
    `)
    expect(await call('terminal_wait_for', { uuid: created.uuid, needle: 'REMOTE_OK', timeoutMs: 1000 })).toMatchObject({ kind: 'found', match: 'REMOTE_OK' })
    expect(await call('terminal_list', {})).toMatchObject([{ uuid: created.uuid, title: 'Remote', exited: false }])
    await call('terminal_send', { uuid: created.uuid, text: 'echo second', submit: true })
    expect(b.terminal.write).toHaveBeenCalledWith('echo second\r')
    await call('terminal_resize', { uuid: created.uuid, cols: 110, rows: 32 })
    expect(b.terminal.resize).toHaveBeenCalledWith(110, 32)
    await call('terminal_signal', { uuid: created.uuid, signal: 'SIGINT' })
    expect(b.terminal.write).toHaveBeenCalledWith('\x03')
    await expect(call('terminal_send', { uuid: created.uuid, text: 'bad' }, 'other')).rejects.toThrow('not found')
    await expect(call('terminal_close', { uuid: created.uuid }, 'other')).rejects.toThrow('not found')
    expect(await call('terminal_close', { uuid: created.uuid })).toMatchObject({ closed: true })
    expect(value.get(created.uuid)).toBeUndefined()
    expect(b.terminal.terminate).toHaveBeenCalledTimes(1)
    expect(() => value.create('owner', 'local', '', 'C:/no-native')).toThrow('node-pty')
  })

  it('awaits remote input acknowledgement and reports delivery uncertainty', async () => {
    const value = new AgentPtyRegistry('must-not-spawn', [], null)
    const b = backend()
    const call = toolSet(value, workspace(async () => b.terminal))
    const { uuid } = await call('terminal_create', { title: 'Remote', command: '' }) as { uuid: string }
    const ack = deferred<void>()
    b.terminal.write = vi.fn(async () => ack.promise)
    cleanups.push(async () => { ack.reject(new Error('test cleanup')) })
    let returned = false
    const sending = call('terminal_send', { uuid, text: 'one' }).then(result => { returned = true; return result })
    await Promise.resolve()
    expect(returned).toBe(false)
    ack.reject(new Error('delivery uncertain'))
    await expect(sending).rejects.toThrow('delivery uncertain')
    await expect(call('terminal_send', { uuid, text: 'two' })).rejects.toThrow('delivery uncertain')
    expect(b.terminal.write).toHaveBeenCalledTimes(1)
  })
})

async function browserFixture() {
  const ctx = new Context()
  const routes: SidebarWebRoute[] = []
  const upgrades: SidebarWebUpgradeRoute[] = []
  const backends: ReturnType<typeof backend>[] = []
  const sockets = new Set<WebSocket>()
  const server = createServer((req, res) => {
    const route = routes.find(candidate => req.url?.startsWith(candidate.path))
    if (!route) { res.writeHead(404); res.end(); return }
    void Promise.resolve(route.handler(req, res)).catch(error => { res.writeHead(500); res.end(String(error)) })
  })
  cleanups.push(async () => {
    for (const socket of sockets) socket.terminate()
    for (const item of backends) item.finish()
    await ctx.fiber.dispose()
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) })
  })
  ctx.provide('webServer', {
    register: (route: SidebarWebRoute) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } },
    registerUpgrade: (route: SidebarWebUpgradeRoute) => { upgrades.push(route); return () => { upgrades.splice(upgrades.indexOf(route), 1) } },
  })
  ctx.provide('webRuntime', { trustedHosts: [] })
  ctx.provide('connection', { requestRejection: () => undefined })
  ctx.provide('sessions', { get: () => ({ header: { cwd: '/authoritative' }, snapshotEvents: () => [] }) })
  const captured = new Map<string, ToolDefinition>()
  ctx.provide('tools', { register: (tool: ToolDefinition) => { captured.set(tool.name, tool); return () => { captured.delete(tool.name) } } })
  ctx.provide('settings', { configure: () => () => {}, describe: () => [], update: async () => {} })
  ctx.provide('remoteSshManager', {})
  const native = vi.spyOn(dependencies, 'loadNodePty').mockReturnValue(null)
  const fork = ctx.plugin({ name: 'remote-terminal-consumers', apply: pluginCtx => apply(pluginCtx as never, { agentTerminalTools: true }) })
  try { await fork.await() } finally { native.mockRestore() }
  const create = vi.fn(async () => {
    const item = backend()
    backends.push(item)
    item.emit('\x1b[32mremote$ \x1b[0m')
    return item.terminal
  })
  const selectedWorkspace = workspace(create)
  const router = vi.fn(async () => selectedWorkspace)
  ctx.sidebarWorkspaceProviders.registerRouter(router)
  server.on('upgrade', (req, socket, head) => {
    const route = upgrades.find(candidate => req.url?.split('?')[0] === candidate.path)
    if (!route) { socket.destroy(); return }
    void Promise.resolve(route.handler(req, socket, head)).catch(() => socket.destroy())
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP listener did not allocate port')
  const origin = `http://127.0.0.1:${address.port}`
  async function connect(params: string) {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/sidebar/ws/terminal?' + params)
    sockets.add(socket)
    const messages: string[] = []
    const first = deferred<void>()
    socket.on('message', data => { messages.push(data.toString()); first.resolve() })
    await once(socket, 'open')
    return { socket, messages, first }
  }
  const tool = async (name: string, args: Record<string, unknown>, sessionId = 'owner') => {
    const value = captured.get(name)
    if (!value?.execute) throw new Error('Missing tool ' + name)
    return value.execute(args, toolContext(sessionId))
  }
  return { ctx, fork, origin, backends, create, router, connect, tool }
}

describe('remote browser terminal consumers', () => {
  it('forwards input and geometry received immediately after upgrade while remote creation is pending', async () => {
    const serverSocket = deferred<WebSocket>()
    const upgrade = WebSocketServer.prototype.handleUpgrade
    vi.spyOn(WebSocketServer.prototype, 'handleUpgrade').mockImplementation(function (this: WebSocketServer, req, socket, head, callback) {
      upgrade.call(this, req, socket, head, (accepted, request) => { serverSocket.resolve(accepted); callback(accepted, request) })
    })
    const f = await browserFixture()
    const b = backend(); f.backends.push(b)
    const entered = deferred<void>(); const release = deferred<void>(); const delivered = deferred<void>()
    cleanups.push(async () => { release.resolve(); b.finish() })
    f.create.mockImplementation(async () => { entered.resolve(); await release.promise; return b.terminal })
    b.terminal.write = vi.fn(async () => { delivered.resolve() })
    const attached = await f.connect('sessionId=owner&tab=early')
    await entered.promise
    const peer = await serverSocket.promise
    const received = deferred<void>(); let count = 0
    peer.on('message', () => { if (++count === 2) received.resolve() })
    attached.socket.send(JSON.stringify({ type: 'resize', cols: 101, rows: 31 }))
    attached.socket.send('echo early 中文\r')
    await received.promise
    expect(b.terminal.write).not.toHaveBeenCalled()
    release.resolve()
    await delivered.promise
    expect(b.terminal.resize).toHaveBeenCalledWith(101, 31)
    expect(b.terminal.write).toHaveBeenCalledExactlyOnceWith('echo early 中文\r')
  })

  it('honors an explicit close received before allocation finishes even after the browser disconnects', async () => {
    const serverSocket = deferred<WebSocket>()
    const upgrade = WebSocketServer.prototype.handleUpgrade
    vi.spyOn(WebSocketServer.prototype, 'handleUpgrade').mockImplementation(function (this: WebSocketServer, req, socket, head, callback) {
      upgrade.call(this, req, socket, head, (accepted, request) => { serverSocket.resolve(accepted); callback(accepted, request) })
    })
    const f = await browserFixture()
    const b = backend(); f.backends.push(b)
    const entered = deferred<void>(); const release = deferred<void>()
    cleanups.push(async () => { release.resolve(); b.finish() })
    f.create.mockImplementation(async () => { entered.resolve(); await release.promise; return b.terminal })
    const attached = await f.connect('sessionId=owner&tab=early-close')
    await entered.promise
    const peer = await serverSocket.promise
    const received = once(peer, 'message')
    attached.socket.send(JSON.stringify({ type: 'close' })); await received
    const peerClosed = once(peer, 'close')
    attached.socket.close(); await once(attached.socket, 'close'); await peerClosed
    release.resolve()
    await b.terminal.done; await b.terminal.quiescent
    expect(b.terminal.terminate).toHaveBeenCalledTimes(1)
    expect(b.terminal.write).not.toHaveBeenCalled()
  })

  it('keeps plugin disposal pending until a late allocation and its cleanup ACK finish', async () => {
    const f = await browserFixture()
    const b = backend()
    f.backends.push(b)
    const entered = deferred<void>()
    const release = deferred<void>()
    const ack = deferred<void>()
    f.create.mockImplementation(async () => { entered.resolve(); await release.promise; return b.terminal })
    b.terminal.terminate = vi.fn(async () => { await ack.promise; b.finish() })
    cleanups.push(async () => { release.resolve(); ack.resolve(); b.finish() })
    const attached = await f.connect('sessionId=owner&tab=pending')
    await entered.promise
    let disposed = false
    const disposal = f.fork.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    const terminateEntered = deferred<void>()
    b.terminal.terminate = vi.fn(async () => { terminateEntered.resolve(); await ack.promise; b.finish() })
    release.resolve()
    await terminateEntered.promise
    expect(disposed).toBe(false)
    ack.resolve()
    await disposal
    expect(disposed).toBe(true)
    expect(b.terminal.terminate).toHaveBeenCalledTimes(1)
    if (attached.socket.readyState !== WebSocket.CLOSED) {
      attached.socket.terminate()
      await once(attached.socket, 'close')
    }
  })

  it('selects the new remote host through the real WebSocket consumer even when its cwd is unchanged', async () => {
    const f = await browserFixture()
    const one = await f.connect('sessionId=owner&tab=host-change')
    await one.first.promise
    const previous = f.backends[0]!
    one.socket.send(JSON.stringify({ type: 'park' })); one.socket.close(); await once(one.socket, 'close')
    const next = backend(); f.backends.push(next)
    const delivered = deferred<void>()
    next.terminal.write = vi.fn(async () => { delivered.resolve() })
    const hostB = workspace(async () => { next.emit('host-b$ '); return next.terminal })
    f.router.mockImplementation(async () => hostB)
    const two = await f.connect('sessionId=owner&tab=host-change')
    await two.first.promise
    expect(previous.terminal.terminate).toHaveBeenCalledTimes(1)
    expect(two.messages.join('')).toBe('host-b$ ')
    two.socket.send('new host input'); await delivered.promise
    expect(previous.terminal.write).not.toHaveBeenCalled()
    expect(next.terminal.write).toHaveBeenCalledWith('new host input')
  })

  it('uses remote allocation without node-pty, parks and reconnects without duplicate backend or prompt', async () => {
    const f = await browserFixture()
    const one = await f.connect('sessionId=owner&tab=tab&cwd=C%3A%2Flocal-forgery')
    await one.first.promise
    expect(one.messages.join('')).toBe('\x1b[32mremote$ \x1b[0m')
    one.socket.send(JSON.stringify({ type: 'park' }))
    one.socket.close()
    await once(one.socket, 'close')
    expect(f.backends[0]!.terminal.terminate).not.toHaveBeenCalled()
    const two = await f.connect('sessionId=owner&tab=tab')
    await two.first.promise
    expect(two.messages.join('')).toBe(one.messages.join(''))
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/srv/session', cols: 80, rows: 24 }))
    expect(f.router).toHaveBeenCalledWith({ sessionId: 'owner', cwd: '/authoritative' })
    two.socket.close()
    await once(two.socket, 'close')
    expect(f.backends[0]!.terminal.terminate).not.toHaveBeenCalled()
    const response = await fetch(f.origin + '/sidebar/api/pty.close', { method: 'POST', body: JSON.stringify({ sessionId: 'owner', tab: 'tab' }) })
    expect(response.status).toBe(200)
    expect(f.backends[0]!.terminal.terminate).toHaveBeenCalledTimes(1)
  })

  it('drains remote terminal Session disposal and route removal without reallocating a local terminal', async () => {
    const f = await browserFixture()
    const attached = await f.connect('sessionId=owner&tab=session-owned')
    await attached.first.promise
    const b = f.backends[0]!
    const terminating = deferred<void>()
    const ack = deferred<void>()
    cleanups.push(async () => { ack.resolve(); b.finish() })
    b.terminal.terminate = vi.fn(async () => { terminating.resolve(); await ack.promise; b.finish() })
    f.ctx.emit('session/disposed', { id: 'owner' } as never)
    await terminating.promise
    let closed = false
    const closing = fetch(f.origin + '/sidebar/api/pty.close', { method: 'POST', body: JSON.stringify({ sessionId: 'owner', tab: 'session-owned' }) }).then(response => { closed = true; return response })
    expect(closed).toBe(false)
    ack.resolve()
    expect((await closing).status).toBe(200)
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(b.terminal.terminate).toHaveBeenCalledTimes(1)
    // Provider route removal is represented by its authoritative done/output/quiescent outcome.
    const other = await f.connect('sessionId=owner&tab=route-owned')
    await other.first.promise
    const exit = once(other.socket, 'message')
    f.backends[1]!.finish()
    expect((await exit)[0].toString()).toContain('process exited')
    expect(f.create).toHaveBeenCalledTimes(2)
    expect(f.backends[1]!.terminal.terminate).not.toHaveBeenCalled()
  })

  it('enforces session ownership on agent socket attachment and HTTP close/skip operations', async () => {
    const f = await browserFixture()
    const { uuid } = await f.tool('terminal_create', { title: 'Agent remote', command: '' }) as { uuid: string }
    const bad = await f.connect('sessionId=other&uuid=' + uuid)
    const badClose = await once(bad.socket, 'close')
    expect(badClose[0]).toBe(1011)
    expect(bad.messages).toEqual([])
    const good = await f.connect('sessionId=owner&uuid=' + uuid)
    await good.first.promise
    expect(good.messages.join('')).toContain('remote$')
    for (const method of ['agent-pty.close', 'agent-pty.skip-wait']) {
      const result = await fetch(f.origin + '/sidebar/api/' + method, { method: 'POST', body: JSON.stringify({ sessionId: 'other', uuid }) })
      expect(result.status).toBe(404)
    }
    expect(f.backends[0]!.terminal.terminate).not.toHaveBeenCalled()
    good.socket.send(JSON.stringify({ type: 'close' }))
    const listed = await f.tool('terminal_list', {})
    // Close acknowledgement is observable through the backend, not a scheduler delay.
    await f.backends[0]!.terminal.done
    await f.backends[0]!.terminal.quiescent
    expect(f.backends[0]!.terminal.terminate).toHaveBeenCalledTimes(1)
    expect(Array.isArray(listed)).toBe(true)
  })
})
