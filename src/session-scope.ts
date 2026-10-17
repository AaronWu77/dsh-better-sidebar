/** Authoritative session routing for local and remote sidebar workspace providers. */
import { posix, win32 } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SidebarSessionStore, SidebarSessionPersistenceService } from './context-types.ts'
import { SidebarError } from './wire.ts'

/** A session identity and its host-owned working directory, before provider selection. */
export interface SidebarSessionScope {
  readonly sessionId: SessionId
  readonly cwd: string
}

/** Preserve remote POSIX path spelling even when the sidebar host runs on Windows. */
function authoritativeCwd(value: string | undefined, sessionId: string): string {
  if (value === undefined || value === '' || value.includes('\0') || (!posix.isAbsolute(value) && !win32.isAbsolute(value))) {
    throw new SidebarError('bad-request', `session "${sessionId}" has no valid authoritative working directory`, 400)
  }
  return value
}

/** Resolve routing authority without trusting browser cwd hints or reading the event log.
 * @param sessions Live session store.
 * @param persistence Optional read-only persisted session provider.
 * @param sessionId Session named by the authenticated caller.
 * @returns Session scope from a live header or a persisted header.
 * @throws When the session has no authoritative cwd or persistence cannot open it.
 */
export async function resolveSidebarSessionScope(
  sessions: SidebarSessionStore,
  persistence: SidebarSessionPersistenceService | undefined,
  sessionId: SessionId,
): Promise<SidebarSessionScope> {
  const session = sessions.get(sessionId)
  if (session !== undefined) return { sessionId, cwd: authoritativeCwd(session.header.cwd, sessionId) }
  if (persistence === undefined) throw new SidebarError('not-found', `session "${sessionId}" is unavailable`, 404)
  const handle = await persistence.open(sessionId, 'read').catch((error: unknown) => {
    if (error instanceof Error && error.name === 'SessionPersistenceNotFoundError') {
      throw new SidebarError('not-found', `session "${sessionId}" is unavailable`, 404)
    }
    throw error
  })
  try {
    return { sessionId, cwd: authoritativeCwd(handle.header.cwd, sessionId) }
  } finally {
    await handle.close()
  }
}
