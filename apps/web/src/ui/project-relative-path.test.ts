import { describe, expect, it } from 'vitest'
import { projectRelativePath } from './project-relative-path.js'

describe('projectRelativePath', () => {
  it('shows a Windows path inside the project relative to it, whatever its case', () => {
    expect(
      projectRelativePath(
        String.raw`E:\tastecodetests\testv0.5\test29\src\greet.txt`,
        String.raw`e:\TasteCodeTests\testv0.5\test29`,
      ),
    ).toBe('src/greet.txt')
  })

  it('shows a POSIX path inside the project relative to it', () => {
    expect(projectRelativePath('/Users/karol/app/src/a.ts', '/Users/karol/app/')).toBe('src/a.ts')
  })

  it('leaves paths outside the project, relative paths and the root itself alone', () => {
    expect(projectRelativePath('/Users/karol/other/a.ts', '/Users/karol/app')).toBe(
      '/Users/karol/other/a.ts',
    )
    expect(projectRelativePath('/Users/karol/app-two/a.ts', '/Users/karol/app')).toBe(
      '/Users/karol/app-two/a.ts',
    )
    expect(projectRelativePath('src/a.ts', '/Users/karol/app')).toBe('src/a.ts')
    expect(projectRelativePath('/Users/karol/App/a.ts', '/Users/karol/app')).toBe(
      '/Users/karol/App/a.ts',
    )
    expect(projectRelativePath(String.raw`E:\p\a.txt`, undefined)).toBe(String.raw`E:\p\a.txt`)
  })
})
