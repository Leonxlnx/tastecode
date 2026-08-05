import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parsePreviewPlan } from '@harness/design-agent'
import { startDesignPreview, type RunningPreview } from './design-preview-runner.js'

const workspaces: string[] = []
const previews: RunningPreview[] = []

afterEach(async () => {
  await Promise.all(previews.splice(0).map((preview) => preview.stop()))
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

describe('design preview runner', () => {
  it('starts a local argv command, waits for HTTP, and stops its process tree', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-'))
    workspaces.push(workspace)
    const port = await freePort()
    writeFileSync(
      path.join(workspace, 'preview.mjs'),
      `import { createServer } from 'node:http'\ncreateServer((_request, response) => response.end('ready')).listen(${port}, '127.0.0.1')\n`,
    )
    const plan = parsePreviewPlan({
      version: 1,
      command: 'node',
      args: ['preview.mjs'],
      cwd: '.',
      url: `http://127.0.0.1:${port}`,
      viewports: [{ name: 'desktop', width: 1440, height: 1000 }],
    })

    const preview = await startDesignPreview(workspace, plan, 5_000)
    previews.push(preview)
    await expect(fetch(preview.url).then((response) => response.text())).resolves.toBe('ready')
    await preview.stop()
    previews.pop()
    await expect(fetch(preview.url, { signal: AbortSignal.timeout(500) })).rejects.toThrow()
  })

  it('rejects command arguments that could escape through a Windows shim', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-'))
    workspaces.push(workspace)
    const plan = parsePreviewPlan({
      version: 1,
      command: 'node',
      args: ['server.js&&whoami'],
      cwd: '.',
      url: 'http://127.0.0.1:5173',
      viewports: [{ name: 'desktop', width: 1440, height: 1000 }],
    })
    await expect(startDesignPreview(workspace, plan)).rejects.toThrow('argument is unsafe')
  })
})

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('missing test port'))
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}
