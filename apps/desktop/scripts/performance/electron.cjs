const { app, BrowserWindow, contentTracing } = require('electron')
const { writeFile } = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

app.setPath('userData', process.env.HARNESS_PERF_DATA_DIR)
app.setPath('sessionData', process.env.HARNESS_PERF_DATA_DIR)
let window
const timeout = setTimeout(() => {
  console.error('Performance fixture timed out')
  app.exit(1)
}, 120_000)

/**
 * Mount one collapsed 300-call activity over its existing store, open one
 * output, close the activity, and read the collected heap between each step.
 */
async function measureLargeActivity(contents) {
  const debug = contents.debugger
  debug.attach('1.3')
  try {
    const heap = async () => {
      for (let pass = 0; pass < 3; pass += 1) await debug.sendCommand('HeapProfiler.collectGarbage')
      return (await debug.sendCommand('Runtime.getHeapUsage')).usedSize
    }
    const step = (name) =>
      contents.executeJavaScript(`window.runLargeActivityStep(${JSON.stringify(name)})`)
    const fixture = await step('prepare')
    const preparedHeapBytes = await heap()
    const collapsed = await step('mount')
    const collapsedHeapBytes = await heap()
    // The first open pays one-time costs (lazily loaded code, caches) that
    // stay after closing without being a leak, so retention is measured
    // across a second cycle.
    await step('openOne')
    await step('close')
    const warmedHeapBytes = await heap()
    const opened = await step('openOne')
    const closed = await step('close')
    const closedHeapBytes = await heap()
    await step('unmount')
    return {
      ...fixture,
      collapsed,
      opened,
      closed,
      preparedHeapBytes,
      collapsedHeapBytes,
      warmedHeapBytes,
      closedHeapBytes,
      mountedHeapBytes: collapsedHeapBytes - preparedHeapBytes,
      retainedAfterCloseBytes: closedHeapBytes - warmedHeapBytes,
    }
  } finally {
    debug.detach()
  }
}

app
  .whenReady()
  .then(async () => {
    const errors = []
    const createWindow = () => {
      const created = new BrowserWindow({
        width: 1180,
        height: 820,
        show: true,
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      })
      created.webContents.on('render-process-gone', (_event, details) => {
        console.error('Renderer exited:', details.reason)
        app.exit(1)
      })
      created.webContents.on('console-message', (details) => {
        if (details.level === 'error') errors.push(details.message)
        if (details.message.startsWith('[performance]')) console.log(details.message)
      })
      return created
    }
    window = createWindow()
    await window.loadFile(process.env.HARNESS_PERF_RENDERER)
    await contentTracing.startRecording({
      included_categories: ['devtools.timeline', 'blink.user_timing', 'toplevel', 'v8.execute'],
    })
    let highlighting
    try {
      highlighting = await window.webContents.executeJavaScript('window.runHighlightingFixture()')
    } finally {
      await contentTracing.stopRecording(
        `${process.env.HARNESS_PERF_RESULT}.highlighting-trace.json`,
      )
    }
    console.log('[performance] highlighting and trace complete')
    // A fresh window keeps module/worker caches out of the thread gate and avoids
    // intermittent missing animation frames after reloading the traced renderer.
    const highlightedWindow = window
    window = createWindow()
    highlightedWindow.destroy()
    await window.loadFile(process.env.HARNESS_PERF_RENDERER)
    console.log('[performance] fresh thread page loaded')
    const sample = await window.webContents.executeJavaScript('window.runPerformanceFixture()')
    console.log('[performance] thread fixture complete')
    sample.highlighting = highlighting
    if (errors.length > 0) throw new Error(errors.join('\n'))
    const metrics = app.getAppMetrics()
    const { collectSettledBenchmarkMemory } = await import(
      pathToFileURL(process.env.HARNESS_PERF_MEMORY_MODULE).href
    )
    sample.memory = await collectSettledBenchmarkMemory(() => app.getAppMetrics())
    console.log('[performance] settled memory captured')
    sample.memoryBytes = sample.memory.bytes
    sample.rssBytes = sample.memory.rssBytes
    sample.processes = metrics.length
    const threadImage = (await window.webContents.capturePage()).toPNG()
    // Another fresh window keeps the thread gate's caches out of the heap deltas.
    const threadWindow = window
    window = createWindow()
    threadWindow.destroy()
    await window.loadFile(process.env.HARNESS_PERF_RENDERER)
    sample.largeActivity = await measureLargeActivity(window.webContents)
    console.log('[performance] large activity heap captured')
    if (errors.length > 0) throw new Error(errors.join('\n'))
    await writeFile(process.env.HARNESS_PERF_RESULT, JSON.stringify(sample, null, 2))
    await writeFile(
      path.join(path.dirname(process.env.HARNESS_PERF_RESULT), 'thread.png'),
      threadImage,
    )
    clearTimeout(timeout)
    window.destroy()
    app.quit()
  })
  .catch((error) => {
    console.error(error)
    clearTimeout(timeout)
    if (window && !window.isDestroyed()) window.destroy()
    app.exit(1)
  })
