import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function safeCommandEnvironment(workspace: string): NodeJS.ProcessEnv {
  const runtime = path.join(os.tmpdir(), 'personal-harness-project-tools')
  mkdirSync(runtime, { recursive: true })
  const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null'
  return {
    PATH: process.env['PATH'],
    PATHEXT: process.env['PATHEXT'],
    SYSTEMROOT: process.env['SYSTEMROOT'],
    WINDIR: process.env['WINDIR'],
    COMSPEC: process.env['COMSPEC'],
    TEMP: runtime,
    TMP: runtime,
    HOME: workspace,
    USERPROFILE: workspace,
    APPDATA: runtime,
    LOCALAPPDATA: runtime,
    CI: '1',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: nullFile,
    NPM_CONFIG_USERCONFIG: nullFile,
  }
}
