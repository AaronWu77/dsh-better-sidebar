/**
 * Open-tab reconciliation after a file-tree mutation (rename/delete).
 *
 * The tree owns the rows; the TABS live wherever the service reports them —
 * the plugin's own layout or DSH's native right Sidebar (`listOpenTabs`).
 * A rename must retarget every tab whose `path` is the renamed file (the
 * editor content survives and later saves land on the new path); a delete
 * must close every tab at or under the removed path — files and anything
 * inside a removed directory (a stale tab's next save would fail against
 * a missing path). Both ride the SERVICE paths (`updateTab`/`closeTab`)
 * rather than direct state reducers so the registered lifecycle callbacks
 * fire like any other tab mutation.
 */
import type { Context } from '../context-types.ts';
/** Retarget tabs after `oldPath` became `newPath` (title follows the new
 *  base name, matching how openFile titles editor tabs). */
export declare function retargetPathTabs(ctx: Context, oldPath: string, newPath: string): void;
/** Close tabs at or under the removed `target` (a directory takes its whole
 *  subtree of open files with it). */
export declare function closePathTabs(ctx: Context, target: string): void;
