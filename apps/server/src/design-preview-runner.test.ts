import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  it('refuses an occupied port before starting workspace code', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-'))
    workspaces.push(workspace)
    const marker = path.join(workspace, 'spawned.txt')
    const occupied = createServer((_request, response) => response.end('unrelated preview'))
    await listen(occupied)
    const address = occupied.address()
    if (!address || typeof address === 'string') throw new Error('missing test port')
    writeFileSync(
      path.join(workspace, 'preview.mjs'),
      `import { createServer } from 'node:http'\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'started')\ncreateServer((_request, response) => response.end('expected preview')).listen(${address.port}, '127.0.0.1')\n`,
    )
    const plan = parsePreviewPlan({
      version: 1,
      command: 'node',
      args: ['preview.mjs'],
      cwd: '.',
      url: `http://127.0.0.1:${address.port}`,
      viewports: [{ name: 'desktop', width: 1440, height: 1000 }],
    })

    let accepted: RunningPreview | undefined
    let failure: unknown
    try {
      accepted = await startDesignPreview(workspace, plan, 5_000)
    } catch (error) {
      failure = error
    } finally {
      await accepted?.stop()
      await close(occupied)
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain(`preview port ${address.port} is already in use`)
    expect(existsSync(marker)).toBe(false)
  })

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

  it('refuses to run code that is not already in the workspace', async () => {
    // Design Mode reads the project's own README and sources, so anything in
    // there can steer the model's choice of preview command. These are the
    // shapes that turn that into "run something of the repo's choosing".
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-'))
    workspaces.push(workspace)
    writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { dev: 'x' } }))
    const plan = (command: string, args: string[]) =>
      parsePreviewPlan({
        version: 1,
        command,
        args,
        cwd: '.',
        url: 'http://127.0.0.1:5173',
        viewports: [{ name: 'desktop', width: 1440, height: 1000 }],
      })

    // Fetches and executes a package off the network. The parser now rejects
    // npx before a plan exists, so the runner's own defense is exercised with
    // a hand-built plan that skipped parsing.
    await expect(
      startDesignPreview(workspace, {
        ...plan('pnpm', ['run', 'dev']),
        command: 'npx',
        args: ['some-package'],
      }),
    ).rejects.toThrow('not allowed')
    // A script the project does not declare.
    await expect(startDesignPreview(workspace, plan('pnpm', ['run', 'evil']))).rejects.toThrow(
      'not declared in package.json',
    )
    // A file that is not in the workspace.
    await expect(startDesignPreview(workspace, plan('node', ['../outside.mjs']))).rejects.toThrow()
    // Every path argument counts, not just the first: a local entry point
    // beside an escaping one must not launder it through.
    writeFileSync(path.join(workspace, 'local.mjs'), 'export {}\n')
    await expect(
      startDesignPreview(workspace, plan('node', ['local.mjs', '../outside.mjs'])),
    ).rejects.toThrow()
    await expect(
      startDesignPreview(workspace, plan('node', ['--import=../outside.mjs', 'local.mjs'])),
    ).rejects.toThrow()
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

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}
