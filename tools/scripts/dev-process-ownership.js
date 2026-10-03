import path from 'node:path'

export function sameProcess(left, right) {
  return Boolean(
    left &&
    right &&
    left.pid === right.pid &&
    left.started &&
    left.started === right.started &&
    left.command === right.command,
  )
}

export function previousRunTarget(listenerPid, byPid, root, owner, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path
  const normalize = (value) => {
    const normalized = paths.normalize(value)
    return platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  const entry = normalize(paths.join(root, 'tools', 'scripts', 'dev.js'))
  const visited = new Set()
  let candidate = byPid.get(listenerPid)
  while (candidate && !visited.has(candidate.pid)) {
    visited.add(candidate.pid)
    const args = (candidate.command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((arg) =>
      arg.replace(/^["']|["']$/g, ''),
    )
    const isNode = /^node(?:\.exe)?$/i.test(paths.basename(args[0] ?? ''))
    const entryArgument = args[1] ?? ''
    if (
      isNode &&
      ((paths.isAbsolute(entryArgument) && normalize(entryArgument) === entry) ||
        (owner?.root === root && sameProcess(owner, candidate)))
    )
      return candidate.pid
    candidate = byPid.get(candidate.ppid)
  }
  return undefined
}

export function devStopTargets(listeners, byPid, root, owner, platform) {
  const targets = new Set()
  for (const [port, pids] of listeners) {
    for (const pid of pids) {
      const target = previousRunTarget(pid, byPid, root, owner, platform)
      if (target === undefined) {
        throw new Error(
          `Port ${port} is owned by PID ${pid}, not a verified dev stack for ${root}. ` +
            'Stop that process yourself before retrying; no process was stopped.',
        )
      }
      targets.add(target)
    }
  }
  return targets
}

export function descendantProcesses(targets, byPid) {
  const owned = new Map()
  for (const candidate of byPid.values()) {
    const visited = new Set()
    let ancestor = candidate
    while (ancestor && !visited.has(ancestor.pid)) {
      visited.add(ancestor.pid)
      if (targets.has(ancestor.pid)) {
        owned.set(candidate.pid, candidate)
        break
      }
      ancestor = byPid.get(ancestor.ppid)
    }
  }
  return owned
}

export function verifiedRemainingPids(listeners, byPid, owned) {
  const pids = new Set([...listeners.values()].flatMap((values) => [...values]))
  for (const pid of pids) {
    if (!sameProcess(owned.get(pid), byPid.get(pid))) {
      throw new Error(
        `Dev port ownership changed to PID ${pid}; refusing to stop an unverified process.`,
      )
    }
  }
  return pids
}
