import { expect, it } from 'vitest'
import { inspectHighlightingTrace } from '../scripts/performance/highlighting-trace.js'

const trace = () => ({
  traceEvents: [
    { name: 'thread_name', pid: 1, tid: 2, args: { name: 'CrRendererMain' } },
    { name: 'thread_name', pid: 1, tid: 3, args: { name: 'DedicatedWorker thread' } },
    ...[
      'highlight-cold-start',
      'highlight-cold-end',
      'highlight-remount-start',
      'highlight-remount-end',
    ].map((name, index) => ({ name, ts: 1000 + index * 1000 })),
    { name: 'ThreadControllerImpl::RunTask', pid: 1, tid: 2, ph: 'X', ts: 900, dur: 32_000 },
    { name: 'ThreadControllerImpl::RunTask', pid: 1, tid: 3, ph: 'X', ts: 900, dur: 80_000 },
    { name: 'ThreadControllerImpl::RunTask', pid: 1, tid: 2, ph: 'X', ts: 4000, dur: 80_000 },
  ],
})

it('counts the complete overlapping main task and excludes worker/after-window work', () => {
  expect(inspectHighlightingTrace(trace())).toEqual({
    maxMainTaskMs: 32,
    mainTaskCount: 1,
    workerThreads: 1,
  })
})

it('rejects missing marks and worker evidence instead of treating them as zero cost', () => {
  const missingMark = trace()
  missingMark.traceEvents = missingMark.traceEvents.filter(
    (event) => event.name !== 'highlight-remount-end',
  )
  expect(() => inspectHighlightingTrace(missingMark)).toThrow('trace mark')
  const missingWorker = trace()
  missingWorker.traceEvents = missingWorker.traceEvents.filter(
    (event) => event.args?.name !== 'DedicatedWorker thread',
  )
  expect(() => inspectHighlightingTrace(missingWorker)).toThrow('native worker')
})
