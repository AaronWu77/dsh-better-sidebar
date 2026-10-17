import { describe, expect, it } from 'vitest'
import { resolveSessionPath } from '../src/session-path.ts'

const WSL_CWD = '\\\\wsl.localhost\\archlinux\\home\\zdaar\\project'

describe('resolveSessionPath', () => {
  it.each(["/wsl.localhost/Ubuntu-22.04/home/aaronwu/SuperPlus/README.md","\\wsl.localhost\\Ubuntu-22.04\\home\\aaronwu\\SuperPlus\\README.md"])('restores the explicit WSL share for %s in a Windows drive workspace', path => {
    expect(resolveSessionPath('D:/deepseek-harness', path, 'win32')).toBe("\\\\wsl.localhost\\Ubuntu-22.04\\home\\aaronwu\\SuperPlus\\README.md")
  })

  it('honours an explicitly named distro rather than projecting it under the Session distro', () => {
    expect(resolveSessionPath(WSL_CWD, '/wsl.localhost/Ubuntu-22.04/home/aaronwu/SuperPlus/README.md', 'win32')).toBe("\\\\wsl.localhost\\Ubuntu-22.04\\home\\aaronwu\\SuperPlus\\README.md")
  })

  it('supports the older wsl$ share alias without changing the named distro', () => {
    expect(resolveSessionPath('D:/work', '/wsl$/Ubuntu/home/file.md', 'win32')).toBe("\\\\wsl$\\Ubuntu\\home\\file.md")
    expect(resolveSessionPath("\\\\wsl$\\Ubuntu\\home\\work", '/home/file.md', 'win32')).toBe("\\\\wsl$\\Ubuntu\\home\\file.md")
  })

  it('preserves spaces, Unicode and file-address punctuation under the share', () => {
    expect(resolveSessionPath('D:/work', '/WSL.LOCALHOST/Ubuntu/home/用户/My Project/a#b?.md', 'win32')).toBe("\\\\wsl.localhost\\Ubuntu\\home\\用户\\My Project\\a#b?.md")
  })

  it('does not repair ordinary POSIX paths or similarly named hosts', () => {
    expect(resolveSessionPath('D:/work', '/wsl.localhost.evil/Ubuntu/home/file', 'win32')).toBe('/wsl.localhost.evil/Ubuntu/home/file')
    expect(resolveSessionPath('/work', '/wsl.localhost/Ubuntu/home/file', 'linux')).toBe('/wsl.localhost/Ubuntu/home/file')
    expect(resolveSessionPath('/work', '/wsl.localhost/Ubuntu/home/file', 'darwin')).toBe('/wsl.localhost/Ubuntu/home/file')
  })

  it('maps a Linux absolute path into the WSL distro root on win32', () => {
    expect(resolveSessionPath(WSL_CWD, '/home/zdaar/project/src/a.ts', 'win32'))
      .toBe('\\\\wsl.localhost\\archlinux\\home\\zdaar\\project\\src\\a.ts')
  })

  it('maps a path outside the workspace into the same distro before containment checks', () => {
    expect(resolveSessionPath(WSL_CWD, '/tmp/dsh-issue.md', 'win32'))
      .toBe('\\\\wsl.localhost\\archlinux\\tmp\\dsh-issue.md')
  })

  it('normalizes Linux dot segments without escaping the distro share root', () => {
    expect(resolveSessionPath(WSL_CWD, '/home/zdaar/project/../other/a.ts', 'win32'))
      .toBe('\\\\wsl.localhost\\archlinux\\home\\zdaar\\other\\a.ts')
    expect(resolveSessionPath(WSL_CWD, '/../etc/hosts', 'win32'))
      .toBe('\\\\wsl.localhost\\archlinux\\etc\\hosts')
  })

  it('preserves Windows drive paths in a WSL session', () => {
    const target = 'C:\\Users\\zdaar\\file.md'
    expect(resolveSessionPath(WSL_CWD, target, 'win32')).toBe(target)
  })

  it('preserves UNC paths in a WSL session', () => {
    const backslash = '\\\\server\\share\\file.md'
    const forwardSlash = '//server/share/file.md'
    expect(resolveSessionPath(WSL_CWD, backslash, 'win32')).toBe(backslash)
    expect(resolveSessionPath(WSL_CWD, forwardSlash, 'win32')).toBe(forwardSlash)
  })

  it('does not reinterpret slash-rooted paths for ordinary Windows sessions', () => {
    expect(resolveSessionPath('C:\\Users\\zdaar\\project', '/tmp/a.ts', 'win32')).toBe('/tmp/a.ts')
    expect(resolveSessionPath('\\\\server\\share\\project', '/tmp/a.ts', 'win32')).toBe('/tmp/a.ts')
  })

  it('does not reinterpret paths on non-Windows hosts', () => {
    expect(resolveSessionPath('/home/zdaar/project', '/tmp/a.ts', 'linux')).toBe('/tmp/a.ts')
    expect(resolveSessionPath('/Users/zdaar/project', '/tmp/a.ts', 'darwin')).toBe('/tmp/a.ts')
  })

  it('recognizes wsl.localhost case-insensitively and with forward-slash cwd spelling', () => {
    expect(resolveSessionPath('//WSL.LOCALHOST/Ubuntu/home/me/project', '/home/me/project/a.ts', 'win32'))
      .toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\project\\a.ts')
  })
})
