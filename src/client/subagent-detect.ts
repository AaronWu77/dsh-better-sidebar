/**
 * Pure subagent-membership helpers over the sessions list feed (structural
 * mirror world — no runtime imports). Used by the sidebar's auto-activation
 * effect and the Subagent page:
 *
 * - {@link directSubagentCount}: direct durable children of one session,
 * - {@link detectNewDirectSubagent}: the 0 → N transition that means "a new
 *   subagent just spawned under the current session" (the auto-open trigger),
 * - {@link countSubagentDescendants}: uninterrupted subagent-origin lineage
 *   totals (mirror of the official `indexSubagentDescendants` over the
 *   plugin's own summary rows),
 * - {@link deriveCatalogs}: the per-parent topology catalogs built from the
 *   DSH 0.1.7 session projection map.
 *
 * The lineage walks themselves ({@link isSideThreadSummary}, {@link
 * rootAncestor}, {@link countSubagentDescendants}) live in
 * ./subagent-lineage.ts — the single shared walk implementation — and are
 * re-exported below for their established import sites.
 */
import type {
  SidebarSessionList,
  SidebarSubagentCatalog,
  SidebarSubagentChildEntry,
} from '../context-types.ts'
import { countSubagentDescendants, isSideThreadSummary, rootAncestor } from './subagent-lineage.ts'

export { countSubagentDescendants, isSideThreadSummary, rootAncestor }
export type { SubagentDescendantTotals } from './subagent-lineage.ts'

/** Count the direct subagent children of one session (durable `origin` rows). */
export function directSubagentCount(
  byId: SidebarSessionList['byId'],
  sessionId: string,
): number {
  let count = 0
  for (const summary of Object.values(byId)) {
    if (summary.origin === 'subagent' && summary.parentId === sessionId
      && !isSideThreadSummary(summary)) count += 1
  }
  return count
}

/**
 * Derive the per-parent subagent catalogs from the DSH 0.1.7 session
 * projection map (the direct `subagentsByParent` list field is gone).
 *
 * A projection entry whose `subagentCatalog` has not settled yet still yields
 * a ready empty catalog; the caller's summary-backed loading placeholder
 * covers that transient window. DSH's `'unknown'` mode means "visible but not
 * continuable", which the plugin's two-arm entry union renders as
 * `'one-shot'`.
 * @param list - the client sessions list snapshot.
 * @returns one catalog per session that has a projection entry.
 */
export function deriveCatalogs(list: SidebarSessionList): Record<string, SidebarSubagentCatalog> {
  const catalogs: Record<string, SidebarSubagentCatalog> = {}
  const projections = list.projectionsBySession ?? {}
  for (const [parentSessionId, projection] of Object.entries(projections)) {
    catalogs[parentSessionId] = {
      state: 'ready',
      error: null,
      entries: (projection.values.subagentCatalog ?? []).map((entry): SidebarSubagentChildEntry => ({
        kind: 'child',
        id: entry.id,
        activity: list.byId[entry.id]?.running === true ? 'running' : 'inactive',
        hasChildren: (projections[entry.id]?.values.subagentCatalog?.length ?? 0) > 0,
        mode: entry.mode === 'unknown' ? 'one-shot' : entry.mode,
        ...(entry.label === undefined ? {} : { label: entry.label }),
      })),
    }
  }
  return catalogs
}

/**
 * Collect every catalog branch (an entry with `hasChildren`) reachable from
 * the root — the set of catalogs the always-expanded topology consumes.
 * Cycles fail soft.
 */
export function collectBranchIds(
  catalogs: Readonly<Record<string, SidebarSubagentCatalog>>,
  rootId: string | undefined,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const visit = (parentId: string): void => {
    if (seen.has(parentId)) return
    seen.add(parentId)
    for (const entry of catalogs[parentId]?.entries ?? []) {
      if (entry.kind === 'child' && entry.hasChildren) {
        out.push(entry.id)
        visit(entry.id)
      }
    }
  }
  if (rootId !== undefined) visit(rootId)
  return out
}

/**
 * Whether a new direct subagent appeared under `sessionId` between two
 * consecutive list snapshots (the count crossed 0 → >0). Switching to a
 * session that already has subagents yields `false` (its baseline starts at
 * the current count), so the auto-open never fights an existing layout.
 */
export function detectNewDirectSubagent(
  prev: SidebarSessionList,
  next: SidebarSessionList,
  sessionId: string,
): boolean {
  return directSubagentCount(prev.byId, sessionId) === 0
    && directSubagentCount(next.byId, sessionId) > 0
}
