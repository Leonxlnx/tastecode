import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeInventoryWatchPaths } from './watch-paths.js'

describe('Claude inventory watch paths', () => {
  const home = path.join(path.sep, 'home', 'dev')
  const project = path.join(path.sep, 'work', 'project')

  it("watches the user's and the project's skills, commands, settings and MCP file", () => {
    const watches = claudeInventoryWatchPaths(project, {}, home)
    const config = path.join(home, '.claude')
    expect(watches).toEqual([
      { directory: config, names: ['settings.json', 'skills', 'commands'] },
      { directory: path.join(config, 'skills') },
      { directory: path.join(config, 'commands') },
      { directory: path.join(config, 'plugins'), names: ['installed_plugins.json'] },
      { directory: project, names: ['.mcp.json', '.claude'] },
      {
        directory: path.join(project, '.claude'),
        names: ['settings.json', 'settings.local.json', 'skills', 'commands'],
      },
      { directory: path.join(project, '.claude', 'skills') },
      { directory: path.join(project, '.claude', 'commands') },
    ])
    // Claude rewrites ~/.claude.json whenever a session starts.
    expect(watches.some((watch) => watch.names?.includes('.claude.json'))).toBe(false)
  })

  it('follows CLAUDE_CONFIG_DIR', () => {
    const config = path.join(path.sep, 'profiles', 'work')
    const watches = claudeInventoryWatchPaths(project, { CLAUDE_CONFIG_DIR: config }, home)
    expect(watches[0]).toEqual({
      directory: config,
      names: ['settings.json', 'skills', 'commands'],
    })
    expect(watches.some((watch) => watch.directory.startsWith(path.join(home, '.claude')))).toBe(
      false,
    )
  })
})
