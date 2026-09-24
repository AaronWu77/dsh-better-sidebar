import type { Context } from '../context-types.ts';
import { type SidebarStore } from './state.ts';
/** Open a file in the sidebar's editor (used by the intercepted row and the explorer). */
export declare function openSidebarFile(ctx: Context, store: SidebarStore, sessionId: string, path: string): void;
/**
 * Reveal the produced files in the sidebar explorer: expand their parent
 * directories, highlight the rows, and focus the explorer tab. Unknown
 * files fall back to revealing the workspace root itself.
 */
export declare function revealInExplorer(ctx: Context, store: SidebarStore, sessionId: string, files: readonly string[]): void;
/** The turn-tail owner currency the slot supplies (structural mirror). */
interface TurnTailOwnerProps {
    /** The closing Turn, whose `deliverables` data names the produced files. */
    turn?: {
        data?: {
            get?: (key: string) => unknown;
        };
    };
    /** Finalized nodes in surface order (the node-based fallback). */
    nodes?: unknown;
    /** The closing assistant's seq. */
    seq?: unknown;
}
/** The intercepted produced-files row (visual twin of the deliverables chips). */
export declare function SidebarProducedFiles(props: TurnTailOwnerProps & {
    openInSidebar: (path: string) => void;
    /** Reveal the produced files in the explorer ("Show in folder" twin). */
    onShowInFolder: (files: readonly string[]) => void;
    /** The shared store, read for the decline checks. */
    store: SidebarStore;
}): import("react").JSX.Element | null;
/**
 * Register the turn-tail interception (returns the disposer).
 *
 * The slot is a CHILD slot the host's ui-conversation declares in its
 * `conversation.chat.node` children table (kind: list, scope: session).
 * Registering it directly races the declaration — the ui-slots core's
 * load-time validation throws "not declared (a parent entry's children
 * table must declare it)" when the parent entry is not on the ledger yet.
 * slots.inject waits for the declaration: the callback runs synchronously
 * when the slot is already declared, otherwise it runs inside the declaring
 * register() call once the declaration commits; declaration collapse
 * disposes the entry and a later declaration re-registers it. This mirrors
 * @deepseek-ai/dsh-client-ui-deliverables' registration of the same slot.
 */
export declare function registerTurnTailInterception(ctx: Context, store: SidebarStore): () => void;
export {};
