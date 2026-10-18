/** Opt-in candidate integration: real built Connection, memory credentials, no listener or profile. */
import { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IncomingMessage } from 'node:http'

export const hostRoot = process.env.DSH_RC2_HOST_ROOT
interface Peer { principal: { kind: string } }
interface Connection {
  requestRejection(request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined
  admit(request: { headers: IncomingMessage['headers'] }): { rejection: 401 | 403 } | { peer: Peer }
  authenticatedUrl(base: string): string
  authorizeIndex(request: unknown, response: unknown): boolean
  authorizeConnect(request: unknown, response: unknown): void
  admitConnection(request: unknown): { rejection: number } | { peer: Peer; release(): Promise<void> }
}
export async function connectionFixture() {
  if (!hostRoot) throw new Error('DSH_RC2_HOST_ROOT must point to the isolated built candidate Host')
  const entry = pathToFileURL(join(hostRoot, 'packages/client/connection/lib/index.js')).href
  const host = await import(/* @vite-ignore */ entry) as { apply(ctx: Context): Promise<void> }
  const ctx = new Context()
  let record: unknown
  ctx.provide('credentials', {
    readRecord: async () => record,
    modifyRecord: async (_key: unknown, mutate: (value: unknown) => Promise<unknown>) => { record = await mutate(record); return record },
  } as never)
  ctx.provide('webServer', {
    host: '127.0.0.1', protocol: 'http:', port: 3080,
    register: () => () => {}, registerUpgrade: () => () => {},
  } as never)
  try { await host.apply(ctx); await ctx.fiber.await() } catch (error) { await ctx.fiber.dispose(); throw error }
  const connection = ctx.get('connection') as unknown as Connection
  const headers = (cookie?: string): IncomingMessage['headers'] => ({ host: '127.0.0.1:3080', ...(cookie ? { cookie } : {}) })
  const exchange = (api: boolean) => {
    const launch = new URL(connection.authenticatedUrl('http://127.0.0.1:3080/'))
    if (api) launch.pathname = '/connect'
    let cookie = ''; let status = 0
    const response = { writeHead(code: number, values?: Record<string, string>) { status = code; cookie = values?.['set-cookie']?.split(';')[0] ?? '' }, end() {} }
    const request = { method: 'GET', url: launch.pathname + launch.search, headers: headers() }
    if (api) connection.authorizeConnect(request, response)
    else connection.authorizeIndex(request, response)
    if (!cookie || status !== (api ? 302 : 303)) throw new Error('real Connection token exchange failed: ' + status)
    return headers(cookie)
  }
  return { ctx, connection, headers, browser: () => exchange(false), api: () => exchange(true), dispose: () => ctx.fiber.dispose() }
}
