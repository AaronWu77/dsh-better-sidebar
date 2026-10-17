/** Real socket messages cover bounded buffering before asynchronous terminal readiness. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { captureTerminalInput, terminalInputText } from '../src/terminal-attach-input.ts'
import { resolveSidebarConfig } from '../src/config.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).reverse().map(dispose => dispose()))
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, 'attachment input fixture cleanup')
})
async function setup(maxBytes: number) {
  const server = createServer()
  const wss = new WebSocketServer({ server })
  type Accepted = { peer: WebSocket; capture: ReturnType<typeof captureTerminalInput> }
  let accept!: (value: Accepted) => void
  const accepted = new Promise<Accepted>(resolve => { accept = resolve })
  wss.on('connection', peer => accept({ peer, capture: captureTerminalInput(peer, maxBytes) }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing ephemeral listener')
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`)
  cleanups.push(async () => {
    socket.terminate(); for (const peer of wss.clients) peer.terminate()
    await new Promise<void>(resolve => wss.close(() => resolve()))
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  await once(socket, 'open')
  return { socket, ...await accepted }
}

describe('pending terminal attachment input', () => {
  it('transfers complete messages once, with byte limits independent of UTF-16 length', async () => {
    const { socket, peer, capture } = await setup(7)
    const first = once(peer, 'message'); socket.send('中'); await first
    const second = once(peer, 'message'); socket.send('text'); await second
    expect(capture.overflow).toBe(false)
    expect(capture.drain()).toEqual(['中', 'text'])
    const after = once(peer, 'message'); socket.send('after'); await after
    expect(capture.drain()).toEqual([])
    capture.dispose()
  })
  it('retains an explicit close intent when the peer disconnects before readiness', async () => {
    const { socket, peer, capture } = await setup(64)
    const received = once(peer, 'message'); socket.send(JSON.stringify({ type: 'close' })); await received
    const closed = once(peer, 'close'); socket.close(); await closed
    expect(capture.closeRequested).toBe(true)
    expect(capture.drain()).toEqual(['{"type":"close"}'])
    capture.dispose()
  })
  it('closes over-budget input without retaining or forwarding a partial message', async () => {
    const { socket, capture } = await setup(4)
    const closed = once(socket, 'close'); socket.send('12345')
    expect((await closed)[0]).toBe(1009)
    expect(capture.overflow).toBe(true)
    expect(capture.drain()).toEqual([])
    capture.dispose()
  })
  it('decodes fragmented buffers and ArrayBuffer messages as one UTF-8 message', () => {
    const bytes = Buffer.from('中文🙂')
    expect(terminalInputText(bytes)).toBe('中文🙂')
    expect(terminalInputText(bytes.subarray(3))).toBe('文🙂')
    expect(terminalInputText([bytes.subarray(0, 2), bytes.subarray(2)])).toBe('中文🙂')
    expect(terminalInputText(Uint8Array.from(bytes).buffer)).toBe('中文🙂')
  })
  it('resolves deployment limits explicitly and refuses invalid direct-call configuration', () => {
    expect(resolveSidebarConfig({ terminalInputBufferBytes: 17 }).terminalInputBufferBytes).toBe(17)
    expect(resolveSidebarConfig(undefined).terminalInputBufferBytes).toBe(256 * 1024)
    for (const value of [0, -1, 1.5, NaN, Infinity]) expect(() => resolveSidebarConfig({ terminalInputBufferBytes: value })).toThrow('positive safe integer')
  })
})
