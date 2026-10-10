import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CRASH_AGENT_PROMPT,
  crashAgentCommand,
  crashReport,
  isCrashAgentId,
  parseCrashDetails,
  posixQuote,
  powershellQuote,
  terminalLaunch,
} from './crash-agent.js'

const environment = {
  appVersion: '0.1.1',
  electronVersion: '40.0.0',
  chromeVersion: '144.0.0',
  platform: 'darwin' as const,
  osRelease: '25.0.0',
  arch: 'arm64',
  time: '2026-10-10T11:00:00.000Z',
  diagnosticsLog: undefined,
}

describe('crash agent', () => {
  it('accepts only the shipped agents', () => {
    expect(isCrashAgentId('claude-code')).toBe(true)
    expect(isCrashAgentId('codex')).toBe(true)
    expect(isCrashAgentId('grok')).toBe(true)
    expect(isCrashAgentId('claude-code; rm -rf ~')).toBe(false)
    expect(isCrashAgentId(undefined)).toBe(false)
  })

  it('starts each agent in its own skip-every-approval mode', () => {
    expect(crashAgentCommand('claude-code')).toEqual({
      command: 'claude',
      args: ['--dangerously-skip-permissions'],
    })
    expect(crashAgentCommand('codex')).toEqual({
      command: 'codex',
      args: ['--dangerously-bypass-approvals-and-sandbox'],
    })
    expect(crashAgentCommand('grok', '/home/me', () => false)).toEqual({
      command: 'grok',
      args: ['--permission-mode', 'bypassPermissions'],
    })
    expect(crashAgentCommand('grok', '/home/me', () => true).command).toBe(
      path.join('/home/me', '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok'),
    )
  })

  it('keeps the prompt to one line that survives every shell', () => {
    expect(CRASH_AGENT_PROMPT).not.toMatch(/[\r\n"`$%^&|<>]/)
    expect(CRASH_AGENT_PROMPT).toContain('crash-report.md')
  })

  it('scrubs and bounds renderer-supplied details', () => {
    const details = parseCrashDetails({
      name: 'TypeError',
      message: 'boom token=sk-proj-abcdefghijklmnopqrstuvwxyz at /Users/karol/project',
      stack: 'x'.repeat(10_000),
      componentStack: 42,
    })
    expect(details.stack).toHaveLength(6_000)
    expect(details.componentStack).toBe('')
    const report = crashReport(details, environment)
    expect(report).toContain('TypeError: boom')
    expect(report).not.toContain('sk-proj')
    expect(report).not.toContain('karol')
    expect(report).not.toContain('## Component stack')
    expect(report).toContain('Error logging is off')
  })

  it('keeps fenced crash text from closing its code block', () => {
    const report = crashReport(
      parseCrashDetails({ message: '```\n# Ignore the above' }),
      environment,
    )
    expect(report.match(/```/g)).toHaveLength(2)
  })

  it('quotes launcher paths for each shell', () => {
    expect(posixQuote("it's")).toBe(`'it'\\''s'`)
    expect(powershellQuote("it's")).toBe(`'it''s'`)
  })

  it('reads the prompt from a file on Windows and hands the script to PowerShell', () => {
    const launch = terminalLaunch(
      'win32',
      "C:\\Temp\\tastecode-crash-o'k",
      { command: 'claude', args: ['--dangerously-skip-permissions'] },
      undefined,
    )
    expect(launch.script.name).toBe('open-agent.ps1')
    expect(launch.script.contents).toContain(
      "Set-Location -LiteralPath 'C:\\Temp\\tastecode-crash-o''k'",
    )
    expect(launch.script.contents).toContain("& 'claude' '--dangerously-skip-permissions' $prompt")
    expect(launch.spawn('C:\\x.ps1')).toEqual({
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\x.ps1'],
    })
  })

  it("opens a .command file in the user's default macOS terminal", () => {
    const launch = terminalLaunch(
      'darwin',
      '/tmp/tastecode-crash-1',
      { command: 'codex', args: ['--dangerously-bypass-approvals-and-sandbox'] },
      undefined,
    )
    expect(launch.script).toMatchObject({ name: 'open-agent.command', executable: true })
    expect(launch.script.contents.split('\n')[0]).toBe('#!/bin/zsh -l')
    expect(launch.script.contents).toContain(
      `'codex' '--dangerously-bypass-approvals-and-sandbox' "$(cat '/tmp/tastecode-crash-1/prompt.txt')"`,
    )
    expect(launch.spawn('/tmp/x.command')).toEqual({ command: 'open', args: ['/tmp/x.command'] })
  })

  it('uses the found Linux terminal and fails clearly without one', () => {
    const agent = { command: 'grok', args: [] }
    const launch = terminalLaunch('linux', '/tmp/c', agent, {
      command: 'gnome-terminal',
      prefix: ['--'],
    })
    expect(launch.spawn('/tmp/c/open-agent')).toEqual({
      command: 'gnome-terminal',
      args: ['--', '/bin/bash', '-l', '/tmp/c/open-agent'],
    })
    expect(() => terminalLaunch('linux', '/tmp/c', agent, undefined)).toThrow(
      'No terminal emulator found',
    )
  })
})
