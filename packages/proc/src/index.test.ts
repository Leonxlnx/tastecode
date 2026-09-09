import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import {
  killTree,
  commandVersion,
  isInstalled,
  readNdjson,
  runCli,
  spawnCli,
  StdioJsonRpc,
  type StdioJsonRpcProcess,
} from './index.js'

describe('command discovery', () => {
  it.skipIf(process.platform === 'win32')(
    'reads an exact version from an executable link without launching it',
    async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-command-version-'))
      const target = path.join(directory, '2.3.4')
      const command = path.join(directory, 'fake-agent')
      const previousPath = process.env['PATH']
      try {
        writeFileSync(target, '')
        chmodSync(target, 0o755)
        symlinkSync(target, command)
        process.env['PATH'] = `${directory}${path.delimiter}${previousPath ?? ''}`

        await expect(isInstalled('fake-agent')).resolves.toBe(true)
        await expect(commandVersion('fake-agent')).resolves.toBe('2.3.4')
      } finally {
        process.env['PATH'] = previousPath
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
})

describe('StdioJsonRpc', () => {
  it('forgets a timed-out request and still accepts the next reply', async () => {
    vi.useFakeTimers()
    try {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
        kill: vi.fn(() => true),
      }) satisfies StdioJsonRpcProcess
      const rpc = new StdioJsonRpc(child, 'test agent')

      const timedOut = rpc.request('slow', {}, { timeoutMs: 10 })
      const rejection = expect(timedOut).rejects.toThrow('test agent request timed out: slow')
      await vi.advanceTimersByTimeAsync(10)
      await rejection

      const next = rpc.request('fast')
      child.stdout.write('{"jsonrpc":"2.0","id":1,"result":"late"}\n')
      child.stdout.write('{"jsonrpc":"2.0","id":2,"result":"ready"}\n')
      await expect(next).resolves.toBe('ready')
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts a final reply delivered after process exit but before stdio closes', async () => {
    // SAFETY: StdioJsonRpc uses only these three streams and EventEmitter process events in this test.
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    const rpc = new StdioJsonRpc(child, 'test agent')
    const reply = rpc.request('final')

    child.emit('exit', 0)
    child.stdout.write('{"jsonrpc":"2.0","id":1,"result":"drained"}\n')

    await expect(reply).resolves.toBe('drained')
    child.emit('close', 0)
  })
})

describe('runCli', () => {
  it('captures a short command without invoking a platform shell directly', async () => {
    const result = await runCli('node', ['--version'])
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/^v\d+\./)
  })

  it('waits for inherited output pipes to drain before returning', async () => {
    const lateOutput = "setTimeout(() => process.stdout.write('late'), 50)"
    const script = [
      "const { spawn } = require('node:child_process')",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(lateOutput)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] })`,
      'child.unref()',
      "process.stdout.write('early-')",
    ].join(';')

    const result = await runCli(process.execPath, ['-e', script], 2_000)

    expect(result).toEqual({ code: 0, stdout: 'early-late', stderr: '' })
  })

  it('captures provider status text written to stderr', async () => {
    const result = await runCli(process.execPath, ['-e', "process.stderr.write('provider status')"])

    expect(result).toEqual({ code: 0, stdout: '', stderr: 'provider status' })
  })
})

describe('spawnCli', () => {
  it('runs an absolute Windows executable whose path contains spaces', async () => {
    const child = spawnCli(process.execPath, ['-e', 'process.stdout.write("ready")'])
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (output += chunk))
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', resolve)
    })
    expect(code).toBe(0)
    expect(output).toBe('ready')
  })

  it('can replace the inherited environment for untrusted commands', async () => {
    process.env['HARNESS_HIDDEN'] = 'secret'
    try {
      const child = spawnCli(
        'node',
        [
          '-e',
          'process.stdout.write(`${process.env.HARNESS_VISIBLE}|${process.env.HARNESS_HIDDEN ?? ""}`)',
        ],
        {
          replaceEnv: true,
          env: {
            PATH: process.env['PATH'],
            PATHEXT: process.env['PATHEXT'],
            SYSTEMROOT: process.env['SYSTEMROOT'],
            COMSPEC: process.env['COMSPEC'],
            HARNESS_VISIBLE: 'yes',
          },
        },
      )
      let output = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => (output += chunk))
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on('error', reject)
        child.on('exit', resolve)
      })
      expect(code).toBe(0)
      expect(output).toBe('yes|')
    } finally {
      delete process.env['HARNESS_HIDDEN']
    }
  })
})

describe('readNdjson', () => {
  it('parses a final line that has no trailing newline once the stream ends', async () => {
    // CLIs that die right after their last write often leave it unterminated;
    // dropping it deterministically lost the result of the whole run.
    const stream = new PassThrough()
    const values: unknown[] = []
    readNdjson(stream, (value) => values.push(value))
    stream.write('{"first":1}\n{"seco')
    stream.end('nd":2}')
    await new Promise((resolve) => stream.on('end', resolve))
    expect(values).toEqual([{ first: 1 }, { second: 2 }])
  })
})

describe('killTree', () => {
  it('kills the real process behind the shim, not only the shim', async () => {
    // The grandchild heartbeats into a temp file; if only the cmd.exe shim
    // died (the pre-fix Windows behavior), the heartbeat keeps ticking.
    const beat = path.join(os.tmpdir(), `harness-killtree-${Date.now()}.txt`)
    const script = `const fs=require('fs');setInterval(()=>fs.writeFileSync(${JSON.stringify(
      beat,
    )},String(Date.now())),150)`
    const child = spawnCli('node', ['-e', script])
    await waitFor(() => existsSync(beat), 5_000)

    killTree(child)
    await sleep(700)
    const afterKill = readFileSync(beat, 'utf8')
    await sleep(700)
    expect(readFileSync(beat, 'utf8')).toBe(afterKill)
    rmSync(beat, { force: true })
  })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition never became true')
    await sleep(100)
  }
}
