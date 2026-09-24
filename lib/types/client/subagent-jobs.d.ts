/**
 * Pure derivations for the Subagent page's background-job section. Kept
 * framework-free so the node test environment can unit-test them: the job
 * rows arrive from the DSH 0.1.7 client `jobs` service (mapped by
 * {@link mapJobViewRows}) or, as a graceful fallback for older deployments,
 * from the legacy `jobsBySession` list mirror — nothing here issues
 * requests, and the row ordering / status mapping mirror the official
 * ui-jobs header list.
 */
import type { SidebarClientJobView, SidebarSessionList, SidebarJobStatus, SidebarJobView } from '../context-types.ts';
import type { CopyKey } from './locales.ts';
import { treeSessionIds } from './subagent-lineage.ts';
/** One row of the jobs section: the job plus its owning session's title. */
export interface TreeJob {
    ownerSessionId: string;
    ownerTitle: string;
    job: SidebarJobView;
}
/** Whether the registry still holds the job open (its duration ticks). */
export declare function isJobLive(job: SidebarJobView): boolean;
/**
 * Narrow one client jobs-service roster row into the sidebar's
 * {@link SidebarJobView} mirror; producer-only fields (owner, progress,
 * output coordinates) are dropped.
 * @param job - one row of the `ctx.jobs` roster snapshot.
 * @returns the sidebar's job row.
 */
export declare function toSidebarJobView(job: SidebarClientJobView): SidebarJobView;
/**
 * Map the client jobs service's per-session rosters into the sidebar shape.
 * @param rows - the `ctx.jobs` snapshot's `rows` map.
 * @returns the same session keys with each roster narrowed for presentation.
 */
export declare function mapJobViewRows(rows: Readonly<Record<string, readonly SidebarClientJobView[]>>): Record<string, readonly SidebarJobView[]>;
export { treeSessionIds };
/**
 * Whether a NEW background job appeared for one session between two
 * consecutive list snapshots (a job id the previous snapshot lacked).
 * Unlike the subagent auto-open (0 → N only), ANY new job id triggers: the
 * agent may start several jobs over a session, and each new one should
 * surface the Tasks page containing the background-jobs section (a fresh page
 * load never triggers — its baseline starts at the current snapshot).
 */
export declare function detectNewJob(prev: SidebarSessionList, next: SidebarSessionList, sessionId: string): boolean;
/**
 * Collect the background jobs of the whole current tree, owner-labeled.
 * Sessions without a mirror entry contribute nothing; an absent mirror
 * (runtime older than the jobs feed) yields an empty list.
 */
export declare function collectTreeJobs(byId: SidebarSessionList['byId'], jobsBySession: Readonly<Record<string, readonly SidebarJobView[]>> | undefined, rootId: string | undefined): TreeJob[];
/**
 * Live rows first in start order, then settled rows newest-first (mirror of
 * the official ui-jobs ordering); a tie falls back to start order so the
 * sort never depends on the host's map iteration.
 */
export declare function orderJobs(rows: readonly TreeJob[]): TreeJob[];
/** The sidebar's StateDot states for the five wire statuses. */
export type JobDotState = 'ongoing' | 'warning' | 'done' | 'error';
/**
 * Status marker semantics. `stopping` and `killed` share the attention
 * color: both mean the work ended (or is ending) on request rather than on
 * its own.
 */
export declare function jobDotState(status: SidebarJobStatus): JobDotState;
/** Human status word of one wire status (localized through the passed translator). */
export declare function jobStatusLabel(status: SidebarJobStatus, t: (key: CopyKey, params?: Record<string, string | number>) => string): string;
/**
 * Elapsed time in at most two adjacent units (mirror of the official
 * ui-jobs duration wording). A background job that outlives an hour is
 * already exceptional, so hours is the widest unit.
 */
export declare function formatJobDuration(elapsedMs: number, t: (key: CopyKey, params?: Record<string, string | number>) => string): string;
