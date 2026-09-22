export const PERFORMANCE_BUDGETS = Object.freeze({
  firstPaintMs: 150,
  frameMs: 32,
  // A 60 Hz display produces 16.67 ms timestamps with small clock rounding.
  medianScrollFrameMs: 17,
  streamBatchMs: 4,
  startupInteractiveMs: 1_500,
  switchMs: 100,
  memoryBytes: 500_000_000,
})

function median(values) {
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.floor(ordered.length / 2)]
}

export function performanceFailures(samples, startups, budgets = PERFORMANCE_BUDGETS) {
  const failures = []
  const below = (name, value, limit) => {
    if (!Number.isFinite(value) || value >= limit)
      failures.push(`${name}: ${value} (must be < ${limit})`)
  }
  const checkMemory = (name, memory) => {
    if (!memory?.stable || memory.stableWindow?.length !== 4) {
      failures.push(`${name}: memory did not settle within ten seconds`)
      return
    }
    for (const [index, sample] of memory.stableWindow.entries()) {
      below(`${name} stable memory sample ${index + 1} bytes`, sample.bytes, budgets.memoryBytes)
    }
  }
  if (samples.length < 3 || startups.length < 3)
    failures.push('At least three independent renderer and cold-start samples are required')
  for (const [index, sample] of samples.entries()) {
    const label = `renderer ${index + 1}`
    if (
      sample.initiallyVisible < 1 ||
      sample.scroll.seenMessages !== sample.messageCount ||
      sample.sessions < 1
    )
      failures.push(`${label}: missing rendered fixture coverage`)
    if (
      sample.streaming.deltas < 1_000 ||
      sample.streaming.batches.length < 100 ||
      sample.scroll.frames.length < 60 ||
      sample.switches.length < 5
    )
      failures.push(`${label}: insufficient frame or switch samples`)
    below(`${label} first paint ms`, sample.firstPaintMs, budgets.firstPaintMs)
    below(`${label} worst scroll frame ms`, Math.max(...sample.scroll.frames), budgets.frameMs)
    below(
      `${label} median scroll frame ms`,
      median(sample.scroll.frames),
      budgets.medianScrollFrameMs,
    )
    below(
      `${label} worst streaming frame ms`,
      Math.max(...sample.streaming.frames),
      budgets.frameMs,
    )
    below(
      `${label} worst stream batch ms`,
      Math.max(...sample.streaming.batches),
      budgets.streamBatchMs,
    )
    below(`${label} worst switch ms`, Math.max(...sample.switches), budgets.switchMs)
    checkMemory(label, sample.memory)
  }
  for (const [index, startup] of startups.entries()) {
    below(
      `cold start ${index + 1} interactive ms`,
      startup.interactive,
      budgets.startupInteractiveMs,
    )
    checkMemory(`cold start ${index + 1}`, startup.settled?.memory)
  }
  return failures
}
