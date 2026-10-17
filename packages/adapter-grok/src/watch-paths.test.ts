import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { grokInventoryWatchPaths } from './watch-paths.js'

describe('Grok inventory watch paths', () => {
  const home = path.join(path.sep, 'home', 'dev')
  const project = path.join(path.sep, 'work', 'project')

  it("watches Grok's and the Claude skills it reads, never its sessions", () => {
    const watches = grokInventoryWatchPaths(project, {}, home)
    const grok = path.join(home, '.grok')
    expect(watches).toEqual([
      { directory: grok, names: ['config.toml', 'skills', 'plugins'] },
      { directory: path.join(grok, 'skills') },
      { directory: path.join(home, '.claude'), names: ['skills'] },
      { directory: path.join(home, '.claude', 'skills') },
      { directory: project, names: ['.grok', '.claude', '.mcp.json'] },
      { directory: path.join(project, '.grok'), names: ['config.toml', 'skills'] },
      { directory: path.join(project, '.grok', 'skills') },
      { directory: path.join(project, '.claude'), names: ['skills'] },
      { directory: path.join(project, '.claude', 'skills') },
    ])
    // Each probe writes a session folder; watching it would probe again forever.
    expect(watches.some((watch) => watch.directory.includes('sessions'))).toBe(false)
    expect(watches.some((watch) => watch.names?.includes('sessions'))).toBe(false)
  })

  it('follows GROK_HOME', () => {
    const grok = path.join(path.sep, 'profiles', 'grok')
    const watches = grokInventoryWatchPaths(project, { GROK_HOME: grok }, home)
    expect(watches.slice(0, 2)).toEqual([
      { directory: grok, names: ['config.toml', 'skills', 'plugins'] },
      { directory: path.join(grok, 'skills') },
    ])
  })
})
