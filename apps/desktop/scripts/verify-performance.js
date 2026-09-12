import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { measure, parseRuns } from './benchmark-startup.js'
import { performanceFailures, PERFORMANCE_BUDGETS } from './performance/budgets.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(here, '..')
const webRoot = path.resolve(desktopRoot, '../web')
const require = createRequire(import.meta.url)
const webRequire = createRequire(path.join(webRoot, 'package.json'))
const runs = parseRuns(process.argv[2] ?? '3')
if (runs < 3) throw new Error('The performance gate requires at least three runs')
const reportDirectory = path.resolve(
  process.argv[3] ?? path.join(desktopRoot, 'performance-results'),
)
await mkdir(reportDirectory, { recursive: true })
const temporary = await mkdtemp(path.join(os.tmpdir(), 'tastecode-performance-'))
const samples = []
const startups = []

async function runChild(executable, args, environment, timeoutMs = 100_000) {
  const child = spawn(executable, args, {
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, timeoutMs)
  child.stdout.on('data', (chunk) => {
    output = (output + chunk).slice(-16_000)
  })
  child.stderr.on('data', (chunk) => {
    output = (output + chunk).slice(-16_000)
  })
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) =>
        code === 0 && !timedOut
          ? resolve()
          : reject(
              new Error(`Process failed (${code}${timedOut ? ', timed out' : ''}):\n${output}`),
            ),
      )
    })
  } finally {
    clearTimeout(timer)
  }
}

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return port
}

try {
  const { build } = await import(pathToFileURL(webRequire.resolve('vite')).href)
  const { default: react } = await import(
    pathToFileURL(webRequire.resolve('@vitejs/plugin-react')).href
  )
  const rendererDirectory = path.join(temporary, 'renderer')
  await build({
    configFile: false,
    root: path.join(here, 'performance'),
    base: './',
    plugins: [react()],
    logLevel: 'warn',
    resolve: {
      alias: [
        { find: /^react$/, replacement: webRequire.resolve('react') },
        { find: /^react\/jsx-runtime$/, replacement: webRequire.resolve('react/jsx-runtime') },
        { find: /^react-dom$/, replacement: webRequire.resolve('react-dom') },
        { find: /^react-dom\/client$/, replacement: webRequire.resolve('react-dom/client') },
      ],
    },
    worker: { format: 'es' },
    build: { outDir: rendererDirectory, emptyOutDir: true },
  })
  const port = await unusedPort()
  process.env.VITE_HARNESS_SERVER_URL = `ws://127.0.0.1:${port}`
  const startupDirectory = path.join(temporary, 'app')
  await build({
    root: webRoot,
    configFile: path.join(webRoot, 'vite.config.ts'),
    logLevel: 'warn',
    build: { outDir: startupDirectory, emptyOutDir: true },
  })
  await runChild(process.execPath, [path.join(here, 'build-main.js')], {})
  await runChild(process.execPath, [path.join(here, 'build-preload.js')], {})
  const { build: bundle } = await import('esbuild')
  const memoryModule = path.join(temporary, 'performance-memory.mjs')
  await bundle({
    entryPoints: [path.join(desktopRoot, 'src/performance-memory.ts')],
    outfile: memoryModule,
    bundle: true,
    platform: 'node',
    format: 'esm',
  })
  const electron = require('electron')
  for (let index = 1; index <= runs; index += 1) {
    const resultPath = path.join(reportDirectory, `renderer-${index}.json`)
    await runChild(electron, [path.join(here, 'performance/electron.cjs')], {
      ELECTRON_RUN_AS_NODE: undefined,
      HARNESS_PERF_DATA_DIR: path.join(temporary, `renderer-data-${index}`),
      HARNESS_PERF_RENDERER: path.join(rendererDirectory, 'index.html'),
      HARNESS_PERF_RESULT: resultPath,
      HARNESS_PERF_MEMORY_MODULE: memoryModule,
    })
    const sample = JSON.parse(await readFile(resultPath, 'utf8'))
    samples.push(sample)
    console.log(
      `[performance] renderer ${index}/${runs}: ${sample.scroll.seenMessages} messages visible, first paint ${sample.firstPaintMs.toFixed(1)} ms, worst frame ${Math.max(...sample.scroll.frames).toFixed(1)} ms, batch ${Math.max(...sample.streaming.batches).toFixed(1)} ms`,
    )
    const startup = await measure(
      electron,
      index,
      {
        HARNESS_PORT: String(port),
        HARNESS_HOST: '127.0.0.1',
        HARNESS_DEV_SERVER: undefined,
        ELECTRON_RUN_AS_NODE: undefined,
        HARNESS_STARTUP_RENDERER: path.join(startupDirectory, 'index.html'),
        HARNESS_STARTUP_SETTLE_MS: '2000',
        HARNESS_STARTUP_THREAD_COUNT: '5',
        HARNESS_STARTUP_PROJECT_COUNT: '1',
      },
      [desktopRoot],
    )
    startups.push(startup)
    await writeFile(
      path.join(reportDirectory, `startup-${index}.json`),
      JSON.stringify(startup, null, 2),
    )
    console.log(`[performance] cold start ${index}/${runs}: interactive ${startup.interactive} ms`)
  }
  const failures = performanceFailures(samples, startups)
  await writeFile(
    path.join(reportDirectory, 'report.json'),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        budgets: PERFORMANCE_BUDGETS,
        samples,
        startups,
        failures,
      },
      null,
      2,
    ),
  )
  if (failures.length > 0) throw new Error(`Performance gate failed:\n${failures.join('\n')}`)
  console.log(`[performance] PASS: ${runs} complete samples; ${reportDirectory}`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
