/** Private document destinations; paths stay in the preview owner's session. */
import { fromMarkdown, type CompileContext, type Handle } from 'mdast-util-from-markdown'
import type { RootContent } from 'mdast'
import { isAbsolutePath } from './paths.ts'

export type DocumentDestination =
  | { kind: 'external' }
  | { kind: 'anchor'; fragment: string }
  | { kind: 'file'; path: string; fragment: string | undefined }
  | { kind: 'invalid' }

/**
 * Decode URL components once; fragments never become filename characters.
 * @param href - Authored document link destination.
 * @param documentPath - The previewed file's path in its session.
 * @returns An external link, local file with separate fragment, anchor, or invalid input.
 */
export function documentDestination(href: string, documentPath: string): DocumentDestination {
  const value = href.trim()
  if (/^(?:https?:|mailto:)/i.test(value)) return { kind: 'external' }
  const hash = value.indexOf('#')
  const source = hash < 0 ? value : value.slice(0, hash)
  if (source.includes('?')) return { kind: 'invalid' }
  let path: string
  let fragment: string | undefined
  try {
    path = decodeURIComponent(source)
    fragment = hash < 0 ? undefined : decodeURIComponent(value.slice(hash + 1))
  } catch (_error) {
    // Malformed escapes cannot identify a local destination.
    return { kind: 'invalid' }
  }
  // eslint-disable-next-line no-control-regex -- File URL input must reject control bytes before navigation.
  if (/[\u0000-\u001f\u007f]/.test(path + (fragment ?? ''))
    || (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path))) return { kind: 'invalid' }
  if (path === '') return fragment === undefined ? { kind: 'invalid' } : { kind: 'anchor', fragment }
  const file = documentPath.replace(/\\/g, '/')
  const directory = file.slice(0, file.lastIndexOf('/') + 1)
  const candidate = (isAbsolutePath(path) ? path : directory + path).replace(/\\/g, '/')
  const root = candidate.startsWith('//') ? /^\/\/[^/]+\/[^/]+\/?/.exec(candidate)?.[0] ?? '//'
    : candidate.startsWith('/') ? '/' : /^[a-z]:\//i.exec(candidate)?.[0] ?? ''
  const segments: string[] = []
  for (const segment of candidate.slice(root.length).split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..' && segments.length > 0 && segments.at(-1) !== '..') segments.pop()
    else if (segment === '..' && root !== '') continue
    else segments.push(segment)
  }
  return { kind: 'file', path: root + segments.join('/'), fragment }
}

/**
 * Adapt document-only destinations to the shared renderer's local-link delegate.
 * @param text - Markdown source; code spans, fences, and image destinations stay untouched.
 * @param documentPath - The previewed file's path in its session.
 * @returns Rewritten source and private destinations for links the shared renderer cannot represent.
 */
export function documentMarkdownLinks(text: string, documentPath: string): {
  text: string
  destinations: ReadonlyMap<string, DocumentDestination>
} {
  let prefix = '__dsh_document_link_'
  while (text.includes(prefix)) prefix += '_'
  const destinations = new Map<string, DocumentDestination>()
  const edits: { start: number; end: number; destination: DocumentDestination; definition?: string }[] = []
  function destination(this: CompileContext, token: Parameters<Handle>[0]): void {
    const url = this.resume()
    const node = this.stack[this.stack.length - 1]
    if (node?.type !== 'link' && node?.type !== 'image' && node?.type !== 'definition') return
    node.url = url
    if (node.type === 'image') return
    const parsed = documentDestination(url, documentPath)
    // Shared file delegates receive decoded paths, including authored encoded filenames.
    while (parsed.kind === 'file' && parsed.path.includes(prefix)) prefix += '_'
    if (parsed.kind === 'external' || parsed.kind === 'invalid') return
    if (parsed.kind === 'file' && !parsed.path.startsWith('//')
      && (parsed.fragment === undefined || /^L[1-9]\d*(?:-L[1-9]\d*)?$/.test(parsed.fragment))) return
    if (token.start.offset === undefined || token.end.offset === undefined) return
    edits.push({ start: token.start.offset, end: token.end.offset, destination: parsed,
      ...(node.type === 'definition' ? { definition: node.identifier } : {}) })
  }
  const tree = fromMarkdown(text, { mdastExtensions: [{ exit: {
    resourceDestinationString: destination,
    definitionDestinationString: destination,
  } }] })
  const references = new Set<string>()
  function visit(node: RootContent): void {
    if (node.type === 'linkReference') references.add(node.identifier)
    if ('children' in node) for (const child of node.children) visit(child)
  }
  for (const child of tree.children) visit(child)
  let rewritten = text
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    if (edit.definition !== undefined && !references.has(edit.definition)) continue
    const extension = edit.destination.kind === 'file' ? /\.[a-z0-9]+$/i.exec(edit.destination.path)?.[0] ?? '' : ''
    const key = `${prefix}${destinations.size}${extension}`
    destinations.set(key, edit.destination)
    rewritten = rewritten.slice(0, edit.start) + key + rewritten.slice(edit.end)
  }
  return { text: rewritten, destinations }
}
