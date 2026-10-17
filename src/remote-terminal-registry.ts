/** Persistent remote terminals owned independently from browser attachments. */
import { StringDecoder } from 'node:string_decoder'
import type { SidebarBackendTerminal, SidebarRemoteWorkspace } from './workspace-provider.ts'
import { SidebarError } from './wire.ts'

/** Retained raw terminal text uses the same bound as the native terminal registries. */
export const TERMINAL_TRANSCRIPT_LIMIT = 1 << 20

/** One remote terminal with ordered byte decoding and serialized input operations. */
export class RemoteTerminalHandle {
  readonly pid = -1
  readonly process = 'remote'
  transcript = ''
  exited = false
  exitCode: number | null = null
  exitSignal: string | null = null
  failure: Error | undefined
  private closing = false
  private termination: Promise<void> | undefined
  private readonly operations = new Set<Promise<void>>()
  private operationTail = Promise.resolve()
  /** Whether acknowledged termination has been requested. */
  get isClosing(): boolean { return this.closing }
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(exit: { exitCode: number; signal?: number }) => void>()
  /** Output EOF, process outcome and backend cleanup; transport or cleanup failures reject. */
  readonly settled: Promise<void>

  /** Start collecting one already-owned backend.
   * @param backend Provider-owned persistent terminal.
   * @param cols Initial column count.
   * @param rows Initial row count.
   */
  constructor(readonly backend: SidebarBackendTerminal, public cols: number, public rows: number) {
    const decoder = new StringDecoder('utf8')
    const output = (async () => {
      for await (const bytes of backend.output) this.append(decoder.write(Buffer.from(bytes)))
      this.append(decoder.end())
    })()
    this.settled = Promise.allSettled([output, backend.done, backend.quiescent]).then(results => {
      const outcome = results[1]
      if (outcome?.status === 'fulfilled') {
        this.exitCode = outcome.value.exitCode
        this.exitSignal = outcome.value.signal ?? null
      }
      const failures = results.filter(result => result.status === 'rejected')
      this.exited = true
      if (failures.length) this.failure = new AggregateError(failures.map(result => result.status === 'rejected' ? result.reason : undefined), 'Remote terminal transport failed')
      this.emit(this.exitListeners, { exitCode: this.exitCode ?? -1 })
      if (this.failure) throw this.failure
    })
    void this.settled.catch((_error) => { /* Failure remains visible on the handle and cleanup promise. */ })
    void output.catch(() => backend.terminate()).catch((_error) => { /* settled observes transport and cleanup outcomes. */ })
  }

  private append(data: string): void {
    if (!data) return
    this.transcript += data
    if (Buffer.byteLength(this.transcript) > TERMINAL_TRANSCRIPT_LIMIT) {
      const bytes = Buffer.from(this.transcript)
      let begin = bytes.length - TERMINAL_TRANSCRIPT_LIMIT
      while (begin < bytes.length && (bytes[begin]! & 0xc0) === 0x80) begin++
      this.transcript = bytes.subarray(begin).toString('utf8')
    }
    this.emit(this.dataListeners, data)
  }

  private emit<T>(listeners: Set<(event: T) => void>, event: T): void {
    for (const listener of [...listeners]) {
      try { listener(event) } catch (_error) { /* One browser listener cannot interrupt other subscribers or output collection. */ }
    }
  }

  /** Subscribe to decoded raw VT output without changing the backend lifetime.
   * @param listener Synchronous output observer; exceptions are contained.
   * @returns Idempotent unsubscription for this observer only.
   */
  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener)
    return { dispose: () => { this.dataListeners.delete(listener) } }
  }

  /** Subscribe to final output/process/cleanup settlement, inspecting failure for transport errors.
   * @param listener Final outcome observer.
   * @returns Idempotent unsubscription for this observer only.
   */
  onExit(listener: (exit: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitListeners.add(listener)
    return { dispose: () => { this.exitListeners.delete(listener) } }
  }

  /** Dispatch input at most once; uncertain failure permanently refuses further input on this handle.
   * @param data Raw terminal input.
   * @returns Completed backend dispatch, not shell consumption; uncertain dispatch rejects without replay.
   */
  write(data: string): Promise<void> {
    return this.operate(() => this.backend.write(data))
  }

  /** Apply geometry without the local node-pty resize gate.
   * @param cols Validated column count.
   * @param rows Validated row count.
   * @returns Completed backend operation; failure refuses later uncertain input.
   */
  resize(cols: number, rows: number): Promise<void> {
    return this.operate(async () => {
      await this.backend.resize(cols, rows)
      this.cols = cols
      this.rows = rows
    })
  }

  private operate(action: () => Promise<void>): Promise<void> {
    const result = this.operationTail.then(async () => {
      this.assertActive()
      await action()
    }).catch(error => {
      this.failure ??= error instanceof Error ? error : new Error(String(error))
      throw error
    })
    this.operationTail = result.then(() => undefined, () => undefined)
    this.operations.add(result)
    const finished = () => { this.operations.delete(result) }
    void result.then(finished, finished)
    return result
  }

  private assertActive(): void {
    if (this.failure) throw this.failure
    if (this.closing) throw new SidebarError('bad-request', 'Remote terminal is closing', 400)
    if (this.exited) throw new SidebarError('bad-request', 'Remote terminal has exited', 400)
  }

  /** Request backend termination, not an emulated POSIX signal.
   * @returns Shared quiescent termination; cleanup failure rejects independently of output failure.
   */
  kill(): Promise<void> {
    this.closing = true
    this.termination ??= Promise.allSettled([this.backend.terminate(), this.backend.quiescent, this.settled, ...this.operations]).then(results => {
      // Transport failure is reported by the output and operations, independently of resource cleanup.
      const failures = results.slice(0, 2).flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'Remote terminal cleanup failed')
    })
    return this.termination
  }
}

