import { spawn } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_RUNS = 7
const STARTUP_TIMEOUT_MS = 15_000
const PRELOAD_PATTERN = /\[startup\] preload-ready (\d+)ms/
const MODULE_PATTERN = /\[startup\] module-loaded (\d+)ms/
const COMMIT_PATTERN = /\[startup\] react-commit (\d+)ms/
const FRAME_PATTERN = /\[startup\] first-frame (\d+)ms/
const HYDRATED_PATTERN = /\[startup\] projects-ready (\d+)ms/
const CATALOG_PATTERN = /\[startup\] catalog-ready (\d+)ms/
const READY_PATTERN = /\[startup\] ready-to-show (\d+)ms/
const SERVER_PATTERN = /\[startup\] server-ready (\d+)ms/

export function parseRuns(value) {
  if (value === undefined) return DEFAULT_RUNS
  const runs = Number(value)
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 100) {
    throw new Error('runs must be an integer from 1 to 100')
  }
  return runs
}

export function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

export function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * fraction) - 1]
}

export async function measure(executable, index) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), `tastecode-startup-${index}-`))
  let output = ''
  let timeout
  let child
  let closed

  try {
    child = spawn(executable, [], {
      cwd: path.dirname(executable),
      env: {
        ...process.env,
        HARNESS_DATA_DIR: path.join(dataRoot, 'server'),
        HARNESS_DESKTOP_DATA_DIR: path.join(dataRoot, 'desktop'),
        HARNESS_STARTUP_EXIT_AFTER_READY: '1',
        HARNESS_STARTUP_STARTED_AT: String(Date.now()),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })

    closed = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    const result = await Promise.race([
      closed,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`startup timed out after ${STARTUP_TIMEOUT_MS}ms`))
        }, STARTUP_TIMEOUT_MS)
      }),
    ])
    clearTimeout(timeout)
    timeout = undefined

    const preload = Number(PRELOAD_PATTERN.exec(output)?.[1])
    const moduleLoaded = Number(MODULE_PATTERN.exec(output)?.[1])
    const reactCommit = Number(COMMIT_PATTERN.exec(output)?.[1])
    const firstFrame = Number(FRAME_PATTERN.exec(output)?.[1])
    const hydrated = Number(HYDRATED_PATTERN.exec(output)?.[1])
    const catalog = Number(CATALOG_PATTERN.exec(output)?.[1])
    const ready = Number(READY_PATTERN.exec(output)?.[1])
    const server = Number(SERVER_PATTERN.exec(output)?.[1])
    if (
      !Number.isFinite(preload) ||
      !Number.isFinite(moduleLoaded) ||
      !Number.isFinite(reactCommit) ||
      !Number.isFinite(firstFrame) ||
      !Number.isFinite(hydrated) ||
      !Number.isFinite(catalog) ||
      !Number.isFinite(ready) ||
      !Number.isFinite(server)
    ) {
      throw new Error(
        `startup markers are missing (exit ${result.code ?? result.signal ?? 'unknown'})\n${output.slice(-4000)}`,
      )
    }
    if (result.code !== 0) {
      throw new Error(
        `desktop exited with ${result.code ?? result.signal ?? 'unknown'}\n${output.slice(-4000)}`,
      )
    }
    if (process.env['HARNESS_STARTUP_VERBOSE'] === '1') console.log(output.trim())
    return {
      preload,
      moduleLoaded,
      reactCommit,
      firstFrame,
      hydrated,
      catalog,
      ready,
      server,
      interactive: Math.max(firstFrame, hydrated, catalog, ready, server),
    }
  } finally {
    clearTimeout(timeout)
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill()
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]).catch(
        () => undefined,
      )
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await closed?.catch(() => undefined)
    }
    await rm(dataRoot, { recursive: true, force: true })
  }
}

async function main() {
  const executableArgument = process.argv[2]
  if (!executableArgument) {
    throw new Error('usage: pnpm benchmark:startup -- <desktop-executable> [runs]')
  }
  const executable = path.resolve(executableArgument)
  await access(executable)
  const runs = parseRuns(process.argv[3])
  const samples = []

  for (let index = 1; index <= runs; index++) {
    const sample = await measure(executable, index)
    samples.push(sample)
    console.log(
      `[startup] run ${index}/${runs}: preload ${sample.preload}ms, module ${sample.moduleLoaded}ms, commit ${sample.reactCommit}ms, frame ${sample.firstFrame}ms, hydrated ${sample.hydrated}ms, catalog ${sample.catalog}ms, ready ${sample.ready}ms, server ${sample.server}ms, interactive ${sample.interactive}ms`,
    )
  }

  const preload = samples.map((sample) => sample.preload)
  const firstFrame = samples.map((sample) => sample.firstFrame)
  const hydrated = samples.map((sample) => sample.hydrated)
  const catalog = samples.map((sample) => sample.catalog)
  const ready = samples.map((sample) => sample.ready)
  const interactive = samples.map((sample) => sample.interactive)
  console.log(
    `[startup] all-run median: preload ${median(preload)}ms, frame ${median(firstFrame)}ms, hydrated ${median(hydrated)}ms, catalog ${median(catalog)}ms, ready ${median(ready)}ms, interactive ${median(interactive)}ms; interactive p90 ${percentile(interactive, 0.9)}ms`,
  )
  if (samples.length > 1) {
    const warmReady = ready.slice(1)
    const warmInteractive = interactive.slice(1)
    console.log(
      `[startup] first: ready ${ready[0]}ms, interactive ${interactive[0]}ms; warm median: ready ${median(warmReady)}ms, interactive ${median(warmInteractive)}ms`,
    )
  }
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isEntryPoint) await main()
