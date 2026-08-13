import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { projectFilePath } from './project-file-path.js'

describe('projectFilePath', () => {
  it('accepts Windows and macOS files inside their selected project', () => {
    expect(projectFilePath('E:\\work\\site\\src\\index.ts', 'E:\\work\\site')).toBe(
      'E:\\work\\site\\src\\index.ts',
    )
    expect(projectFilePath('/Users/blue/work/site/src/index.ts', '/Users/blue/work/site')).toBe(
      '/Users/blue/work/site/src/index.ts',
    )
  })

  it('rejects traversal, sibling, drive, relative, and network paths', () => {
    const attempts = [
      () => projectFilePath('E:\\work\\site\\..\\secret.txt', 'E:\\work\\site'),
      () => projectFilePath('E:\\work\\sibling\\secret.txt', 'E:\\work\\site'),
      () => projectFilePath('C:\\work\\site\\secret.txt', 'E:\\work\\site'),
      () => projectFilePath('src\\index.ts', 'E:\\work\\site'),
      () => projectFilePath('\\\\server\\share\\index.ts', 'E:\\work\\site'),
    ]

    for (const attempt of attempts) expect(attempt).toThrow()
  })

  it('expands a stored home-relative project before validating the file', () => {
    const file = path.join(os.homedir(), 'Developer', 'site', 'src', 'index.ts')
    expect(projectFilePath(file, '~/Developer/site')).toBe(file)
    expect(() => projectFilePath('/tmp/Developer/site/secret.ts', '~/Developer/site')).toThrow(
      /outside/,
    )
  })
})
