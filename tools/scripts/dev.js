/**
 * One command to run the whole thing: core server, Vite, and Electron.
 *
 * Node rather than a shell script on purpose — we are a Windows + macOS team
 * and a .sh here would break one of us. See rules/code.md.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import net from 'node:net'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const VITE_URL = 'http://127.0.0.1:5183'
const isWin = process.platform === 'win32'
const children = []

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
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`${prefix} exited with ${code}`)
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

function waitForPort(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1')
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

function shutdown() {
  for (const child of children) child.kill()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

run('server', 'apps/server', ['run', 'dev'])
run('web', 'apps/web', ['run', 'dev'])

// Electron must not load before Vite is serving, or it shows a blank window
// and the user thinks the app is broken.
await waitForPort(5183)
run('desktop', 'apps/desktop', ['run', 'start'], { HARNESS_DEV_SERVER: VITE_URL })
