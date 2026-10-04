import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

function packagedPaths(argument) {
  const supplied = path.resolve(argument)
  if (process.platform === 'win32') {
    return {
      executable: supplied,
      resources: path.join(path.dirname(supplied), 'resources'),
    }
  }
  if (process.platform === 'darwin') {
    const app = supplied.endsWith('.app')
      ? supplied
      : path.resolve(path.dirname(supplied), '..', '..')
    const executable = supplied.endsWith('.app')
      ? singleMacExecutable(path.join(app, 'Contents', 'MacOS'))
      : supplied
    return {
      executable,
      resources: path.join(app, 'Contents', 'Resources'),
    }
  }
  throw new Error('packaged native proof is supported only on Windows and macOS')
}

function singleMacExecutable(directory) {
  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(directory, entry.name))
  if (candidates.length !== 1) {
    throw new Error(
      `expected one packaged macOS executable in ${directory}, found ${candidates.length}`,
    )
  }
  return candidates[0]
}

const arguments_ = process.argv.slice(2).filter((argument) => argument !== '--')
if (arguments_.length !== 1) {
  throw new Error('usage: pnpm --filter @harness/desktop verify:native-bindings -- <app-or-exe>')
}
const [argument] = arguments_
const { executable, resources } = packagedPaths(argument)
const archive = path.join(resources, 'app.asar')
if (!existsSync(executable)) throw new Error(`packaged executable does not exist: ${executable}`)
if (!existsSync(archive)) throw new Error(`packaged app.asar does not exist: ${archive}`)

const proof = path.join(archive, 'dist', 'native-binding-proof.js')
const result = spawnSync(executable, [proof], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
  windowsHide: true,
})
if (result.error) throw result.error
if (result.signal) throw new Error(`native binding proof ended with signal ${result.signal}`)
if (result.status !== 0) process.exitCode = result.status ?? 1
