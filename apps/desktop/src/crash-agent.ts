import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isInstalled } from '@harness/proc'
import { scrub } from './local-diagnostics.js'

export const CRASH_AGENT_IDS = ['claude-code', 'codex', 'grok'] as const
export type CrashAgentId = (typeof CRASH_AGENT_IDS)[number]

export type CrashAgentAvailability = { id: CrashAgentId; installed: boolean }

export type CrashDetails = {
  name: string
  message: string
  stack: string
  componentStack: string
}

export type CrashEnvironment = {
  appVersion: string
  electronVersion: string
  chromeVersion: string
  platform: NodeJS.Platform
  osRelease: string
  arch: string
  time: string
  diagnosticsLog: string | undefined
}

type AgentCommand = { command: string; args: string[] }

const MAX_FIELD_LENGTH = 6_000
const REPORT_FILE = 'crash-report.md'
const PROMPT_FILE = 'prompt.txt'

/**
 * One line on purpose: it travels through a terminal, a shell and, on Windows,
 * possibly a `.cmd` shim, and only a single line survives all of them intact.
 * The detail lives in the report file next to it.
 */
export const CRASH_AGENT_PROMPT =
  `TasteCode, a desktop app that runs AI coding agents, just crashed while drawing its window. ` +
  `Read ${REPORT_FILE} in this folder, then explain to me in plain language what happened ` +
  `and walk me through fixing it or working around it. ` +
  `Before you change anything outside this folder, tell me what you will change and why.`

export function isCrashAgentId(value: unknown): value is CrashAgentId {
  return typeof value === 'string' && (CRASH_AGENT_IDS as readonly string[]).includes(value)
}

/** Interactive CLI with its own skip-every-approval mode and the prompt as the first turn. */
export function crashAgentCommand(
  id: CrashAgentId,
  home: string = os.homedir(),
  exists: (file: string) => boolean = existsSync,
): AgentCommand {
  switch (id) {
    case 'claude-code':
      return { command: 'claude', args: ['--dangerously-skip-permissions'] }
    case 'codex':
      return { command: 'codex', args: ['--dangerously-bypass-approvals-and-sandbox'] }
    case 'grok': {
      // Same fallback as the Grok adapter: its installer's fixed home survives
      // a stale PATH inherited from the shell that started TasteCode.
      const installed = path.join(
        home,
        '.grok',
        'bin',
        process.platform === 'win32' ? 'grok.exe' : 'grok',
      )
      return {
        command: exists(installed) ? installed : 'grok',
        args: ['--permission-mode', 'bypassPermissions'],
      }
    }
  }
}

export async function crashAgentAvailability(): Promise<CrashAgentAvailability[]> {
  return Promise.all(
    CRASH_AGENT_IDS.map(async (id) => {
      const { command } = crashAgentCommand(id)
      const installed = path.isAbsolute(command) || (await isInstalled(command))
      return { id, installed }
    }),
  )
}

export function parseCrashDetails(value: unknown): CrashDetails {
  const record = typeof value === 'object' && value !== null ? value : {}
  const field = (key: string): string => {
    const raw = (record as Record<string, unknown>)[key]
    return typeof raw === 'string' ? raw.slice(0, MAX_FIELD_LENGTH) : ''
  }
  return {
    name: field('name'),
    message: field('message'),
    stack: field('stack'),
    componentStack: field('componentStack'),
  }
}

/** Every renderer-supplied field is scrubbed: the agent forwards it to its model provider. */
export function crashReport(details: CrashDetails, environment: CrashEnvironment): string {
  const block = (value: string) => '```\n' + scrub(value).replaceAll('```', "'''") + '\n```'
  const section = (title: string, value: string) =>
    value.trim() ? [`## ${title}`, '', block(value.trim()), ''] : []
  return [
    '# TasteCode crash report',
    '',
    'The TasteCode window hit a React render exception and replaced the app with its',
    'recovery screen. The background server and any running agent sessions are separate',
    'processes and keep running. Reloading the window (Ctrl+R, or Cmd+R on macOS) restarts',
    'the interface. Secrets, email addresses and home folder paths below are redacted.',
    '',
    '## Environment',
    '',
    `- TasteCode: ${environment.appVersion}`,
    `- Electron: ${environment.electronVersion} (Chromium ${environment.chromeVersion})`,
    `- OS: ${environment.platform} ${environment.osRelease} (${environment.arch})`,
    `- Time: ${environment.time}`,
    environment.diagnosticsLog
      ? `- Redacted error log: ${environment.diagnosticsLog}`
      : '- Error logging is off (Settings > General > Diagnostics turns it on).',
    '',
    ...section('Error', [details.name, details.message].filter(Boolean).join(': ')),
    ...section('Stack', details.stack),
    ...section('Component stack', details.componentStack),
  ].join('\n')
}

