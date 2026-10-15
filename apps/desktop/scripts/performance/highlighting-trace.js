/** Long-task observers start at 50 ms. Inspect the saved renderer trace for the 32 ms gate. */
export function inspectHighlightingTrace(trace) {
  const events = trace.traceEvents
  if (!Array.isArray(events)) throw new Error('Missing highlighting trace events')
  const main = events.find(
    (event) => event.name === 'thread_name' && event.args?.name === 'CrRendererMain',
  )
  if (!main) throw new Error('Missing renderer main thread in highlighting trace')
  const marks = [
    'highlight-cold-start',
    'highlight-cold-end',
    'highlight-remount-start',
    'highlight-remount-end',
  ].map((name) => {
    const matches = events.filter((event) => event.name === name)
    if (matches.length !== 1 || !Number.isFinite(matches[0].ts))
      throw new Error(`Missing or ambiguous highlighting trace mark: ${name}`)
    return matches[0].ts
  })
  if (marks.some((mark, index) => index > 0 && mark <= marks[index - 1]))
    throw new Error('Highlighting trace marks are out of order')
  const tasks = events.filter(
    (event) =>
      event.pid === main.pid &&
      event.tid === main.tid &&
      event.ph === 'X' &&
      event.name === 'ThreadControllerImpl::RunTask' &&
      event.ts < marks[3] &&
      event.ts + event.dur > marks[0],
  )
  if (!tasks.length || tasks.some((event) => !Number.isFinite(event.dur) || event.dur < 0))
    throw new Error('Missing valid main-thread tasks in highlighting trace')
  const workerThreads = events.filter(
    (event) => event.name === 'thread_name' && event.args?.name === 'DedicatedWorker thread',
  ).length
  if (!workerThreads) throw new Error('Missing native worker in highlighting trace')
  return {
    mainTaskCount: tasks.length,
    maxMainTaskMs: Math.max(...tasks.map((event) => event.dur)) / 1000,
    workerThreads,
  }
}
