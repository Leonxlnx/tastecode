import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { captureCli, quoteCmdArgument, spawnCli } from './cli.js'

const argumentsToPreserve = [
  '',
  'plain',
  '--version',
  'repos/owner/repo/pulls/1/files?per_page=100&page=1',
  'a&b|c<d>e^f%PATH%!NAME!(g)',
  'two words',
  'a\tb',
  '"quoted"',
  'a\\"b',
  'path with spaces\\',
  'path with spaces\\\\',
  '"; echo unintended & rem "',
  '日本語 with spaces',
]

function unescapeCmd(value: string): string {
  return value.replace(/\^(.)/gs, '$1')
}

function parseWindowsArgument(value: string): string {
  let result = ''
  let backslashes = 0
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    if (character === '"') {
      result += '\\'.repeat(Math.floor(backslashes / 2))
      if (backslashes % 2) result += '"'
    } else {
      result += '\\'.repeat(backslashes) + character
    }
    backslashes = 0
  }
  return result + '\\'.repeat(backslashes)
}

describe('cmd argument quoting', () => {
  it.each(['plain', '--version', 'owner/repository', 'C:\\safe\\path\\', 'name=value'])(
    'leaves safe argument %s unchanged',
    (value) => {
      expect(quoteCmdArgument(value)).toBe(value)
      expect(quoteCmdArgument(value, true)).toBe(value)
    },
  )

  it.each(['&', '|', '<', '>', '^', '%', '!', '"', '(', ')', ' ', '\t'])(
    'escapes cmd metacharacter %j, not just spaces',
    (character) => {
      const value = `a${character}b`
      const escaped = character === '"' ? '\\^"' : `^${character}`
      expect(quoteCmdArgument(value)).toBe(`^"a${escaped}b^"`)
    },
  )

  it.each([false, true])('round-trips Windows argv with batch=%s', (batch) => {
    for (const value of argumentsToPreserve) {
      let command = quoteCmdArgument(value, batch)
      if (batch) command = unescapeCmd(command)
      expect(parseWindowsArgument(unescapeCmd(command))).toBe(value)
    }
  })

  it('escapes both parses of forwarding batch shims', () => {
    expect(quoteCmdArgument('a&b', true)).toBe('^^^"a^^^&b^^^"')
    expect(quoteCmdArgument('', true)).toBe('^^^"^^^"')
  })

  it.each(['a\nb', 'a\rb', 'a\0b'])('rejects unrepresentable batch input %j', (value) => {
    expect(() => quoteCmdArgument(value)).toThrow('line breaks or NUL')
    expect(() => quoteCmdArgument(value, true)).toThrow('line breaks or NUL')
  })

  it.skipIf(process.platform !== 'win32')(
    'preserves literal arguments through an actual forwarding cmd shim',
    async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-cli-'))
      try {
        const command = path.join(directory, 'echo args.cmd')
        writeFileSync(command, `@echo off\r\n"${process.execPath}" "%~dp0echo.cjs" %*\r\n`)
        writeFileSync(
          path.join(directory, 'echo.cjs'),
          'process.stdout.write(JSON.stringify(process.argv.slice(2)))',
        )
        const result = await captureCli(
          spawnCli(command, argumentsToPreserve, {
            env: { NAME: 'must-not-expand' },
          }),
        )
        expect(result.code).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual(argumentsToPreserve)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
})
