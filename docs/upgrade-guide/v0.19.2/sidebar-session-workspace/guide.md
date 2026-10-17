---
kind: upgrade-guide
description: "Sidebar workspace requests require a live or persisted session header instead of a browser cwd or host process fallback."
---

# Sidebar workspace routing requires an authoritative session

English | [中文](guide.zh.md)

## Change

Better Sidebar 0.19.2 accepted the browser's `cwd` hint while a session was detached and used the host process directory when no header was available. Workspace requests now read the live session header first, then open the persisted header read-only. Routing does not read the event log, and it closes the read handle.

Browser `cwd` fields no longer choose the execution root. An unavailable session without persistence returns HTTP 404. A live or persisted header without a valid absolute `cwd` returns HTTP 400. This applies to workspace API requests, media and HTML previews, uploads, and terminal allocation. Disabling `workspaceFence` permits access outside the session directory; it does not supply a missing session or select another execution host.

When the host provides `remoteSshManager`, it must also register a router with `ctx.sidebarWorkspaceProviders`. Once Sidebar observes a manager or router, a missing router returns HTTP 503 throughout that Sidebar instance's lifetime, including after manager removal. Only a replacement router's explicit local result enables local execution. The public `dsh-better-sidebar/workspace-provider` entry provides declarations for type-only imports, not a runtime module. Contributions must return their disposer from an owning effect. Install the matched integration candidates together after stopping the service; the authentication-only `0.19.3-auth.2` tarball does not contain this change.

## Migration

1. Custom clients must send the real `sessionId` returned by the host. Do not use an arbitrary identifier plus `cwd` as a replacement for a stored session.
2. Hosts that serve detached sessions must provide `sessionPersistence.open(id, 'read')` with a header containing the session's absolute working directory and a closable handle. Live sessions must expose that directory in their header. Do not substitute the browser summary or `process.cwd()`.
3. Confirm that `session.cwd` returns the authoritative directory for a live session and a detached persisted session, even when the request contains a different `cwd`. Confirm that an unknown session is rejected rather than redirected to the host directory.

This change does not rewrite session logs or profile settings. The separate [authentication migration](../sidebar-authentication/guide.md) still applies.
