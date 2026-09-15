import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parsePreviewPlan } from '@harness/design-agent'
import {
  assertRunsWorkspaceCode,
  startDesignPreview,
  type RunningPreview,
  waitForPreview,
  watchPreviewChild,
} from './design-preview-runner.js'

const workspaces: string[] = []
const previews: RunningPreview[] = []

function serverPort(server: Server): number {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test port')
  return address.port
}

afterEach(async () => {
  await Promise.all(previews.splice(0).map((preview) => preview.stop()))
  for (const workspace of workspaces.splice(0)) {
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

describe('design preview runner', () => {
  it('refuses an occupied port before starting workspace code', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-'))
    workspaces.push(workspace)
    const marker = path.join(workspace, 'spawned.txt')
    const occupied = createServer((_request, response) => response.end('unrelated preview'))
    await listen(occupied)
    const port = serverPort(occupied)
    writeFileSync(
      path.join(workspace, 'preview.mjs'),
      `import { createServer } from 'node:http'\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'started')\ncreateServer((_request, response) => response.end('expected preview')).listen(${port}, '127.0.0.1')\n`,
    )
    const plan = parsePreviewPlan({
      version: 1,
      command: 'node',
      args: ['preview.mjs'],
      cwd: '.',
      url: `http://127.0.0.1:${port}`,
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
    if (!(failure instanceof Error)) throw new Error('expected preview failure')
    expect(failure.message).toContain(`preview port ${port} is already in use`)
    expect(existsSync(marker)).toBe(false)
  })

  it('starts the expected workspace preview, waits for HTTP, and stops it', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-'))
    workspaces.push(workspace)
    const port = await freePort()
    const expected = `workspace:${path.basename(workspace)}`
    writeFileSync(path.join(workspace, 'preview.mjs'), previewServerSource(port, expected))
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
    await expect(fetch(preview.url).then((response) => response.text())).resolves.toBe(expected)
    await expect(preview.stop()).resolves.toBeUndefined()
    previews.pop()
    await expect(fetch(preview.url, { signal: AbortSignal.timeout(500) })).rejects.toThrow()
  })

  it('serves an exact-file static project with a TasteCode-owned response', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-'))
    workspaces.push(workspace)
    const port = await freePort()
    writeFileSync(path.join(workspace, 'index.html'), '<link rel="stylesheet" href="styles.css">')
    writeFileSync(path.join(workspace, 'styles.css'), 'body { color: tomato; }')
    writeFileSync(path.join(workspace, 'app.js'), 'document.body.dataset.ready = "true"')
    const staticPlan = staticPreviewPlan(port, '/site/')

    const preview = await startDesignPreview(workspace, staticPlan)
    previews.push(preview)
    const response = await fetch(preview.url)
    expect(response.headers.get('x-harness-preview-id')).toMatch(/^[0-9a-f-]{36}$/)
    await expect(response.text()).resolves.toContain('styles.css')
    await expect(
      fetch(new URL('styles.css', preview.url)).then((value) => value.text()),
    ).resolves.toBe('body { color: tomato; }')
    expect(readdirSync(workspace).sort()).toEqual(['app.js', 'index.html', 'styles.css'])
    writeFileSync(path.join(workspace, '.env'), 'SECRET=not-for-preview')
    await expect(fetch(new URL('.env', preview.url)).then((value) => value.status)).resolves.toBe(
      404,
    )
  })

  it('rejects a static preview whose local image is outside the selected root', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-'))
    workspaces.push(workspace)
    const port = await freePort()
    writeFileSync(path.join(workspace, 'index.html'), '<img src="assets/hero.png" alt="">')
    mkdirSync(path.join(workspace, 'public', 'assets'), { recursive: true })
    writeFileSync(path.join(workspace, 'public', 'assets', 'hero.png'), 'image')
    const staticPlan = staticPreviewPlan(port)

    await expect(startDesignPreview(workspace, staticPlan)).rejects.toThrow(
      'static preview resource is unavailable: assets/hero.png',
    )
  })

  it('ignores markup that does not load a page resource', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-'))
    workspaces.push(workspace)
    const port = await freePort()
    writeFileSync(
      path.join(workspace, 'index.html'),
      [
        '<link rel="canonical" href="missing-canonical.html">',
        '<!-- <img src="missing-comment.png"> -->',
        '<img data-src="missing-lazy.png" alt="">',
      ].join('\n'),
    )
    const staticPlan = staticPreviewPlan(port)

    const preview = await startDesignPreview(workspace, staticPlan)
    previews.push(preview)
    await expect(fetch(preview.url).then((response) => response.status)).resolves.toBe(200)
  })

  it('can retry a corrected static preview on the same port', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-'))
    workspaces.push(workspace)
    const port = await freePort()
    writeFileSync(path.join(workspace, 'index.html'), '<img src="assets/hero.png" alt="">')
    const staticPlan = staticPreviewPlan(port)

    await expect(startDesignPreview(workspace, staticPlan)).rejects.toThrow(
      'static preview resource is unavailable: assets/hero.png',
    )
    mkdirSync(path.join(workspace, 'assets'))
    writeFileSync(path.join(workspace, 'assets', 'hero.png'), 'image')

    const preview = await startDesignPreview(workspace, staticPlan)
    previews.push(preview)
    await expect(fetch(preview.url).then((response) => response.status)).resolves.toBe(200)
  })

  it('checks each resource attribute parsed from valid HTML', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-'))
    workspaces.push(workspace)
    const port = await freePort()
    writeFileSync(
      path.join(workspace, 'index.html'),
      '<video poster=missing-poster.png src="present.png"></video>',
    )
    writeFileSync(path.join(workspace, 'present.png'), 'video')
    const staticPlan = staticPreviewPlan(port)

    await expect(startDesignPreview(workspace, staticPlan)).rejects.toThrow(
      'static preview resource is unavailable: missing-poster.png',
    )
  })

  it('rejects a missing responsive image candidate', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-'))
    workspaces.push(workspace)
    const port = await freePort()
    writeFileSync(
      path.join(workspace, 'index.html'),
      '<picture><source srcset="missing.webp 1x"><img src="present.png" alt=""></picture>',
    )
    writeFileSync(path.join(workspace, 'present.png'), 'image')
    const staticPlan = staticPreviewPlan(port)

    await expect(startDesignPreview(workspace, staticPlan)).rejects.toThrow(
      'static preview resource is unavailable: missing.webp',
    )
  })

  it('accepts deeply nested static markup without overflowing the stack', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-'))
    workspaces.push(workspace)
    const port = await freePort()
    writeFileSync(
      path.join(workspace, 'index.html'),
      `${'<div>'.repeat(5_000)}content${'</div>'.repeat(5_000)}`,
    )
    const staticPlan = staticPreviewPlan(port)

    const preview = await startDesignPreview(workspace, staticPlan)
    previews.push(preview)
    await expect(fetch(preview.url).then((response) => response.status)).resolves.toBe(200)
  })

  it.each([
    '<img srcset="present.png, missing.png 2x">',
    '<img srcset="present.png, missing.png">',
    '<source srcset="data:image/png;base64,aGVsbG8= 1x, missing.png 2x">',
    '<link rel="preload" as="image" href="missing.png">',
    '<link rel="preload" as="image" href="present.png" imagesrcset="present.png 1x, missing.png 2x">',
    '<svg><image href="missing.png" /></svg>',
    '<svg><image xlink:href="missing.png" /></svg>',
    '<base href="./assets/"><img src="missing.png">',
  ])('rejects each missing markup resource: %s', async (html) => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-markup-'))
    workspaces.push(workspace)
    writeFileSync(path.join(workspace, 'index.html'), html)
    writeFileSync(path.join(workspace, 'present.png'), 'image')
    const port = await freePort()
    await expect(startDesignPreview(workspace, staticPreviewPlan(port))).rejects.toThrow(
      'static preview resource is unavailable: missing.png',
    )
    const reservation = createServer()
    await listen(reservation, port)
    await close(reservation)
  })

  it('accepts valid mixed responsive candidates and ignores inactive template markup', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-markup-'))
    workspaces.push(workspace)
    writeFileSync(
      path.join(workspace, 'index.html'),
      [
        '<base href="http://[invalid"><base href="/ignored/">',
        '<img srcset="present.png, second.png 2x">',
        '<img src="https://example.com/external.png">',
        '<svg><image xlink:href="missing-overridden.png" href="present.png" /></svg>',
        '<svg><image href="present.png" xlink:href="missing-overridden.png" /></svg>',
        '<template><img src="not-yet-used.png"></template>',
      ].join('\n'),
    )
    for (const file of ['present.png', 'second.png'])
      writeFileSync(path.join(workspace, file), 'image')
    const preview = await startDesignPreview(workspace, staticPreviewPlan(await freePort()))
    previews.push(preview)
    expect((await fetch(preview.url)).status).toBe(200)
  })

  it('does not accept a concurrent preview serving the same port', async () => {
    const port = await freePort()
    const firstWorkspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-first-'))
    const secondWorkspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-second-'))
    workspaces.push(firstWorkspace, secondWorkspace)
    writeFileSync(
      path.join(firstWorkspace, 'preview.mjs'),
      previewServerSource(port, 'first workspace', 200),
    )
    writeFileSync(
      path.join(secondWorkspace, 'preview.mjs'),
      previewServerSource(port, 'second workspace', 200),
    )

    const attempts = await Promise.allSettled([
      startDesignPreview(firstWorkspace, plan(port), 5_000),
      startDesignPreview(secondWorkspace, plan(port), 5_000),
    ])
    const running = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<RunningPreview> =>
        attempt.status === 'fulfilled',
    )
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected')
    expect(running).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    previews.push(running[0].value)
    const expected = attempts[0].status === 'fulfilled' ? 'first workspace' : 'second workspace'
    await expect(fetch(running[0].value.url).then((response) => response.text())).resolves.toBe(
      expected,
    )
  })

  it('rejects a child that exits after another response passes readiness', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-'))
    workspaces.push(workspace)
    const port = await freePort()
    writeFileSync(
      path.join(workspace, 'preview.mjs'),
      previewServerSource(port, 'short lived', 0, true),
    )

    await expect(startDesignPreview(workspace, plan(port), 5_000)).rejects.toThrow(
      'preview exited before it was ready',
    )
  })

  it('turns a child spawn error into a readiness failure', async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
    })
    const childFailure = watchPreviewChild(child)
    const waiting = waitForPreview(child, 'http://127.0.0.1:1', 5_000, () => '', childFailure)

    child.emit('error', new Error('spawn bun ENOENT'))

    await expect(waiting).rejects.toThrow('preview failed to start: spawn bun ENOENT')
  })

  it('reports a child that exits before opening its port', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-'))
    workspaces.push(workspace)
    const port = await freePort()
    writeFileSync(
      path.join(workspace, 'preview.mjs'),
      `process.stderr.write('intentional preview exit\\n')\nprocess.exit(23)\n`,
    )

    await expect(startDesignPreview(workspace, plan(port), 5_000)).rejects.toThrow(
      /preview exited before it was ready[\s\S]*intentional preview exit/,
    )
  })

  it('releases the child and port when readiness times out', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-'))
    workspaces.push(workspace)
    const port = await freePort()
    writeFileSync(
      path.join(workspace, 'preview.mjs'),
      `import { createServer } from 'node:http'\ncreateServer((_request, response) => { response.statusCode = 503; response.end('not ready') }).listen(${port}, '127.0.0.1')\n`,
    )

    await expect(startDesignPreview(workspace, plan(port), 250)).rejects.toThrow(
      'preview did not become ready',
    )
    const reservation = createServer()
    await listen(reservation, port)
    await close(reservation)
  })

  it('stops the complete preview process tree', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-'))
    workspaces.push(workspace)
    const port = await freePort()
    writeFileSync(path.join(workspace, 'child.mjs'), previewServerSource(port, 'descendant'))
    writeFileSync(
      path.join(workspace, 'preview.mjs'),
      `import { spawn } from 'node:child_process'\nspawn(process.execPath, ['child.mjs'], { stdio: 'inherit' })\nsetInterval(() => {}, 60_000)\n`,
    )

    const preview = await startDesignPreview(workspace, plan(port), 5_000)
    previews.push(preview)
    await expect(fetch(preview.url).then((response) => response.text())).resolves.toBe('descendant')
    await preview.stop()
    previews.pop()
    await expect(fetch(preview.url, { signal: AbortSignal.timeout(500) })).rejects.toThrow()
  })

  it('rejects stop while the preview port remains occupied', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-'))
    workspaces.push(workspace)
    const port = await freePort()
    writeFileSync(path.join(workspace, 'preview.mjs'), previewServerSource(port, 'preview'))

    const preview = await startDesignPreview(workspace, plan(port), 5_000)
    const stopping = preview.stop()
    const occupied = await occupyPort(port)
    try {
      await expect(stopping).rejects.toThrow(`preview port ${port} remained in use after stop`)
    } finally {
      await close(occupied)
    }
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

  it.each([
    ['pnpm', ['--dir=../outside', 'run', 'dev']],
    ['pnpm', ['-C', '../outside', 'run', 'dev']],
    ['pnpm', ['--workspace-root', 'run', 'dev']],
    ['pnpm', ['-r', 'run', 'dev']],
    ['npm', ['--prefix', '../outside', 'run', 'dev']],
    ['npm', ['--workspace', 'outside', 'run', 'dev']],
    ['yarn', ['--cwd', '../outside', 'run', 'dev']],
    ['yarn', ['workspace', 'outside', 'run', 'dev']],
    ['bun', ['--cwd', '../outside', 'run', 'dev']],
  ])('rejects %s options that can change the selected package', async (command, args) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-packages-'))
    workspaces.push(root)
    const workspace = path.join(root, 'workspace')
    const outside = path.join(root, 'outside')
    const marker = path.join(outside, 'spawned.txt')
    mkdirSync(workspace)
    mkdirSync(outside)
    writeFileSync(
      path.join(workspace, 'package.json'),
      JSON.stringify({ scripts: { dev: 'x', workspace: 'x' } }),
    )
    writeFileSync(
      path.join(outside, 'package.json'),
      JSON.stringify({
        scripts: { dev: `node -e "require('fs').writeFileSync('spawned.txt','yes')"` },
      }),
    )
    const plan = parsePreviewPlan({
      version: 1,
      command,
      args,
      cwd: '.',
      url: 'http://127.0.0.1:5173',
      viewports: [{ name: 'desktop', width: 1440, height: 1000 }],
    })

    await expect(startDesignPreview(workspace, plan)).rejects.toThrow(
      'preview package-manager workspace selectors are not allowed',
    )
    expect(existsSync(marker)).toBe(false)
  })

  it('keeps ordinary package-script arguments working', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-'))
    workspaces.push(workspace)
    writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { dev: 'x' } }))
    const plan = parsePreviewPlan({
      version: 1,
      command: 'pnpm',
      args: ['dev', '--host', '127.0.0.1'],
      cwd: '.',
      url: 'http://127.0.0.1:5173',
      viewports: [{ name: 'desktop', width: 1440, height: 1000 }],
    })

    expect(() => assertRunsWorkspaceCode(workspace, workspace, plan)).not.toThrow()
  })

  it('runs a package script even when its name collides with a package-manager command', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-preview-'))
    workspaces.push(workspace)
    const port = await freePort()
    writeFileSync(path.join(workspace, 'preview.mjs'), previewServerSource(port, 'local script'))
    writeFileSync(
      path.join(workspace, 'package.json'),
      JSON.stringify({ scripts: { exec: 'node preview.mjs' } }),
    )
    const plan = parsePreviewPlan({
      version: 1,
      command: 'pnpm',
      args: ['exec'],
      cwd: '.',
      url: `http://127.0.0.1:${port}`,
      viewports: [{ name: 'desktop', width: 1440, height: 1000 }],
    })

    const preview = await startDesignPreview(workspace, plan, 5_000)
    previews.push(preview)
    await expect(fetch(preview.url).then((response) => response.text())).resolves.toBe(
      'local script',
    )
  })
})

