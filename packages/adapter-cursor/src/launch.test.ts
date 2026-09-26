import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { planCursorLaunch, resolveWindowsCursorLaunch, type CursorLaunchFs } from './launch.js'

const root = path.win32.join('C:\\Users\\emili\\AppData\\Local', 'cursor-agent')
const older = '2026.09.23-86fc751'
const newer = '2026.09.26-dd393fe'
const sameDayEarly = '2026.09.26-01-02-03-aaaa'

function layout(files: string[], versions: string[]): CursorLaunchFs {
  const present = new Set(files)
  return {
    exists: (file) => present.has(file),
    list: (directory) => {
      if (directory !== path.win32.join(root, 'versions')) throw new Error(`missing ${directory}`)
      return versions
    },
  }
}

function versionFiles(name: string): string[] {
  return [
    path.win32.join(root, 'versions', name, 'node.exe'),
    path.win32.join(root, 'versions', name, 'index.js'),
  ]
}

describe('Windows cursor-agent launch', () => {
  it('picks the newest version directory and skips cmd.exe', () => {
    const fs = layout(
      [path.win32.join(root, 'cursor-agent.cmd'), ...versionFiles(older), ...versionFiles(newer)],
      [older, newer, 'not-a-version'],
    )
    const launch = resolveWindowsCursorLaunch(root, fs)
    expect(launch).toEqual({
      nodePath: path.win32.join(root, 'versions', newer, 'node.exe'),
      indexPath: path.win32.join(root, 'versions', newer, 'index.js'),
    })

    const planned = planCursorLaunch(
      'cursor-agent',
      ['--print', '--output-format', 'stream-json'],
      {
        platform: 'win32',
        env: {
          LOCALAPPDATA: 'C:\\Users\\emili\\AppData\\Local',
          PATH: 'C:\\Windows\\System32',
        },
        fs,
      },
    )
    expect(planned?.command).toBe(path.win32.join(root, 'versions', newer, 'node.exe'))
    expect(planned?.args).toEqual([
      path.win32.join(root, 'versions', newer, 'index.js'),
      '--print',
      '--output-format',
      'stream-json',
    ])
    expect(planned?.env.CURSOR_INVOKED_AS).toBe('cursor-agent')
    expect(planned?.env.NODE_COMPILE_CACHE).toBe(
      path.win32.join('C:\\Users\\emili\\AppData\\Local', 'cursor-compile-cache'),
    )
    expect(planned?.env.PATH?.toLowerCase()).toContain('cursor-agent')
  })

  it('prefers node.exe beside the installer script', () => {
    const fs = layout(
      [
        path.win32.join(root, 'cursor-agent.cmd'),
        path.win32.join(root, 'node.exe'),
        path.win32.join(root, 'index.js'),
        ...versionFiles(newer),
      ],
      [newer],
    )
    expect(resolveWindowsCursorLaunch(root, fs)).toEqual({
      nodePath: path.win32.join(root, 'node.exe'),
      indexPath: path.win32.join(root, 'index.js'),
    })
  })

  it('breaks a same-day tie with the directory name', () => {
    const fs = layout(
      [
        path.win32.join(root, 'cursor-agent.cmd'),
        ...versionFiles(sameDayEarly),
        ...versionFiles(newer),
      ],
      [sameDayEarly, newer],
    )
    expect(resolveWindowsCursorLaunch(root, fs)?.nodePath).toBe(
      path.win32.join(root, 'versions', newer, 'node.exe'),
    )
  })

  it('leaves non-Windows launches on the normal PATH command', () => {
    const fs = layout([path.win32.join(root, 'cursor-agent.cmd'), ...versionFiles(newer)], [newer])
    expect(
      planCursorLaunch('cursor-agent', ['--print'], {
        platform: 'linux',
        env: { LOCALAPPDATA: 'C:\\Users\\emili\\AppData\\Local' },
        fs,
      }),
    ).toBeUndefined()
  })
})