interface Allocation {
  readonly sessionId: string
  readonly workspace: SidebarRemoteWorkspace
  readonly controller: AbortController
  readonly ready: Promise<RemoteTerminalHandle>
  closing?: Promise<void>
  handle?: RemoteTerminalHandle
}

/** Allocations remain registered until creation and complete backend cleanup have settled. */
export class RemoteTerminalRegistry {
  private readonly allocations = new Map<string, Allocation>()
  private disposed = false

  /** Create a registry with the owning surface's existing concurrency bound.
   * @param maxPerSession Concurrent pending/running allocations allowed per session.
   */
  constructor(private readonly maxPerSession: number) {}

  /** Reserve a key before provider side effects; parallel opens share one allocation.
   * @param key Internal session/tab key or newly generated model UUID.
   * @param sessionId Owning authoritative session.
   * @param workspace Provider selected from that session's header.
   * @param cols Initial columns.
   * @param rows Initial rows.
   * @returns Existing same-capability handle or a new allocation after draining the previous host; browser detach does not own its lifetime.
   */
  open(key: string, sessionId: string, workspace: SidebarRemoteWorkspace, cols = 80, rows = 24): Promise<RemoteTerminalHandle> {
    if (this.disposed) return Promise.reject(new SidebarError('workspace-unavailable', 'Remote terminal registry is disposed', 503))
    const existing = this.allocations.get(key)
    if (existing) {
      if (existing.sessionId !== sessionId) return Promise.reject(new SidebarError('not-found', 'Remote terminal not found', 404))
      if (existing.closing) return existing.closing.then(() => this.open(key, sessionId, workspace, cols, rows))
      if (existing.workspace !== workspace) return this.close(key).then(() => this.open(key, sessionId, workspace, cols, rows))
      return existing.ready
    }
    if ([...this.allocations.values()].filter(entry => entry.sessionId === sessionId && (entry.closing !== undefined || !entry.handle?.exited)).length >= this.maxPerSession) {
      return Promise.reject(new SidebarError('bad-request', 'Terminal limit reached for this session', 400))
    }
    const controller = new AbortController()
    const entry: Allocation = {
      sessionId, workspace, controller,
      ready: Promise.resolve().then(async () => {
        controller.signal.throwIfAborted()
        const backend = await workspace.createTerminal({ cwd: workspace.cwd, cols, rows, signal: controller.signal })
        const handle = new RemoteTerminalHandle(backend, cols, rows)
        entry.handle = handle
        controller.signal.throwIfAborted()
        return handle
      }),
    }
    this.allocations.set(key, entry)
    void entry.ready.catch(() => { if (!entry.closing && this.allocations.get(key) === entry) this.allocations.delete(key) })
    return entry.ready
  }

  /** Observe pending/resident ownership, including a failed cleanup.
   * @param key Allocation key.
   * @returns Whether this registry still owns the allocation.
   */
  has(key: string): boolean { return this.allocations.has(key) }

  /** Close pending and resident terminals belonging to a removed session.
   * @param sessionId Removed session.
   * @returns Complete cleanup; failed acknowledgements reject and retain ownership.
   */
  async closeSession(sessionId: string): Promise<void> {
    const results = await Promise.allSettled([...this.allocations].filter(([, entry]) => entry.sessionId === sessionId).map(([key]) => this.close(key)))
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Session remote terminal cleanup failed')
  }

  /** Explicit close drains pending creation as well as an already-created backend.
   * @param key Allocation key.
   * @returns Shared cleanup completion; failure rejects and keeps the reservation owned.
   */
  close(key: string): Promise<void> {
    const entry = this.allocations.get(key)
    if (!entry) return Promise.resolve()
    if (entry.closing) return entry.closing
    entry.controller.abort(new Error('Remote terminal closed'))
    entry.closing = (async () => {
      try { await entry.ready } catch (error) {
        if (entry.handle === undefined && error !== entry.controller.signal.reason) throw error
      }
      if (entry.handle) await entry.handle.kill()
    })().then(() => { if (this.allocations.get(key) === entry) this.allocations.delete(key) })
    return entry.closing
  }

  /** Stop new opens and await reserved allocations and backend subscriptions.
   * @returns Quiescent teardown; failed cleanup rejects and remains owned.
   */
  async disposeAll(): Promise<void> {
    this.disposed = true
    await this.closeAll()
  }

  /** Close current allocations while keeping future allocation available.
   * @returns Cleanup completion for the captured allocations; failures remain owned.
   */
  async closeAll(): Promise<void> {
    const results = await Promise.allSettled([...this.allocations.keys()].map(key => this.close(key)))
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Remote terminal registry cleanup failed')
  }
}