function staticPreviewPlan(port: number, pathname = '/') {
  return parsePreviewPlan({
    version: 1,
    kind: 'static',
    entry: 'index.html',
    cwd: '.',
    url: `http://127.0.0.1:${port}${pathname}`,
    viewports: [{ name: 'desktop', width: 1440, height: 1000 }],
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = serverPort(server)
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

async function occupyPort(port: number): Promise<Server> {
  const startedAt = Date.now()
  do {
    const server = await tryListen(port)
    if (server) return server
    await new Promise((resolve) => setTimeout(resolve, 5))
  } while (Date.now() - startedAt < 1_000)
  throw new Error(`could not occupy test port ${port}`)
}

function tryListen(port: number): Promise<Server | undefined> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(undefined)
      else reject(error)
    })
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

function plan(port: number) {
  return parsePreviewPlan({
    version: 1,
    command: 'node',
    args: ['preview.mjs'],
    cwd: '.',
    url: `http://127.0.0.1:${port}`,
    viewports: [{ name: 'desktop', width: 1440, height: 1000 }],
  })
}

function listen(server: ReturnType<typeof createServer>, port = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function previewServerSource(
  port: number,
  body: string,
  delayMs = 0,
  exitAfterResponse = false,
): string {
  return `import { createServer } from 'node:http'
const server = createServer((_request, response) => {
  response.end(${JSON.stringify(body)})
  ${exitAfterResponse ? "response.on('finish', () => process.exit(0))" : ''}
})
setTimeout(() => server.listen(${port}, '127.0.0.1'), ${delayMs})
`
}
