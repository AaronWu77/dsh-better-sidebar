---
kind: upgrade-guide
description: "Agent terminal browser requests require their owning sessionId, and remote terminals use the Session-selected backend rather than node-pty."
---

# Sidebar terminal ownership and remote lifetime

English | [中文](guide.zh.md)

## Change

Better Sidebar 0.19.2 accepted browser agent-terminal attachment and close requests with a UUID alone. `/sidebar/ws/terminal?uuid=...`, `agent-pty.close`, and `agent-pty.skip-wait` now require `sessionId`. A UUID owned by another session is rejected as not found. Attachment also resolves the live or read-only persisted Session header; browser `cwd` hints cannot select its execution host.

UI tabs and model `terminal_*` tools allocate on the same Session-selected remote backend. Remote shell argv and environment belong to the Remote SSH provider; local shell settings do not override them. Missing node-pty only prevents local allocation, not remote allocation or tool registration. Provider failure never falls back to node-pty. Session-scoped `shell.get` reports the remote executable; callers omitting `sessionId` retain local metadata only. Input received during asynchronous attachment is bounded by `terminalInputBufferBytes` (default 256 KiB); overflow closes the view with code 1009 without replay.

GUI terminal reuse requires the same host capability identity, not merely the same POSIX cwd; changing hosts drains the old backend before allocation. Remote terminals survive park frames, bare socket disconnects, and reconnects until explicit close, Session disposal, backend route removal, or plugin disposal. Reconnect replays bounded raw VT output, including prompts. Input is dispatched at most once; a successful send does not confirm shell consumption. Uncertain dispatch fails visibly and is not replayed. Remote SIGINT and SIGTSTP use control keys; SIGTERM, SIGKILL, and SIGHUP request acknowledged backend termination rather than a named POSIX signal.

## Migration

1. Stop the service before installing matched Better Sidebar and Remote SSH integration candidates. The authentication-only `0.19.3-auth.2` tarball does not contain remote terminal integration. Do not install into a running profile with live patch reload.
2. Custom clients must add the actual owning `sessionId` to agent-terminal WebSocket queries and the JSON payloads of `agent-pty.close` and `agent-pty.skip-wait`. The bundled browser client already sends it, including the home session for pinned tabs.
3. Hosts must register the Remote SSH workspace provider and supply authoritative live or persisted Session headers. Configure the remote interactive shell through the provider, not Sidebar's local `shell` or `shellArgs` settings.
4. Confirm that a remote prompt is replayed once after switching sessions or refreshing, that no second backend is allocated, and that another session cannot attach to or close the UUID. Explicitly close unused remote tabs; a disconnected browser does not terminate them.

No Session log or profile setting is rewritten. The separate [Session workspace migration](../sidebar-session-workspace/guide.md) and [authentication migration](../sidebar-authentication/guide.md) still apply.
