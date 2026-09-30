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
}, 90_000)

app
  .whenReady()
  .then(async () => {
    window = new BrowserWindow({
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
    window.webContents.on('render-process-gone', (_event, details) => {
      console.error('Renderer exited:', details.reason)
      app.exit(1)
    })
    const errors = []
    window.webContents.on('console-message', (details) => {
      if (details.level === 'error') errors.push(details.message)
      if (details.message.startsWith('[performance]')) console.log(details.message)
    })
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
    // Keep highlighting's warmed module/worker caches out of the existing thread gate.
    await window.loadFile(process.env.HARNESS_PERF_RENDERER)
    console.log('[performance] thread page reload complete')
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
    await writeFile(process.env.HARNESS_PERF_RESULT, JSON.stringify(sample, null, 2))
    await writeFile(
      path.join(path.dirname(process.env.HARNESS_PERF_RESULT), 'thread.png'),
      (await window.webContents.capturePage()).toPNG(),
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
