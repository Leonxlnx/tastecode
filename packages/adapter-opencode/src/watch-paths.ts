import os from 'node:os'
import path from 'node:path'

/** A folder to watch without recursion, and the entries in it that matter (all when absent). */
export type OpenCodeInventoryWatch = { directory: string; names?: readonly string[] }

const CONFIG_FILES = ['opencode.json', 'opencode.jsonc']
const FOLDERS = ['command', 'commands', 'skill', 'skills']

/**
 * Where a change can change the commands, skills or MCP servers OpenCode
 * loads for a project: its global config folder (`~/.config/opencode`, or
 * `$XDG_CONFIG_HOME/opencode`), the project's config and `.opencode` folder,
 * and the Claude Code skills it also loads (captured on 1.18.13).
 */
export function openCodeInventoryWatchPaths(
  projectPath: string,
  environment: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): OpenCodeInventoryWatch[] {
  const config = path.join(
    environment.XDG_CONFIG_HOME?.trim() || path.join(home, '.config'),
    'opencode',
  )
  const project = path.join(projectPath, '.opencode')
  const claude = path.join(home, '.claude')
  return [
    { directory: config, names: [...CONFIG_FILES, ...FOLDERS] },
    ...FOLDERS.map((folder) => ({ directory: path.join(config, folder) })),
    { directory: claude, names: ['skills'] },
    { directory: path.join(claude, 'skills') },
    { directory: projectPath, names: [...CONFIG_FILES, '.opencode', '.claude'] },
    { directory: project, names: [...CONFIG_FILES, ...FOLDERS] },
    ...FOLDERS.map((folder) => ({ directory: path.join(project, folder) })),
    { directory: path.join(projectPath, '.claude'), names: ['skills'] },
    { directory: path.join(projectPath, '.claude', 'skills') },
  ]
}
