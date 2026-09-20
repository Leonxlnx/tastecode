// One-off prepublication proof. This branch never changes the release payload.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, writeFile, readdir, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'

assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Never install on a developer machine')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const root = path.join(process.env.RUNNER_TEMP, 'tastecode-upgrade-proof')
const evidence = path.resolve('release/installed-upgrade-proof')
const installation = path.join(root, 'installed')
const executable = path.join(installation, 'Taste Code.exe')
const profile = path.join(root, 'profile')
const project = path.join(root, 'project')
await Promise.all([root, evidence, profile, project].map((p) => mkdir(p, { recursive: true })))
const candidate = path.resolve(process.env.CANDIDATE_INSTALLER ?? '')
assert.equal(path.basename(candidate), 'TasteCode-0.1.1-win-x64.exe')
const candidateHash = createHash('sha256')
for await (const bytes of createReadStream(candidate)) candidateHash.update(bytes)
const versions = [
  {
    version: '0.1.0-beta.9',
    id: 575761861,
    size: 509798704,
    hash: 'b522617b6b5ef8e50968bc03b608dc74b6d198bf1df439cd68131c9eb89afd9e',
  },
  {
    version: '0.1.1',
    file: candidate,
    size: (await stat(candidate)).size,
    hash: candidateHash.digest('hex'),
  },
]
const report = {
  source: 'd2b3754cdb72090db3a80868f617d2e48dc8effc',
  checks: [],
  assets: versions,
  fixtures:
    'Only release metadata/download transport and silent NSIS wizard automation. Actual installed apps, renderer buttons, IPC, hash verification, installer and relaunch are real.',
}
function check(message) {
  report.checks.push(message)
  console.log('PASS:', message)
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180000,
    ...options,
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout
}
async function until(action, label, timeout = 60000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try {
      const result = await action()
      if (result) return result
    } catch (error) {
      last = error
    }
    await delay(500)
  }
  throw new Error(`Timed out: ${label}; ${last?.message ?? ''}`)
}
async function cdp(port, type) {
  const target = await until(
    async () =>
      (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (t) => t.type === type,
      ),
    `CDP ${type}`,
  )
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  let id = 0
  const pending = new Map()
  socket.onmessage = (event) => {
    const value = JSON.parse(event.data)
    const entry = pending.get(value.id)
    if (!entry) return
    pending.delete(value.id)
    clearTimeout(entry.timer)
    if (value.error) entry.reject(new Error(JSON.stringify(value.error)))
    else entry.resolve(value.result)
  }
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const key = ++id
      const timer = setTimeout(() => {
        pending.delete(key)
        reject(new Error(`CDP timeout: ${method}`))
      }, 20000)
      pending.set(key, { resolve, reject, timer })
      socket.send(JSON.stringify({ id: key, method, params }))
    })
  return {
    call,
    close: () => socket.close(),
    evaluate: async (expression) => {
      const result = await call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    },
  }
}
const env = {
  ...process.env,
  HARNESS_DATA_DIR: path.join(profile, 'server'),
  HARNESS_DESKTOP_DATA_DIR: path.join(profile, 'desktop'),
  HARNESS_STARTUP_STARTED_AT: String(Date.now()),
}
delete env.GH_TOKEN
let main, renderer, fixture, child
const logs = []
function launch(label) {
  child = spawn(
    executable,
    [
      '--inspect=127.0.0.1:19229',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=19228',
      '--disable-gpu',
    ],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (bytes) => logs.push(`[${label}] ${bytes}`))
  child.on('error', (error) => logs.push(error.stack))
}
const click = (text) =>
  renderer.evaluate(
    `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b || b.disabled) return false; b.click(); return true })()`,
  )
