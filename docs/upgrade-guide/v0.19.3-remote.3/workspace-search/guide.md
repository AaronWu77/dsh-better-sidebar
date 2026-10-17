---
kind: upgrade-guide
description: "Workspace providers return relative filename matches and truncation status instead of remote entry arrays."
---
# Workspace filename search results

English | [中文](guide.zh.md)

## Change

Better Sidebar `0.19.3-remote.5` and Remote SSH `0.2.4-aaron.12-sidebar.5` use `SidebarWorkspaceFiles.search(query, signal?)` returning `{ matches: string[], truncated: boolean }`. The previous remote entry array is incompatible. Each match is relative to the authoritative Session root and uses `/` separators; directory and lexical symlink names may also match. Folder pages resolve those matches against the authoritative `session.cwd` reply, not their displayed subdirectory.

Search limits return partial success with `truncated: true`, including an empty partial result, rather than HTTP 413. This does not mean every file was searched. Transport, permission and workspace-fence failures still reject. Existing `searchMaxRows`, `searchMaxItems` and `searchMaxDepth` values remain effective. AHP still transfers a complete directory listing; only inspection, metadata work, queued traversal and returned matches are bounded.

Caller cancellation stops traversal and suppresses stale browser replies. Providers must accept the optional signal and settle outstanding work before releasing ownership. A non-abortable AHP listing must settle before cancellation cleanup completes.

## Migration

1. Retain the `.3` archives and back up the Web profile manifest, lockfile and patch. Stop the Web service before replacing packages; its patch watcher can reload plugins without a restart.
2. Install `dsh-better-sidebar-0.19.3-remote.5.tgz` and `dsh-remote-ssh-0.2.4-aaron.12-sidebar.5.tgz` together, Sidebar first. Custom providers must update `SidebarWorkspaceFiles.search` to the object result and optional `AbortSignal`. Do not mix provider generations or raise limits to hide truncation.
3. Start the Web service yourself, then refresh the existing GUI. Confirm that clicking a file opens its editor in that native body's Session and that filename search opens relative matches. A bounded search displays a partial-result notice; a newer query must not be replaced by an old reply. These production checks belong to the operator after installation.
4. Keep existing workspace mappings, fences and Session data. No data migration is required. For rollback, stop the service, restore both `.3` packages and the retained profile files, then restart and refresh.
