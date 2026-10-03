import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { ServerSupervisor } from './server-supervisor.js'

it('waits for a real Node child to flush through the shutdown IPC channel', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-shutdown-'))
  const output = path.join(directory, 'flushed.txt')
  let ready!: () => void
  let failed!: (error: Error) => void
  const started = new Promise<void>((resolve, reject) => {
    ready = resolve
    failed = reject
  })
  const startupTimeout = setTimeout(() => failed(new Error('Child did not start')), 5_000)
  const supervisor = new ServerSupervisor({
    command: process.execPath,
    args: [
      '-e',
      `
      const fs = require('node:fs');
      process.on('message', (message) => {
        if (message?.type !== 'harness:shutdown') return;
        fs.writeFileSync(process.env.HARNESS_TEST_FLUSH_PATH, 'flushed');
        process.exit(0);
      });
      console.log('ready');
    `,
    ],
    env: { ...process.env, HARNESS_TEST_FLUSH_PATH: output },
    onLog: (line) => {
      if (line === 'ready') ready()
    },
  })
  try {
    supervisor.start()
    await started
    await supervisor.stop()
    expect(await readFile(output, 'utf8')).toBe('flushed')
  } finally {
    clearTimeout(startupTimeout)
    await supervisor.stop()
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)