export function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

type TerminalLaunch = {
  script: { name: string; contents: string; executable: boolean }
  spawn: (scriptPath: string) => AgentCommand
}

const LINUX_TERMINALS: ReadonlyArray<{ command: string; prefix: string[] }> = [
  { command: 'x-terminal-emulator', prefix: ['-e'] },
  { command: 'gnome-terminal', prefix: ['--'] },
  { command: 'konsole', prefix: ['-e'] },
  { command: 'xfce4-terminal', prefix: ['-x'] },
  { command: 'xterm', prefix: ['-e'] },
]

/**
 * The prompt never touches a command line we build: the launcher reads it from
 * a file, so only our own temp paths are quoted, each for its one shell.
 */
export function terminalLaunch(
  platform: NodeJS.Platform,
  directory: string,
  agent: AgentCommand,
  linuxTerminal: { command: string; prefix: string[] } | undefined,
  searchPath = '',
): TerminalLaunch {
  const promptFile = path.join(directory, PROMPT_FILE)
  if (platform === 'win32') {
    const contents = [
      `Set-Location -LiteralPath ${powershellQuote(directory)}`,
      `$prompt = (Get-Content -Raw -LiteralPath ${powershellQuote(promptFile)}).Trim()`,
      `& ${[agent.command, ...agent.args].map(powershellQuote).join(' ')} $prompt`,
      '',
    ].join('\r\n')
    return {
      // Windows PowerShell 5.1 reads a BOM-less script as the ANSI code page, which
      // mangles a temp path under a non-ASCII user name.
      script: { name: 'open-agent.ps1', contents: `\uFEFF${contents}`, executable: false },
      // A detached console child gets its own window, which Windows 11 hosts in
      // the user's default terminal app.
      spawn: (scriptPath) => ({
        command: 'powershell.exe',
        args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      }),
    }
  }
  const shell = platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
  const contents = [
    `#!${shell} -l`,
    // The PATH that reported the agent as installed; a login shell may not
    // load the rc file where a user's npm or nvm bin is added.
    ...(searchPath ? [`export PATH=${posixQuote(searchPath)}`] : []),
    `cd ${posixQuote(directory)} || exit 1`,
    `${[agent.command, ...agent.args].map(posixQuote).join(' ')} "$(cat ${posixQuote(promptFile)})"`,
    // Keep the window open on the agent's last words, or on why it did not start.
    `exec "\${SHELL:-${shell}}" -l`,
    '',
  ].join('\n')
  if (platform === 'darwin') {
    return {
      // `open` hands a .command file to whichever terminal the user made default.
      script: { name: 'open-agent.command', contents, executable: true },
      spawn: (scriptPath) => ({ command: 'open', args: [scriptPath] }),
    }
  }
  if (!linuxTerminal) throw new Error('No terminal emulator found')
  return {
    script: { name: 'open-agent', contents, executable: true },
    spawn: (scriptPath) => ({
      command: linuxTerminal.command,
      args: [...linuxTerminal.prefix, shell, '-l', scriptPath],
    }),
  }
}

async function findLinuxTerminal(): Promise<{ command: string; prefix: string[] } | undefined> {
  for (const terminal of LINUX_TERMINALS) {
    if (await isInstalled(terminal.command)) return terminal
  }
  return undefined
}

export async function launchCrashAgent(
  id: CrashAgentId,
  details: CrashDetails,
  environment: CrashEnvironment,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-crash-'))
  await writeFile(path.join(directory, REPORT_FILE), crashReport(details, environment), {
    mode: 0o600,
  })
  await writeFile(path.join(directory, PROMPT_FILE), CRASH_AGENT_PROMPT, { mode: 0o600 })
  const linuxTerminal = process.platform === 'linux' ? await findLinuxTerminal() : undefined
  const launch = terminalLaunch(
    process.platform,
    directory,
    crashAgentCommand(id),
    linuxTerminal,
    process.env.PATH,
  )
  const scriptPath = path.join(directory, launch.script.name)
  await writeFile(scriptPath, launch.script.contents, { mode: 0o600 })
  if (launch.script.executable) await chmod(scriptPath, 0o700)
  const { command, args } = launch.spawn(scriptPath)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: directory,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
