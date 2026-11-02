import os from 'node:os'
import path from 'node:path'

/** A folder to watch without recursion, and the entries in it that matter (all when absent). */
export type ClaudeInventoryWatch = { directory: string; names?: readonly string[] }

/**
 * Where a change can change the commands, skills or MCP servers Claude Code
 * loads for a project. `~/.claude.json` also holds user and local MCP servers,
 * but Claude rewrites it whenever any Claude session starts, so watching it
 * would re-read the inventory constantly; those servers refresh with the
 * cached answer's expiry or the next chat instead.
 */
export function claudeInventoryWatchPaths(
  projectPath: string,
  environment: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): ClaudeInventoryWatch[] {
  const config = environment.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude')
  const project = path.join(projectPath, '.claude')
  return [
    { directory: config, names: ['settings.json', 'skills', 'commands'] },
    { directory: path.join(config, 'skills') },
    { directory: path.join(config, 'commands') },
    { directory: path.join(config, 'plugins'), names: ['installed_plugins.json'] },
    { directory: projectPath, names: ['.mcp.json', '.claude'] },
    {
      directory: project,
      names: ['settings.json', 'settings.local.json', 'skills', 'commands'],
    },
    { directory: path.join(project, 'skills') },
    { directory: path.join(project, 'commands') },
  ]
}
