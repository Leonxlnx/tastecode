import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'

const git = vi.hoisted(() => ({ running: 0, most: 0, calls: 0 }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFile = Object.assign(vi.fn(), {
    // What promisify(execFile) resolves to: the remote of the folder it ran in.
    [promisify.custom]: async (_file: string, _args: string[], options: { cwd: string }) => {
      git.calls += 1
      git.running += 1
      git.most = Math.max(git.most, git.running)
      await new Promise((resolve) => setTimeout(resolve, 1))
      git.running -= 1
      if (options.cwd.endsWith('local')) throw new Error('No such remote')
      return {
        stdout: `https://github.com/acme/${options.cwd.split('/').at(-1)}.git\n`,
        stderr: '',
      }
    },
  })
  return { ...actual, execFile }
})

const { resolveProjectRepositories } = await import('./pull-requests.js')

describe('project repository discovery', () => {
  it('asks git about every project, a few at a time', async () => {
    const paths = Array.from({ length: 60 }, (_, index) => `/work/repo-${index}`)
    const found = await resolveProjectRepositories([...paths, '/work/local'])
    expect(git.calls).toBe(61)
    expect(git.most).toBeLessThanOrEqual(8)
    expect(found.size).toBe(60)
    expect(found.get('acme/repo-7')).toBe('/work/repo-7')
  })
})
