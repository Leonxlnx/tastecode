/**
 * One command to run the whole thing: core server, Vite, and Electron.
 *
 * Node rather than a shell script on purpose — we are a Windows + macOS team
 * and a .sh here would break one of us. See rules/code.md.
 */
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import path from 'node:path'
import net from 'node:net'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const VITE_URL = 'http://127.0.0.1:5183'
const isWin = process.platform === 'win32'
const mobile = process.argv.includes('--mobile')
const children = []
const execFileAsync = promisify(execFile)
const launcherId = createHash('sha256').update(root).digest('hex')
const launcherControlPort = 20_000 + (Number.parseInt(launcherId.slice(0, 4), 16) % 20_000)
let shuttingDown = false
let launcherControlServer

function run(name, packageDir, args, env = {}) {
  // npm/pnpm shims are .cmd files on Windows, which must go through cmd.exe.
  const child = isWin
    ? spawn('cmd.exe', ['/d', '/s', '/c', 'pnpm', ...args], {
        cwd: path.join(root, packageDir),
        env: { ...process.env, ...env },
        stdio: 'pipe',
      })
    : spawn('pnpm', args, {
        cwd: path.join(root, packageDir),
        env: { ...process.env, ...env },
        stdio: 'pipe',
      })

  const prefix = `[${name}]`
  child.stdout.on('data', (d) => process.stdout.write(prefixLines(prefix, d.toString())))
  child.stderr.on('data', (d) => process.stderr.write(prefixLines(prefix, d.toString())))
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    const reason = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`
    console.error(`${prefix} exited with ${reason}`)
    shutdown(code ?? 1)
  })
  children.push(child)
  return child
}

function prefixLines(prefix, text) {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => `${prefix} ${line}\n`)
    .join('')
}

function waitForPort(port, host = '127.0.0.1', timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, host)
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() > deadline) reject(new Error(`port ${port} never opened`))
        else setTimeout(attempt, 200)
      })
    }
    attempt()
  })
}

function portIsOpen(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect(port, host)
    let settled = false
    const finish = (open) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(open)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(1_000, () => finish(false))
  })
}

async function requireFreePorts(host) {
  const ports = [4311, 5183]
  const states = await Promise.all(ports.map((port) => portIsOpen(port, host)))
  const occupied = ports.filter((_, index) => states[index])
  if (occupied.length === 0) return

  console.error(
    `[dev] port${occupied.length === 1 ? '' : 's'} ${occupied.join(', ')} already in use. ` +
      'Another application owns the port, so Personal Harness will not stop it.',
  )
  process.exit(1)
}

function requestLauncherShutdown() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(launcherControlPort, '127.0.0.1')
    let response = ''
    let settled = false
    const timeout = setTimeout(() => finish(new Error('shutdown request timed out')), 3_000)

    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }

    socket.setEncoding('utf8')
    socket.once('connect', () => socket.end(`stop:${launcherId}\n`))
    socket.on('data', (chunk) => {
      response += chunk
    })
    socket.once('end', () => {
      if (response.trim() === `stopping:${launcherId}`) finish()
      else finish(new Error('shutdown request was rejected'))
    })
    socket.once('error', finish)
  })
}

function createLauncherControlServer() {
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')
    let command = ''
    socket.on('data', (chunk) => {
      command += chunk
      if (command.length > 1_000) socket.destroy()
    })
    socket.on('end', () => {
      if (command.trim() !== `stop:${launcherId}`) {
        socket.end('denied')
        return
      }
      socket.end(`stopping:${launcherId}`, () => void shutdown(0))
    })
  })
  return server
}

async function claimLauncher() {
  while (true) {
    const server = createLauncherControlServer()
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(launcherControlPort, '127.0.0.1', resolve)
      })
      launcherControlServer = server
      return
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error
    }

    try {
      await requestLauncherShutdown()
    } catch (error) {
      throw new Error(`launcher control port is owned by another application: ${error.message}`)
    }
    console.log('[dev] stopping previous Personal Harness dev process')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function tailscaleIPv4() {
  const candidates = ['tailscale']
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale')
  }
  if (process.platform === 'win32' && process.env['ProgramFiles']) {
    candidates.push(path.join(process.env['ProgramFiles'], 'Tailscale', 'tailscale.exe'))
  }

  for (const command of candidates) {
    try {
      const { stdout } = await execFileAsync(command, ['ip', '-4'])
      const address = stdout.trim().split(/\s+/)[0]
      if (address && net.isIPv4(address)) return address
    } catch {
      // Try the next normal installation location.
    }
  }

  throw new Error(
    'Tailscale is not running, or its CLI could not be found. Open Tailscale and try again.',
  )
}

function stopChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()

  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    child.once('exit', finish)

    if (isWin) {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.once('error', finish)
      killer.once('exit', finish)
    } else {
      child.kill()
    }
    setTimeout(finish, 5_000).unref()
  })
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  launcherControlServer?.close()
  await Promise.all(children.map(stopChild))
  process.exit(exitCode)
}
process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))

await claimLauncher()

if (mobile) {
  const host = await tailscaleIPv4()
  await requireFreePorts(host)
  const accessToken = randomBytes(24).toString('base64url')
  const serverUrl = `ws://${host}:4311`
  const webUrl = `http://${host}:5183/#access_token=${accessToken}`

  run('server', 'apps/server', ['run', 'dev'], {
    HARNESS_HOST: host,
    HARNESS_ACCESS_TOKEN: accessToken,
  })
  run('web', 'apps/web', ['run', 'dev', '--host', host], {
    VITE_HARNESS_SERVER_URL: serverUrl,
  })

  await Promise.all([waitForPort(4311, host), waitForPort(5183, host)])
  console.log(`\nOpen on your Tailscale-connected phone:\n${webUrl}\n`)
} else {
  await requireFreePorts('127.0.0.1')
  const accessToken = randomBytes(24).toString('base64url')
  const desktopUrl = `${VITE_URL}/#access_token=${accessToken}`
  run('server', 'apps/server', ['run', 'dev'], { HARNESS_ACCESS_TOKEN: accessToken })
  run('web', 'apps/web', ['run', 'dev'])

  // Electron must not load before Vite is serving, or it shows a blank window
  // and the user thinks the app is broken.
  await waitForPort(5183)
  run('desktop', 'apps/desktop', ['run', 'start'], { HARNESS_DEV_SERVER: desktopUrl })
}
