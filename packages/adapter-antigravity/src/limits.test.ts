import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { AgySpawn } from './command.js'
import { agyAnswersUsage, antigravityLimitSource, mapAgyUsage } from './limits.js'

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

/** agy 1.4.7, `-p /usage --output-format json`, Windows pipes, stdin closed (2026-10-31). */
const USAGE_1_4_7 = fixture('agy-usage-1.4.7.json')
/** agy printed the object on one line; the fixture file is formatted. */
const USAGE_STDOUT = `${JSON.stringify(JSON.parse(USAGE_1_4_7))}\n`

type Answer = { stdout: string; stderr?: string; code: number }

/** A one-shot agy as captureCli reads it. */
class FakeAgy extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  signalCode = null
  pid = undefined
  kill(): boolean {
    return true
  }
  finish(answer: Answer): void {
    this.stdout.end(answer.stdout)
    this.stderr.end(answer.stderr ?? '')
    this.exitCode = answer.code
    setImmediate(() => this.emit('close', answer.code, null))
  }
}

/** Answers `--version` and `-p /usage` and records every start. */
function fakeAgy(answers: { version: Answer; usage?: Answer }) {
  const calls: string[][] = []
  const spawn: AgySpawn = (_command, args) => {
    calls.push(args)
    const child = new FakeAgy()
    const answer = args[0] === '--version' ? answers.version : answers.usage
    if (!answer) throw new Error(`unexpected agy ${args.join(' ')}`)
    queueMicrotask(() => child.finish(answer))
    return child as unknown as ChildProcessWithoutNullStreams
  }
  return { spawn, calls }
}

const VERSION_1_4_7: Answer = { stdout: '1.4.7\n', code: 0 }

describe('mapAgyUsage', () => {
  it('maps the captured buckets per model group, shorter window first', () => {
    expect(mapAgyUsage(JSON.parse(USAGE_1_4_7))).toEqual({
      status: 'ready',
      limits: [
        { id: 'gemini-5h', label: 'Gemini 5 hours', usedPercent: 0, windowMinutes: 300 },
        {
          id: 'gemini-weekly',
          label: 'Gemini weekly',
          usedPercent: 0.48,
          resetsAt: Date.parse('2026-11-06T00:54:37Z'),
          windowMinutes: 10_080,
        },
        { id: '3p-5h', label: 'Claude and GPT 5 hours', usedPercent: 0, windowMinutes: 300 },
        { id: '3p-weekly', label: 'Claude and GPT weekly', usedPercent: 0, windowMinutes: 10_080 },
      ],
    })
  })

  // Derived from the capture: no exhausted or disabled bucket has been captured yet.
  it('takes a bucket without a fraction from its text line and leaves out a disabled one', () => {
    const captured = JSON.parse(USAGE_1_4_7)
    const [gemini] = captured.command.data.groups
    delete gemini.buckets[0].remaining_fraction
    gemini.buckets[1].disabled = true
    delete gemini.buckets[1].remaining_fraction
    captured.response = captured.response.replace(
      'Gemini Models\tWeekly Limit Remaining\t100%',
      'Gemini Models\tWeekly Limit Remaining\t0%',
    )
    const source = mapAgyUsage(captured)
    expect(source.status === 'ready' && source.limits.slice(0, 2)).toEqual([
      {
        id: 'gemini-weekly',
        label: 'Gemini weekly',
        usedPercent: 100,
        resetsAt: Date.parse('2026-11-06T00:54:37Z'),
        windowMinutes: 10_080,
      },
      { id: '3p-5h', label: 'Claude and GPT 5 hours', usedPercent: 0, windowMinutes: 300 },
    ])
  })

  it('reports no plan limits for an account without quota groups', () => {
    const captured = JSON.parse(USAGE_1_4_7)
    captured.command.data.groups = []
    expect(mapAgyUsage(captured)).toEqual({ status: 'unavailable' })
  })

  it('rejects an answer that is not a usage report with a stable message', () => {
    const failed = {
      conversation_id: '',
      status: 'ERROR',
      response: '',
      error: '/usage failed: something agy said',
      num_turns: 0,
    }
    expect(() => mapAgyUsage(failed)).toThrow('Antigravity did not report its plan limits.')
    expect(() => mapAgyUsage(undefined)).toThrow('Antigravity did not report its plan limits.')
  })
})

describe('agyAnswersUsage', () => {
  it('needs agy 1.1.11, where print mode began answering /usage itself', () => {
    expect(agyAnswersUsage('1.4.7\n')).toBe(true)
    expect(agyAnswersUsage('1.1.11')).toBe(true)
    expect(agyAnswersUsage('1.1.10')).toBe(false)
    expect(agyAnswersUsage('1.0.30')).toBe(false)
    expect(agyAnswersUsage('2.0.0')).toBe(true)
    expect(agyAnswersUsage('')).toBeUndefined()
  })
})

describe('antigravityLimitSource', () => {
  it('asks agy for /usage in print mode with stdin closed, after checking its version', async () => {
    const agy = fakeAgy({ version: VERSION_1_4_7, usage: { stdout: USAGE_STDOUT, code: 0 } })
    const source = await antigravityLimitSource(agy.spawn)
    expect(source.status === 'ready' && source.limits).toHaveLength(4)
    expect(agy.calls).toEqual([['--version'], ['-p', '/usage', '--output-format', 'json']])
  })

  it('never sends /usage to an agy that would treat it as a prompt', async () => {
    const agy = fakeAgy({ version: { stdout: '1.1.10\n', code: 0 } })
    await expect(antigravityLimitSource(agy.spawn)).resolves.toEqual({ status: 'unavailable' })
    expect(agy.calls).toEqual([['--version']])
  })

  it('reads nothing when agy names no version', async () => {
    const agy = fakeAgy({ version: { stdout: '', code: 1 } })
    await expect(antigravityLimitSource(agy.spawn)).rejects.toThrow(
      'agy did not report its version.',
    )
    expect(agy.calls).toEqual([['--version']])
  })

  // `/usage` signed out was not captured; this is agy's sign-in message from `agy models`.
  it('reports no plan limits while agy says to sign in', async () => {
    const agy = fakeAgy({
      version: VERSION_1_4_7,
      usage: {
        stdout: '',
        stderr: fixture('agy-models-signed-out-1.4.0.txt'),
        code: 1,
      },
    })
    await expect(antigravityLimitSource(agy.spawn)).resolves.toEqual({ status: 'unavailable' })
  })
})
