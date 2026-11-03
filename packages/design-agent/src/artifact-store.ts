import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readWorkspaceFile } from './workspace-files.js'

const MAX_ARTIFACT_BYTES = 2_000_000
type ArtifactName = 'brief.json' | 'brand.json' | 'page.json' | 'assets.json' | 'review.json'

function artifactPath(workspacePath: string, name: ArtifactName, create: boolean): string {
  const root = realpathSync(workspacePath)
  const directory = path.join(root, '.taste')
  if (create) mkdirSync(directory, { recursive: true })
  if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) {
    throw new Error('Design artifact directory must be a real directory inside the workspace')
  }
  return path.join(directory, name)
}

export function readDesignArtifact(workspacePath: string, name: ArtifactName): unknown {
  return JSON.parse(
    readWorkspaceFile(artifactPath(workspacePath, name, false), MAX_ARTIFACT_BYTES).toString(
      'utf8',
    ),
  )
}

/** The app-screen kit TasteCode copies next to the run's artifacts; see app-screens.ts. */
export const DESIGN_KIT_DIRECTORY = 'app-kit'

function kitPath(workspacePath: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/iu.test(name)) throw new Error(`Invalid Design kit file ${name}`)
  const root = realpathSync(workspacePath)
  let directory = root
  for (const segment of ['.taste', DESIGN_KIT_DIRECTORY]) {
    directory = path.join(directory, segment)
    mkdirSync(directory, { recursive: true })
    if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) {
      throw new Error('Design kit directory must be a real directory inside the workspace')
    }
  }
  return path.join(directory, name)
}

/** Writes one kit file under `.taste/app-kit/`, replacing it atomically like an artifact. */
export function writeDesignKitFile(workspacePath: string, name: string, content: string): void {
  const target = kitPath(workspacePath, name)
  const temporary = path.join(path.dirname(target), `.${name}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function writeDesignArtifact(
  workspacePath: string,
  name: ArtifactName,
  value: unknown,
): void {
  const content = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(content) > MAX_ARTIFACT_BYTES)
    throw new Error('Design artifact exceeds 2 MB')
  const target = artifactPath(workspacePath, name, true)
  const temporary = path.join(path.dirname(target), `.${name}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    // Atomic replacement also avoids writing through a model-created file symlink or hard link.
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
}
