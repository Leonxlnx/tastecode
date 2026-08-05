import { describe, expect, it } from 'vitest'
import { runCli, spawnCli } from './index.js'

describe('runCli', () => {
  it('captures a short command without invoking a platform shell directly', async () => {
    const result = await runCli('node', ['--version'])
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/^v\d+\./)
  })
})

describe('spawnCli', () => {
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
