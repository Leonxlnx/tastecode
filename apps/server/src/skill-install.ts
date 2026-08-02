import { constants } from 'node:fs'
import { access, cp, lstat, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises'
import path from 'node:path'

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  )
}

async function exists(candidate: string): Promise<boolean> {
  return lstat(candidate).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    },
  )
}

async function validateTree(
  root: string,
  current: string,
  ancestors = new Set<string>(),
): Promise<void> {
  const canonical = await realpath(current)
  if (!inside(root, canonical)) {
    throw new Error(`skill folder contains a symlink outside the selected folder: ${current}`)
  }

  const info = await stat(current)
  if (!info.isDirectory()) return
  if (ancestors.has(canonical)) throw new Error('skill folder contains a symbolic-link cycle')

  const nextAncestors = new Set(ancestors).add(canonical)
  for (const entry of await readdir(current)) {
    await validateTree(root, path.join(current, entry), nextAncestors)
  }
}

async function managedRoot(projectPath: string): Promise<string> {
  const project = await realpath(projectPath)
  if (!(await stat(project)).isDirectory()) throw new Error('project path is not a folder')

  const agents = path.join(project, '.agents')
  const managed = path.join(agents, 'skills')
  for (const candidate of [agents, managed]) {
    if ((await exists(candidate)) && !inside(project, await realpath(candidate))) {
      throw new Error('project skill location points outside the project')
    }
  }

  await mkdir(managed, { recursive: true })
  const canonical = await realpath(managed)
  if (!inside(project, canonical))
    throw new Error('project skill location points outside the project')
  return canonical
}

export async function installLocalSkill(projectPath: string, folderPath: string): Promise<string> {
  const source = await realpath(folderPath)
  if (!(await stat(source)).isDirectory()) throw new Error('selected skill path is not a folder')

  const skillFile = path.join(source, 'SKILL.md')
  await access(skillFile, constants.R_OK).catch(() => {
    throw new Error('selected folder must contain a readable SKILL.md')
  })
  if (!(await stat(skillFile)).isFile()) {
    throw new Error('selected folder must contain a readable SKILL.md')
  }
  await validateTree(source, source)

  const name = path.basename(source)
  if (!name || name === '.' || name === '..' || WINDOWS_RESERVED.test(name) || /[. ]$/.test(name)) {
    throw new Error(`skill folder name is not portable: ${name || '(empty)'}`)
  }

  const root = await managedRoot(projectPath)
  if (inside(source, root))
    throw new Error('selected skill folder cannot contain the managed skill location')

  const destination = path.join(root, name)
  try {
    await mkdir(destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`project skill "${name}" already exists`)
    }
    throw error
  }

  try {
    for (const entry of await readdir(source)) {
      await cp(path.join(source, entry), path.join(destination, entry), {
        recursive: true,
        dereference: true,
        errorOnExist: true,
        force: false,
      })
    }
    return destination
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  }
}
