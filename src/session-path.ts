import { win32 } from 'node:path'

/** Windows-hosted WSL share, with either supported hostname and separator spelling. */
const WSL_ROOT = /^\/\/(wsl\.localhost|wsl\$)\/([^/]+)(?:\/|$)/i
/** An explicit WSL share whose second leading separator was lost by a caller. */
const WSL_ROOTED_TARGET = /^\/(wsl\.localhost|wsl\$)\/([^/]+)(?:\/|$)/i

/**
 * Resolve an absolute path in the Windows Session's filesystem namespace.
 * Explicit single-separator WSL share addresses regain their UNC root before
 * drive resolution. Linux absolute paths in WSL Sessions use that Session's
 * distro. Other Windows paths and all non-Windows hosts retain their spelling.
 * The caller still resolves symlinks and enforces workspace containment.
 * @param cwd - Authoritative Session directory, not browser-supplied context.
 * @param target - Requested absolute or workspace-relative path.
 * @param platform - Filesystem host platform.
 * @returns A WSL UNC path when projection is needed, otherwise the input.
 */
export function resolveSessionPath(
  cwd: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return target
  const normalizedTarget = target.replace(/\\/g, '/')
  const explicit = WSL_ROOTED_TARGET.exec(normalizedTarget)
  if (explicit !== null) {
    const distroRoot = '\\\\' + explicit[1]!.toLowerCase() + '\\' + explicit[2]!
    return win32.resolve(distroRoot, normalizedTarget.slice(explicit[0].length).replace(/\//g, '\\'))
  }
  if (!target.startsWith('/') || target.startsWith('//')) return target
  const normalizedCwd = cwd.replace(/\\/g, '/')
  const session = WSL_ROOT.exec(normalizedCwd)
  if (session === null) return target
  const distroRoot = '\\\\' + session[1]!.toLowerCase() + '\\' + session[2]!
  return win32.resolve(distroRoot, target.slice(1).replace(/\//g, '\\'))
}
