import { access } from 'node:fs/promises'
import path from 'node:path'

import { measure, median, parseRuns } from './benchmark-startup.js'

function percentChange(baseline, candidate) {
  return ((candidate - baseline) / baseline) * 100
}

function displayPercent(value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function parseEnvironment(value, label) {
  if (value === undefined) return {}
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`${label} environment must be a JSON object`)
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((entry) => typeof entry !== 'string')
  ) {
    throw new Error(`${label} environment values must be strings`)
  }
  return parsed
}

async function main() {
  const baselineArgument = process.argv[2]
  const candidateArgument = process.argv[3]
  if (!baselineArgument || !candidateArgument) {
    throw new Error(
      'usage: pnpm benchmark:startup:compare -- <baseline-executable> <candidate-executable> [pairs] [baseline-env-json] [candidate-env-json]',
    )
  }
  const baselineExecutable = path.resolve(baselineArgument)
  const candidateExecutable = path.resolve(candidateArgument)
  await Promise.all([access(baselineExecutable), access(candidateExecutable)])
  const pairs = parseRuns(process.argv[4])
  const baselineEnvironment = parseEnvironment(process.argv[5], 'baseline')
  const candidateEnvironment = parseEnvironment(process.argv[6], 'candidate')
  const samples = []

  const baselineWarmup = await measure(baselineExecutable, 'warmup-baseline', baselineEnvironment)
  const candidateWarmup = await measure(
    candidateExecutable,
    'warmup-candidate',
    candidateEnvironment,
  )
  console.log(
    `[startup] first launch (excluded; order baseline then candidate): baseline ${baselineWarmup.interactive}ms, candidate ${candidateWarmup.interactive}ms`,
  )

  for (let index = 1; index <= pairs; index++) {
    const baselineFirst = index % 2 === 1
    const first = baselineFirst
      ? ['baseline', baselineExecutable]
      : ['candidate', candidateExecutable]
    const second = baselineFirst
      ? ['candidate', candidateExecutable]
      : ['baseline', baselineExecutable]
    const pair = {}
    for (const [name, executable] of [first, second]) {
      pair[name] = await measure(
        executable,
        `${index}-${name}`,
        name === 'baseline' ? baselineEnvironment : candidateEnvironment,
      )
    }
    samples.push(pair)
    console.log(
      `[startup] pair ${index}/${pairs}: baseline ${pair.baseline.interactive}ms, candidate ${pair.candidate.interactive}ms, change ${displayPercent(percentChange(pair.baseline.interactive, pair.candidate.interactive))}`,
    )
  }

  for (const [label, metric] of [
    ['preload', 'preload'],
    ['module', 'moduleLoaded'],
    ['frame', 'firstFrame'],
    ['projects', 'hydrated'],
    ['catalog', 'catalog'],
    ['ready', 'ready'],
    ['server', 'server'],
    ['interactive', 'interactive'],
  ]) {
    const baseline = samples.map((sample) => sample.baseline[metric])
    const candidate = samples.map((sample) => sample.candidate[metric])
    const pairedChanges = samples.map((sample) =>
      percentChange(sample.baseline[metric], sample.candidate[metric]),
    )
    console.log(
      `[startup] paired ${label} median: baseline ${median(baseline)}ms, candidate ${median(candidate)}ms, change ${displayPercent(median(pairedChanges))}`,
    )
  }
}

await main()
