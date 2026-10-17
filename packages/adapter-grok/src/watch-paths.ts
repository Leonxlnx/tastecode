import os from 'node:os'
import path from 'node:path'

/** A folder to watch without recursion, and the entries in it that matter (all when absent). */
export type GrokInventoryWatch = { directory: string; names?: readonly string[] }

/**
 * Where a change can change the commands, skills or MCP servers Grok loads for
 * a project: its own configuration and skills, and the Claude Code skills it
 * also reads (grok 1.0.62 `inspect`). `~/.claude.json`, which Grok reads for
 * MCP servers, is left out for the reason Claude's watch leaves it out: every
 * Claude session rewrites it. `sessions` is never watched; the probe writes there.
 */
export function grokInventoryWatchPaths(
  projectPath: string,
  environment: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): GrokInventoryWatch[] {
  const grok = environment.GROK_HOME?.trim() || path.join(home, '.grok')
  const claude = path.join(home, '.claude')
  return [
    { directory: grok, names: ['config.toml', 'skills', 'plugins'] },
    { directory: path.join(grok, 'skills') },
    { directory: claude, names: ['skills'] },
    { directory: path.join(claude, 'skills') },
    { directory: projectPath, names: ['.grok', '.claude', '.mcp.json'] },
    { directory: path.join(projectPath, '.grok'), names: ['config.toml', 'skills'] },
    { directory: path.join(projectPath, '.grok', 'skills') },
    { directory: path.join(projectPath, '.claude'), names: ['skills'] },
    { directory: path.join(projectPath, '.claude', 'skills') },
  ]
}
