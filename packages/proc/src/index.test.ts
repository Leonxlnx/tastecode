import { describe, expect, it } from 'vitest'
import { runCli } from './index.js'

describe('runCli', () => {
  it('captures a short command without invoking a platform shell directly', async () => {
    const result = await runCli('node', ['--version'])
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/^v\d+\./)
  })
})
