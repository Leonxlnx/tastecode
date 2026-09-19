import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Linux deb installs are package-manager owned: `apt`/`dpkg -i` replaces
 * /opt/Taste Code atomically under a running process. The old code keeps
 * running from deleted inodes, but anything that reads the install fresh —
 * a renderer reload over resources/web, a re-forked utility server — picks
 * up the new files silently. The check below compares the install the
 * process started from with what is on disk now so the shell can say so
 * instead of mixing versions quietly.
 */

export type InstallSignature =
  | { readonly kind: 'provenance'; readonly version: string; readonly commit: string | undefined }
  | { readonly kind: 'files'; readonly dev: number; readonly ino: number; readonly size: number }

export type InstallIo = {
  /** Returns parsed JSON for a file, or undefined when absent/invalid. */
  readJson(filePath: string): unknown
  /** Returns dev/ino/size for a file, or undefined when absent. */
  stat(filePath: string): { dev: number; ino: number; size: number } | undefined
}

export type InstallDrift = {
  changed: boolean
  detail: string | undefined
}

/**
 * Build identity from resources/BUILD_PROVENANCE.json (written at packaging
 * time, so it changes exactly when the installed payload does); fall back to
 * the app.asar inode identity for layouts without provenance.
 */
export function readInstallSignature(
  resourcesPath: string,
  io: InstallIo,
): InstallSignature | undefined {
  const provenance = io.readJson(path.join(resourcesPath, 'BUILD_PROVENANCE.json'))
  if (typeof provenance === 'object' && provenance !== null) {
    const record = provenance as Record<string, unknown>
    if (typeof record['version'] === 'string' && record['version'].length > 0) {
      return {
        kind: 'provenance',
        version: record['version'],
        commit: typeof record['commit'] === 'string' ? record['commit'] : undefined,
      }
    }
  }
  const stat = io.stat(path.join(resourcesPath, 'app.asar'))
  return stat ? { kind: 'files', dev: stat.dev, ino: stat.ino, size: stat.size } : undefined
}

export function installDrifted(
  before: InstallSignature | undefined,
  after: InstallSignature | undefined,
): InstallDrift {
  if (before === undefined && after === undefined) return { changed: false, detail: undefined }
  if (before === undefined || after === undefined) {
    return { changed: true, detail: 'the installed files went missing or became unreadable' }
  }
  if (before.kind !== after.kind) {
    return { changed: true, detail: 'the installation layout changed on disk' }
  }
  if (before.kind === 'provenance' && after.kind === 'provenance') {
    if (before.version === after.version && before.commit === after.commit) {
      return { changed: false, detail: undefined }
    }
    const describe = (signature: { version: string; commit: string | undefined }) =>
      signature.commit
        ? `${signature.version} (${signature.commit.slice(0, 8)})`
        : signature.version
    return {
      changed: true,
      detail: `on-disk version changed: ${describe(before)} → ${describe(after)}`,
    }
  }
  if (before.kind === 'files' && after.kind === 'files') {
    if (before.dev === after.dev && before.ino === after.ino && before.size === after.size) {
      return { changed: false, detail: undefined }
    }
    return { changed: true, detail: 'the installed files were replaced on disk' }
  }
  return { changed: true, detail: 'the installation changed on disk' }
}

/** Node fs implementation of both io surfaces used in the Electron main process. */
export const nodeInstallIo: InstallIo & {
  readText(filePath: string): string | undefined
  writeText(filePath: string, contents: string): void
} = {
  readJson: (filePath) => {
    try {
      return JSON.parse(readFileSync(filePath, 'utf8'))
    } catch {
      return undefined
    }
  },
  stat: (filePath) => {
    try {
      const info = statSync(filePath)
      return { dev: info.dev, ino: info.ino, size: info.size }
    } catch {
      return undefined
    }
  },
  readText: (filePath) => {
    try {
      return readFileSync(filePath, 'utf8')
    } catch {
      return undefined
    }
  },
  writeText: (filePath, contents) => {
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600 })
  },
}

export const LAST_RUN_VERSION_FILE = 'last-run-version'

/**
 * Reads and rewrites the userData marker holding the version this install
 * last ran as. Returns the previously recorded version so the caller can
 * report an upgrade the next launch; the current version is always stored.
 */
export function recordRunVersion(
  dataDirectory: string,
  version: string,
  io: {
    readText(filePath: string): string | undefined
    writeText(filePath: string, contents: string): void
  },
) {
  const markerPath = path.join(dataDirectory, LAST_RUN_VERSION_FILE)
  const previous = io.readText(markerPath)?.trim() || undefined
  io.writeText(markerPath, `${version}\n`)
  return { previous }
}

/** Neutral wording: apt can install older versions too, so never claim "upgrade". */
export function describeVersionChange(
  previous: string | undefined,
  current: string,
): string | undefined {
  if (previous === undefined || previous === current) return undefined
  return `version changed since last run: ${previous} → ${current}`
}
