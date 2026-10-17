/** HTTP close notifications abort search traversal only until the handler releases its observation. */
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { observeSearchRequest } from '../src/search-request.ts'
import type { SidebarHttpRequest, SidebarHttpResponse } from '../src/context-types.ts'
function fixture() {
  const req = Object.assign(new EventEmitter(), {
    headers: {}, aborted: false,
    async *[Symbol.asyncIterator]() { yield '{}' },
  }) satisfies SidebarHttpRequest
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200, writableEnded: false, destroyed: false,
    writeHead: () => {}, end: () => {},
  }) satisfies SidebarHttpResponse
  return { req, res }
}
describe('search HTTP request observation', () => {
  it.each(['aborted-body', 'disconnected-response'])('aborts on %s and removes both listeners at settlement', event => {
    const { req, res } = fixture(), request = observeSearchRequest(req, res)
    if (event === 'aborted-body') req.emit('aborted')
    else res.emit('close')
    expect(request.signal.aborted).toBe(true)
    request.dispose()
    expect(req.listenerCount('aborted')).toBe(0)
    expect(res.listenerCount('close')).toBe(0)
  })
  it('does not cancel a completed response or react after disposal', () => {
    const { req, res } = fixture(), request = observeSearchRequest(req, res)
    res.writableEnded = true; res.emit('close')
    expect(request.signal.aborted).toBe(false)
    request.dispose(); req.emit('aborted')
    expect(request.signal.aborted).toBe(false)
  })
  it.each(['request', 'response'])('handles an already disconnected %s', side => {
    const { req, res } = fixture()
    if (side === 'request') req.aborted = true
    else res.destroyed = true
    const request = observeSearchRequest(req, res)
    expect(request.signal.aborted).toBe(true)
    request.dispose()
  })
})
