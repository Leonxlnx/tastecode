import { access } from 'node:fs/promises'
import path from 'node:path'

import { measure, median, parseRuns } from './benchmark-startup.js'

function percentChange(baseline, candidate) {
  return ((candidate - baseline) / baseline) * 100
}

function displayPercent(value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

async function main() {
  const baselineArgument = process.argv[2]
  const candidateArgument = process.argv[3]
  if (!baselineArgument || !candidateArgument) {
    throw new Error(
      'usage: pnpm benchmark:startup:compare -- <baseline-executable> <candidate-executable> [pairs]',
    )
  }
  const baselineExecutable = path.resolve(baselineArgument)
  const candidateExecutable = path.resolve(candidateArgument)
  await Promise.all([access(baselineExecutable), access(candidateExecutable)])
  const pairs = parseRuns(process.argv[4])
  const samples = []

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
      pair[name] = await measure(executable, `${index}-${name}`)
    }
    samples.push(pair)
    console.log(
      `[startup] pair ${index}/${pairs}: baseline ${pair.baseline.interactive}ms, candidate ${pair.candidate.interactive}ms, change ${displayPercent(percentChange(pair.baseline.interactive, pair.candidate.interactive))}`,
    )
  }

  for (const [label, metric] of [
    ['frame', 'firstFrame'],
    ['projects', 'hydrated'],
    ['catalog', 'catalog'],
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
