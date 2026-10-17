---
kind: upgrade-guide
description: Sidebar HTTP and WebSocket access now requires the host's authenticated browser session.
---
# Sidebar browser authentication

## Change

The `0.19.3-auth.2` candidate replaces Better Sidebar's trust-only request checks with the host's `connection.requestRejection` admission API. All sidebar API, upload, media, HTML, lazy-bundle and WebSocket routes require the same authenticated browser session as the host gateway. Missing or invalid login receives 401; an untrusted request receives 403. Requests are rejected before reading bodies, files or allocating terminals.

Custom hosts must provide the `connection` service with `requestRejection`. The plugin fails activation if the required API is absent; it does not fall back to unauthenticated access. This candidate is being verified against DSH `0.2.0-rc.2`; compatibility with older hosts is not claimed.

## Migration

1. Open the fresh launch URL printed by your own `dsh web` process to establish the browser login cookie. Do not put a token in sidebar URLs or log cookies.
2. Update custom hosts to provide authenticated Connection admission. Update test contexts to supply an explicitly authenticated admission implementation; retain separate missing-login and untrusted-request tests.
3. For a deployment that must update only after restart, stop the Web service before changing profile dependencies. A profile using `patchReload: live` may otherwise apply installation changes immediately. Preserve the previous package reference and profile configuration for rollback; do not install this candidate into a running profile.
4. After installation and restart, confirm that a request without a cookie to `/sidebar/api/terminal.deps` returns 401 and that the logged-in browser can use the sidebar. Confirm that a cross-site request is refused with 403.

This authentication-only candidate does not add remote filesystem, Git or terminal support and does not migrate session data. Reinstalling an older candidate removes this protection; treat rollback as restoring the previous exposure, not as a security-equivalent configuration.
