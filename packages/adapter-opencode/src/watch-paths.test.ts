import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openCodeInventoryWatchPaths } from './watch-paths.js'

describe('OpenCode inventory watch paths', () => {
  const home = path.join(path.sep, 'home', 'dev')
  const project = path.join(path.sep, 'work', 'project')

  it('watches the global and project config, commands and skills, and Claude skills', () => {
    const watches = openCodeInventoryWatchPaths(project, {}, home)
    const config = path.join(home, '.config', 'opencode')
    expect(watches[0]).toEqual({
      directory: config,
      names: ['opencode.json', 'opencode.jsonc', 'command', 'commands', 'skill', 'skills'],
    })
    expect(watches.map((watch) => watch.directory)).toEqual(
      expect.arrayContaining([
        path.join(config, 'command'),
        path.join(config, 'skills'),
        path.join(home, '.claude', 'skills'),
        path.join(project, '.opencode', 'commands'),
        path.join(project, '.opencode', 'skill'),
        path.join(project, '.claude', 'skills'),
      ]),
    )
    expect(watches.find((watch) => watch.directory === project)).toEqual({
      directory: project,
      names: ['opencode.json', 'opencode.jsonc', '.opencode', '.claude'],
    })
  })

  it('follows XDG_CONFIG_HOME', () => {
    const xdg = path.join(path.sep, 'xdg')
    expect(openCodeInventoryWatchPaths(project, { XDG_CONFIG_HOME: xdg }, home)[0]!.directory).toBe(
      path.join(xdg, 'opencode'),
    )
  })
})