async function screenshot(name) {
  const result = await renderer.call('Page.captureScreenshot')
  await writeFile(path.join(evidence, name + '.png'), Buffer.from(result.data, 'base64'))
}
async function stopOwnedApp() {
  main?.close()
  renderer?.close()
  main = renderer = undefined
  // These processes descend from this proof's installer on a disposable runner.
  const script = `$target = '${executable.replaceAll("'", "''")}'; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $target } | ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F 2>$null | Out-Null }; exit 0`
  run('powershell.exe', ['-NoProfile', '-Command', script])
  await delay(2000)
}
try {
  for (const v of versions) {
    if (!v.file) {
      v.file = path.join(root, `TasteCode-${v.version}-win-x64.exe`)
      const response = await fetch(
        `https://api.github.com/repos/Leonxlnx/tastecode/releases/assets/${v.id}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.GH_TOKEN}`,
            Accept: 'application/octet-stream',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      )
      assert.equal(response.status, 200, response.ok ? '' : await response.text())
      await pipeline(response.body, createWriteStream(v.file))
    }
    assert.equal((await stat(v.file)).size, v.size)
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(v.file)) hash.update(bytes)
    assert.equal(hash.digest('hex'), v.hash)
    check(`Actual ${v.version} installer size and SHA-256`)
  }
  run(versions[0].file, ['/S', `/D=${installation}`])
  const seed = path.join(root, 'seed.cjs')
  await writeFile(
    seed,
    `const path = require('node:path'); const assert = require('node:assert/strict');
    (async () => {
      const { Store } = await import(require('node:url').pathToFileURL(path.join(process.resourcesPath, 'app.asar/node_modules/@harness/server/dist/store.js')));
      const store = new Store(path.join(process.env.HARNESS_DATA_DIR, 'tastecode.db'));
      if (process.argv[2] === 'seed') {
        store.addProject(${JSON.stringify(project)});
        store.addThread({ id: 'upgrade-proof-chat', projectPath: ${JSON.stringify(project)}, provider: 'codex', title: 'Upgrade proof preserved chat' });
        store.setThreadPinned('upgrade-proof-chat', true);
        store.setThreadApproval('upgrade-proof-chat', 'auto');
        store.updateSidebarSettings({ mode: 'classic', autoSettleDays: 7 });
        for (const role of ['user', 'assistant']) store.append('upgrade-proof-chat', { type: 'item.completed', item: { id: role, turnId: 'proof', type: 'message', role, status: 'completed', text: 'Preserved ' + role + ' upgrade message', createdAt: 1 } });
      }
      assert.equal(store.thread('upgrade-proof-chat').pinned, true);
      assert.equal(store.thread('upgrade-proof-chat').title, 'Upgrade proof preserved chat');
      assert.equal(store.threadApproval('upgrade-proof-chat'), 'auto');
      assert.equal(store.sidebarSettings().autoSettleDays, 7);
      store.close(); console.log('Stored chat, pin, approval and sidebar settings preserved');
    })().catch(error => { console.error(error); process.exitCode = 1 });`,
  )
  run(executable, [seed, 'seed'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' } })
  launch('beta9')
  main = await cdp(19229, 'node')
  renderer = await cdp(19228, 'page')
  await until(() => renderer.evaluate('Boolean(window.harness)'), 'native preload')
  await until(
    () => renderer.evaluate('document.body.innerText.trim().length > 30'),
    'first renderer frame before editing preferences',
    90000,
  )
  assert.equal(
    (await renderer.evaluate('window.harness.getUpdateState()')).currentVersion,
    versions[0].version,
  )
  check('Actual installed Beta 9 launches with its native preload')
  await renderer.evaluate(
    `localStorage.setItem('harness.onboarding.v1','done');localStorage.setItem('harness.theme','dark');localStorage.setItem('harness.font','serif');location.reload();true`,
  )
  await until(
    () => renderer.evaluate("document.body.innerText.includes('Upgrade proof preserved chat')"),
    'old visible chat',
  )
  const asset = {
    name: path.basename(versions[1].file),
    state: 'uploaded',
    size: versions[1].size,
    digest: `sha256:${versions[1].hash}`,
    browser_download_url: `https://github.com/Leonxlnx/tastecode/releases/download/v${versions[1].version}/${path.basename(versions[1].file)}`,
  }
  fixture = createServer((request, response) => {
    if (request.url.startsWith('/metadata')) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify([
          {
            tag_name: `v${versions[1].version}`,
            draft: false,
            published_at: new Date().toISOString(),
            assets: [asset],
          },
        ]),
      )
    } else if (request.url === '/installer') {
      response.writeHead(200, { 'Content-Length': versions[1].size })
      const stream = createReadStream(versions[1].file)
      stream.on('error', () => response.destroy())
      response.on('close', () => stream.destroy())
      stream.pipe(response)
    } else response.writeHead(404).end()
  })
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve))
  await main.evaluate(`(() => {
    const require = process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app.asar/package.json');
    const electron = require('electron'); const original = electron.net.request.bind(electron.net);
    electron.net.request = options => {
      if (options.hostname === 'api.github.com' || options.hostname === 'github.com') {
        const route = options.hostname === 'api.github.com' ? '/metadata' : '/installer';
        options = { ...options, url: 'http://127.0.0.1:${fixture.address().port}' + route };
        for (const key of ['hostname', 'host', 'protocol', 'port', 'path']) delete options[key];
      }
      return original(options);
    };
    const proto = require('electron-updater').NsisUpdater.prototype; const install = proto.quitAndInstall;
    proto.quitAndInstall = function(silent, forceRun) { return install.call(this, true, forceRun) };
    electron.BrowserWindow.getAllWindows()[0].webContents.send('harness:menuAction', 'settings');
    return true;
  })()`)
  await until(() => click('About'), 'About settings')
  await until(() => click('Check for updates'), 'actual update check button')
  await until(
    async () => {
      const state = await renderer.evaluate('window.harness.getUpdateState()')
      if (state.status === 'error') throw new Error(state.error)
      return state.status === 'ready'
    },
    'download ready',
    180000,
  )
  check('Beta 9 Settings button downloads and verifies the actual TasteCode 0.1.1 installer')
  await screenshot('beta9-update-ready')
  await until(() => click('Restart to update'), 'actual restart/update button')
  main.close()
  renderer.close()
  main = renderer = undefined
  await until(
    async () =>
      run('powershell.exe', [
        '-NoProfile',
        '-Command',
        `(Get-Item -LiteralPath '${executable}').VersionInfo.FileVersion`,
      ])
        .trim()
        .replace(/\.0$/, '') === versions[1].version,
    'installed TasteCode 0.1.1 replaces Beta 9',
    180000,
  )
  await until(
    async () =>
      run('powershell.exe', [
        '-NoProfile',
        '-Command',
        `@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${executable}' -and $_.CommandLine -notmatch '--type=' }).Count`,
      ]).trim() !== '0',
    'automatic installed relaunch',
  )
  check('Real NSIS update replaces the installed app and automatically relaunches it')
  await delay(8000)
  await stopOwnedApp()
  run(executable, [seed, 'verify'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' } })
  check('TasteCode 0.1.1 database opens with the same chat, pin, approval and sidebar settings')
  launch('release011')
  main = await cdp(19229, 'node')
  renderer = await cdp(19228, 'page')
  await until(
    () => renderer.evaluate("document.body.innerText.includes('Upgrade proof preserved chat')"),
    'upgraded visible chat',
  )
  const preserved = await renderer.evaluate(
    `(async () => ({theme:localStorage.getItem('harness.theme'),font:localStorage.getItem('harness.font'),onboarding:localStorage.getItem('harness.onboarding.v1'),state:await window.harness.getUpdateState()}))()`,
  )
  assert.equal(preserved.state.currentVersion, versions[1].version)
  assert.equal(preserved.theme, 'dark')
  assert.equal(preserved.font, 'serif')
  assert.equal(preserved.onboarding, 'done')
  await renderer.evaluate(
    `(() => { const item = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Upgrade proof preserved chat')); if (!item) throw Error('Chat button missing'); item.click(); })()`,
  )
  await until(
    () =>
      renderer.evaluate(
        "document.body.innerText.includes('Preserved assistant upgrade message') && document.body.innerText.includes('Preserved user upgrade message')",
      ),
    'both preserved messages visible',
  )
  await screenshot('release011-preserved-chat')
  check('TasteCode 0.1.1 renders both prior messages and preserves theme, font and onboarding')
  report.preserved = preserved
} catch (error) {
  report.error = error.stack
  process.exitCode = 1
  console.error(error)
  if (renderer) {
    try {
      await screenshot('failure')
      await writeFile(
        path.join(evidence, 'failure-dom.txt'),
        await renderer.evaluate('document.body.innerText'),
      )
    } catch {}
  }
} finally {
  try {
    await stopOwnedApp()
    const uninstaller = (await readdir(installation)).find((name) =>
      /^Uninstall.*\.exe$/.test(name),
    )
    assert.ok(uninstaller)
    run(path.join(installation, uninstaller), ['/S', `_?=${installation}`])
    await until(async () => !(await stat(executable).catch(() => undefined)), 'uninstall cleanup')
    check('Isolated installation uninstalled successfully')
  } catch (error) {
    report.cleanupError = error.stack
    process.exitCode = 1
  }
  fixture?.closeAllConnections()
  fixture?.close()
  await writeFile(path.join(evidence, 'app.log'), logs.join(''))
  await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n')
}
