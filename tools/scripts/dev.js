/** Run the core server, Vite, and Electron together. */
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import path from 'node:path'
import net from 'node:net'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const VITE_URL = 'http://127.0.0.1:5183'
const DEV_PORTS = new Set([4311, 5183])
const isWin = process.platform === 'win32'
const children = []
const execFileAsync = promisify(execFile)
let shuttingDown = false

function run(name, packageDir, args, env = {}) {
  // npm/pnpm shims are .cmd files on Windows, which must go through cmd.exe.
  const child = isWin
    ? spawn('cmd.exe', ['/d', '/s', '/c', 'pnpm', ...args], {
        cwd: path.join(root, packageDir),
        env: { ...process.env, ...env },
        stdio: 'inherit',
      })
    : spawn('pnpm', args, {
        cwd: path.join(root, packageDir),
        env: { ...process.env, ...env },
        stdio: 'inherit',
        detached: true,
      })

  child.once('error', (error) => {
    if (shuttingDown) return
    console.error(`[${name}] ${error.message}`)
    void shutdown(1)
  })
  child.once('exit', (code, signal) => {
    if (shuttingDown) return
    const reason = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`
    console.error(`[${name}] exited with ${reason}`)
    void shutdown(code ?? 1)
  })
  children.push(child)
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

async function devPortListeners() {
  const listeners = new Map()
  const add = (port, pid) => {
    if (!DEV_PORTS.has(port) || !Number.isInteger(pid) || pid <= 0) return
    const pids = listeners.get(port) ?? new Set()
    pids.add(pid)
    listeners.set(port, pids)
  }

  if (isWin) {
    const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp'])
    for (const line of stdout.split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/)
      if (fields.length < 5 || fields[0].toUpperCase() !== 'TCP') continue
      if (fields[3].toUpperCase() !== 'LISTENING') continue
      const port = Number.parseInt(fields[1].match(/:(\d+)$/)?.[1] ?? '', 10)
      add(port, Number.parseInt(fields[4], 10))
    }
    return listeners
  }

  if (process.platform === 'linux') {
    try {
      const { stdout } = await execFileAsync('ss', ['-H', '-ltnp'])
      for (const line of stdout.split(/\r?\n/)) {
        const fields = line.trim().split(/\s+/)
        if (fields.length < 5 || fields[0].toUpperCase() !== 'LISTEN') continue
        const port = Number.parseInt(fields[3].match(/:(\d+)$/)?.[1] ?? '', 10)
        for (const match of line.matchAll(/pid=(\d+)/g)) {
          add(port, Number.parseInt(match[1], 10))
        }
      }
      return listeners
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  let stdout
  try {
    ;({ stdout } = await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']))
  } catch (error) {
    if (error?.code === 1) return listeners
    throw error
  }
  let pid
  for (const field of stdout.split(/\r?\n/)) {
    if (field.startsWith('p')) pid = Number.parseInt(field.slice(1), 10)
    if (!field.startsWith('n')) continue
    const port = Number.parseInt(field.match(/:(\d+)$/)?.[1] ?? '', 10)
    add(port, pid)
  }
  return listeners
}

async function processSnapshot() {
  if (isWin) {
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | ' +
            'Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress',
        ],
        { windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      )
      return [JSON.parse(stdout)].flat().map((process) => ({
        pid: Number(process.ProcessId),
        ppid: Number(process.ParentProcessId),
        command: process.CommandLine ?? '',
      }))
    } catch {
      return []
    }
  }

  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,command='])
  return stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match) => match !== null)
    .map((match) => ({
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      command: match[3],
    }))
}

function previousRunTarget(listenerPid, byPid) {
  let candidate = byPid.get(listenerPid)
  let target = listenerPid
  while (candidate) {
    if (/tools[\\/]scripts[\\/]dev\.js/.test(candidate.command)) return candidate.pid
    if (/tsx\S*\s+watch\b|vite\S*(?:\s|$)/i.test(candidate.command)) target = candidate.pid
    candidate = byPid.get(candidate.ppid)
  }
  return target
}

async function stopProcessTree(pid) {
  if (isWin) {
    await execFileAsync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
    }).catch(() => undefined)
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

async function waitForDevPortsToClose(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let listeners = await devPortListeners()
  while (listeners.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    listeners = await devPortListeners()
  }
  return listeners
}

async function clearDevPorts() {
  const listeners = await devPortListeners()
  if (listeners.size === 0) return

  const byPid = new Map((await processSnapshot()).map((process) => [process.pid, process]))
  const targets = new Set(
    [...listeners.values()].flatMap((pids) =>
      [...pids].map((pid) => previousRunTarget(pid, byPid)),
    ),
  )
  console.log(`[dev] stopping previous run on ports ${[...listeners.keys()].join(', ')}`)
  await Promise.all([...targets].map(stopProcessTree))

  let remaining = await waitForDevPortsToClose(3_000)
  if (remaining.size > 0) {
    const pids = new Set([...remaining.values()].flatMap((listeners) => [...listeners]))
    await Promise.all([...pids].map((pid) => stopProcessGroup(pid, 'SIGKILL')))
    remaining = await waitForDevPortsToClose(2_000)
  }
  if (remaining.size > 0) {
    throw new Error(`dev ports did not close: ${[...remaining.keys()].join(', ')}`)
  }
}

function processGroupExists(groupId) {
  try {
    process.kill(-groupId, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    throw error
  }
}

async function processGroupId(pid) {
  const { stdout } = await execFileAsync('ps', ['-o', 'pgid=', '-p', String(pid)])
  const groupId = Number.parseInt(stdout.trim(), 10)
  return Number.isInteger(groupId) && groupId > 0 ? groupId : undefined
}

async function stopProcessGroup(pid, signal) {
  if (isWin) {
    await stopProcessTree(pid)
    return
  }
  const groupId = await processGroupId(pid).catch(() => undefined)
  try {
    process.kill(groupId ? -groupId : pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

async function waitForProcessGroupToExit(groupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (processGroupExists(groupId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !processGroupExists(groupId)
}

async function stopChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  if (isWin) {
    await stopProcessTree(child.pid)
    return
  }
  await stopProcessGroup(child.pid, 'SIGTERM')
  if (await waitForProcessGroupToExit(child.pid, 3_000)) return
  await stopProcessGroup(child.pid, 'SIGKILL')
  await waitForProcessGroupToExit(child.pid, 2_000)
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  await Promise.all(children.map(stopChild))
  process.exit(exitCode)
}

process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))

await clearDevPorts()

run('server', 'apps/server', ['run', 'dev'])
run('web', 'apps/web', ['run', 'dev'])
await waitForPort(5183)
run('desktop', 'apps/desktop', ['run', 'start'], { HARNESS_DEV_SERVER: VITE_URL })
