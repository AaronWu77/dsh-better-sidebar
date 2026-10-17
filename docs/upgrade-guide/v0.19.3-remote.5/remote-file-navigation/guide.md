---
kind: upgrade-guide
description: "Remote conversation file links retain their Session address instead of opening a local download snapshot in the remote editor."
---

# Keep remote file navigation in the owning Session

English | [中文](guide.zh.md)

## Change

The matched `0.19.3-remote.6` and Remote SSH `0.2.4-aaron.12-sidebar.6` pair keeps conversation file links in Better Sidebar's native editor. Remote SSH does not launch an external editor or substitute a Windows download-cache address while this native editor is active. Standalone Remote SSH and its explicit external-open endpoint retain their editor/download behavior.

Produced-file actions target the source Session independently of the bottom workbench selection. Native folder opens retain their directory intent, and native Git file actions receive the same scope-bound editor callback. Git editor actions use the server-returned Session cwd for the workspace fence, not a Windows alias compared with a POSIX file path; pending or failed metadata does not allow a fenced open. Markdown and sanitized HTML file links resolve relative to the previewed document without inheriting chat navigation. Cross-file line/section fragments are excluded from filenames but are not revealed by the public opener. The client service reports the installed package version.

Remote alias containment and retired-route rejection remain enabled. A remote editor does not fall back to local files. This release does not optimize large-workspace filename-search latency or enable the remote `sidebar_open` tool.

## Migration

1. Stop the Web service and back up its current profile files. Install the two `.6` archives together; do not mix pair versions or replace files while the service runs.
2. Preserve the existing SSH mapping and Sidebar settings. Enable Better Sidebar's editor tab. No Session-data migration or cache-directory deletion is required.
3. Start Web normally and refresh the existing page. In the same remote task, open one README first from the file tree and then from its conversation link. Both must show remote content without a `Temp/dsh-remote-ssh/open-file` address or an outside-alias error.
4. Check produced-file opens with an unselected bottom workbench, native directory opens, and Git's editor action. Keep explicit external editor/download checks separate from in-app preview checks.
5. To roll back, stop Web, reinstall both `.5` archives, restore only the backup taken for this maintenance, then start and refresh. Do not remove aliases, retired-alias records, or Session data.
