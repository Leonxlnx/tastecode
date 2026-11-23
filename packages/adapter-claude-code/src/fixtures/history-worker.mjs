// Stands in for history-worker.js in tests: answers by the session title, so a test can
// see where the read ran, what reached the worker, and how failures come back.
import { parentPort, workerData } from 'node:worker_threads'

const { locator, session } = workerData
if (session.title === 'busy') {
  // Holds its own thread, not the test's.
  const until = Date.now() + 300
  while (Date.now() < until);
  parentPort.postMessage({
    events: [{ type: 'thread.started', thread: { id: session.id, title: locator } }],
  })
} else if (session.title === 'failing') {
  parentPort.postMessage({ error: 'Transcript could not be read' })
} else {
  // Never answers, like a read that is still running.
  setInterval(() => undefined, 1000)
}
