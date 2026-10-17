// @vitest-environment jsdom
/** Scoped document navigation through the real MarkdownDocument renderer. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MarkdownDelegateProvider } from '@deepseek-ai/dsh-client-ui-primitives'
import { MarkdownDocument, type MarkdownHtmlMedia } from '../src/client/MarkdownHtml.tsx'
import { analyzeMarkdownHtml } from '../src/client/markdown-html.ts'
import { setupReactAct } from './test-utils.ts'

setupReactAct()
const mounts: { root: Root; container: HTMLElement }[] = []
const media: MarkdownHtmlMedia = {
  scope: { sessionId: 'document-session', cwd: '/synthetic workspace' },
  path: '/synthetic workspace/docs/README.md',
  origin: 'http://gui.example',
}
const codeLabels = { copyLabel: 'Copy', copiedLabel: 'Copied' }

afterEach(async () => {
  for (const { root, container } of mounts.splice(0)) {
    try { await act(async () => { root.unmount() }) }
    finally { container.remove() }
  }
})

async function render(text: string, scopeMedia = media) {
  const openFile = vi.fn()
  const outerOpenFile = vi.fn()
  const outerExternal = vi.fn()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounts.push({ root, container })
  const rerender = async (source: string): Promise<void> => {
    await act(async () => {
      root.render(createElement(MarkdownDelegateProvider, {
        openFile: outerOpenFile,
        openExternalLink: outerExternal,
        children: createElement(MarkdownDocument, {
          info: analyzeMarkdownHtml(source), media: scopeMedia, codeLabels, openFile,
        }),
      }))
    })
  }
  await rerender(text)
  return { rerender, container, openFile, outerOpenFile, outerExternal }
}

async function click(container: HTMLElement, label: string): Promise<MouseEvent> {
  const target = [...container.querySelectorAll('a, button')].find(element => element.textContent?.trim() === label)
  expect(target, `clickable destination ${label}: ${container.innerHTML}`).toBeDefined()
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
  // Cancel browser navigation after recording whether the document claimed activation.
  let claimed = false
  let observed = false
  const cancelNavigation = (event: Event): void => { observed = true; claimed = event.defaultPrevented; event.preventDefault() }
  container.addEventListener('click', cancelNavigation, { once: true })
  try { await act(async () => { target!.dispatchEvent(event) }) }
  finally { container.removeEventListener('click', cancelNavigation) }
  Object.defineProperty(event, 'documentClaimed', { value: observed ? claimed : event.defaultPrevented })
  return event
}

describe('MarkdownDocument scoped navigation', () => {
  it('opens sibling and parent Markdown links relative to the document, not cwd or chat delegate', async () => {
    const fixture = await render('[Sibling](sibling.md)\n\n[Parent](../guide.md)')
    await click(fixture.container, 'Sibling')
    await click(fixture.container, 'Parent')
    expect(fixture.openFile.mock.calls).toEqual([
      [media.scope, '/synthetic workspace/docs/sibling.md'],
      [media.scope, '/synthetic workspace/guide.md'],
    ])
    expect(fixture.outerOpenFile).not.toHaveBeenCalled()
  })

  it.each(['markdown', 'html'] as const)('decodes %s filenames exactly once and excludes fragments from filenames', async kind => {
    const href = './space%20%23%3F%25%20%E6%96%87%E6%A1%A3.md#L12-L14'
    const fixture = await render(kind === 'markdown' ? `[Encoded](<${href}>)` : `<div><a href="${href}">Encoded</a></div>`)
    await click(fixture.container, 'Encoded')
    expect(fixture.openFile).toHaveBeenCalledExactlyOnceWith(media.scope, '/synthetic workspace/docs/space #?% 文档.md')
  })

  it('claims raw HTML relative anchors before they can navigate under the GUI route', async () => {
    const fixture = await render('<div><a href="../next%20page.md#section">HTML</a></div>')
    const event = await click(fixture.container, 'HTML')
    expect(event).toHaveProperty('documentClaimed', true)
    expect(fixture.openFile).toHaveBeenCalledExactlyOnceWith(media.scope, '/synthetic workspace/next page.md')
  })

  it('opens an inline raw HTML file anchor within Markdown prose', async () => {
    const fixture = await render('See <a href="./inline%20guide.md">Inline</a> here.')
    await click(fixture.container, 'Inline')
    expect(fixture.openFile).toHaveBeenCalledExactlyOnceWith(media.scope, '/synthetic workspace/docs/inline guide.md')
    await fixture.rerender('See <a href="../updated.md">Updated</a> here.')
    await click(fixture.container, 'Updated')
    expect(fixture.openFile).toHaveBeenLastCalledWith(media.scope, '/synthetic workspace/updated.md')
    expect(fixture.container.textContent).not.toContain('Inline')
  })

  it('does not decode percent-like filename text a second time', async () => {
    const fixture = await render('[Percent](./literal%2520.md)')
    await click(fixture.container, 'Percent')
    expect(fixture.openFile).toHaveBeenCalledExactlyOnceWith(media.scope, '/synthetic workspace/docs/literal%20.md')
  })

  it('keeps encoded authored filenames distinct from private link destinations', async () => {
    const fixture = await render('[Real](%5F%5Fdsh_document_link_0.md)\n\n[Section](other.md#section)')
    await click(fixture.container, 'Real')
    await click(fixture.container, 'Section')
    expect(fixture.openFile.mock.calls).toEqual([
      [media.scope, '/synthetic workspace/docs/__dsh_document_link_0.md'],
      [media.scope, '/synthetic workspace/docs/other.md'],
    ])
  })

  it('keeps unsupported document destinations out of displayed navigation titles', async () => {
    const fixture = await render('[Section](./other.md#section)\n\n[UNC](<//synthetic-server/share/file.md>)')
    expect([...fixture.container.querySelectorAll('button')].map(button => button.title)).toEqual([
      '/synthetic workspace/docs/other.md', '//synthetic-server/share/file.md',
    ])
  })

  it.each([
    ['/remote root/docs/README.md', '/remote root', '../next.md', '/remote root/next.md'],
    ['C:\\synthetic root\\docs\\README.md', 'C:\\synthetic root', '../next.md', 'C:/synthetic root/next.md'],
    ['//synthetic-server/share/docs/README.md', '//synthetic-server/share', '../next.md', '//synthetic-server/share/next.md'],
  ])('keeps scope for document %s', async (path, cwd, href, expected) => {
    const scoped = { ...media, path, scope: { sessionId: 'other-document-session', cwd } }
    const fixture = await render(`[Scoped](${href})`, scoped)
    await click(fixture.container, 'Scoped')
    expect(fixture.openFile).toHaveBeenCalledExactlyOnceWith(scoped.scope, expected)
  })

  it.each(['/outside/path.md', 'D:/outside/path.md', '//synthetic-server/share/path.md', '%5C%5Csynthetic-server%5Cshare%5Cpath.md'])('keeps absolute %s inside the document session', async href => {
    const fixture = await render(`[Absolute](<${href}>)`)
    await click(fixture.container, 'Absolute')
    expect(fixture.openFile).toHaveBeenCalledExactlyOnceWith(media.scope, decodeURIComponent(href).replace(/\\/g, '/'))
  })

  it('opens a raw HTML Windows drive path without treating it as a URL scheme', async () => {
    const fixture = await render('<div><a href="D:/synthetic%20root/file.md">Drive</a></div>')
    await click(fixture.container, 'Drive')
    expect(fixture.openFile).toHaveBeenCalledExactlyOnceWith(media.scope, 'D:/synthetic root/file.md')
  })

  it.each(['markdown', 'html'] as const)('handles %s pure anchors within this document without reopening a file', async kind => {
    const fixture = await render(`${kind === 'markdown' ? '[Jump](#section)' : '<div><a href="#section">Jump</a></div>'}\n\n<div id="section">Destination</div>`)
    const destination = fixture.container.querySelector('#section')!
    const scroll = vi.fn()
    Object.defineProperty(destination, 'scrollIntoView', { value: scroll })
    const event = await click(fixture.container, 'Jump')
    if (kind === 'html') expect(event).toHaveProperty('documentClaimed', true)
    expect(scroll).toHaveBeenCalledOnce()
    expect(fixture.openFile).not.toHaveBeenCalled()
  })

  it('retains native HTTP(S) and mailto behavior without inheriting chat external interception', async () => {
    const fixture = await render('[Web](https://example.com/path)\n\n[Mail](mailto:test@example.com)\n\n<div><a href="http://example.com">HTML Web</a></div>')
    for (const label of ['Web', 'Mail', 'HTML Web']) {
      const event = await click(fixture.container, label)
      expect(event).toHaveProperty('documentClaimed', false)
    }
    expect(fixture.openFile).not.toHaveBeenCalled()
    expect(fixture.outerExternal).not.toHaveBeenCalled()
  })

  it.each(['javascript:alert(1)', 'data:text/html,bad', 'file:///outside/path.md', './bad%ZZ.md', './bad%00.md', './next.md?query=1'])('does not open or route invalid destination %s', async href => {
    const fixture = await render(`[Bad](<${href}>)\n\n<div><a href="${href}">HTML Bad</a></div>`)
    for (const element of fixture.container.querySelectorAll('a, button')) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true })
      await act(async () => { element.dispatchEvent(event) })
      if (element.hasAttribute('href')) expect(event.defaultPrevented).toBe(true)
    }
    expect(fixture.openFile).not.toHaveBeenCalled()
  })

  it('keeps code examples inert and resolves reference links', async () => {
    const fixture = await render('`[Code](./code.md)`\n\n[Reference][guide]\n\n[guide]: ../reference%20guide.md#section')
    expect(fixture.container.querySelector('code')?.textContent).toBe('[Code](./code.md)')
    await click(fixture.container, 'Reference')
    expect(fixture.openFile).toHaveBeenCalledExactlyOnceWith(media.scope, '/synthetic workspace/reference guide.md')
  })
})
