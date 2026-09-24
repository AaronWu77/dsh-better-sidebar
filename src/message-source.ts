/**
 * Producer-owned message source for the content this plugin injects into a
 * session: the Side Chat boundary prompt and its parked in-progress snapshot.
 *
 * DSH Session format V4 refuses the retired `kind: 'plugin'` wrapper — every
 * interpreted message slot requires a nonempty producer kind (see
 * dsh-session-format-v3-to-v4's source admission). Declaration merging adds
 * this plugin's kind to the llm source map; the host entry imports this module
 * for its side effect so the augmentation is in the program.
 */
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-better-sidebar': { kind: 'dsh-better-sidebar' } & ContextFormed
  }
}

export {}
