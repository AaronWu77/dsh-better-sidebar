/** Bound input arriving while a terminal's authoritative Session and backend are being resolved. */
import { WebSocket, type RawData } from 'ws'

/** Decode one complete WebSocket message without treating fragmented buffers as a string list.
 * @param data Complete wire message delivered by ws.
 * @returns UTF-8 terminal text.
 */
export function terminalInputText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/** Capture received messages before any asynchronous backend allocation.
 * @param socket Already authenticated browser socket.
 * @param maxBytes Validated deployment byte limit.
 * @returns Owned capture; draining detaches it and transfers each message once.
 */
export function captureTerminalInput(socket: WebSocket, maxBytes: number) {
  let messages: string[] = []
  let bytes = 0
  let closeRequested = false
  let overflow = false
  const receive = (data: RawData): void => {
    if (overflow) return
    const size = Array.isArray(data) ? data.reduce((sum, part) => sum + part.byteLength, 0) : data.byteLength
    if (size > maxBytes - bytes) {
      overflow = true
      messages = []; bytes = 0
      socket.close(1009, 'Terminal input queue limit reached')
      return
    }
    const text = terminalInputText(data)
    messages.push(text); bytes += size
    try {
      const control: unknown = JSON.parse(text)
      if (control !== null && typeof control === 'object' && 'type' in control && control.type === 'close') closeRequested = true
    } catch (_error) { /* Raw terminal input need not be JSON. */ }
  }
  socket.on('message', receive)
  const dispose = (): void => { socket.off('message', receive); messages = []; bytes = 0 }
  return {
    get closeRequested() { return closeRequested },
    get overflow() { return overflow },
    drain(): readonly string[] { socket.off('message', receive); const received = messages; messages = []; bytes = 0; return received },
    dispose,
  }
}
